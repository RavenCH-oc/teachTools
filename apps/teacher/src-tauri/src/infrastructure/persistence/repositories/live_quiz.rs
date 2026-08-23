use super::now_utc;
use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct SessionQuestionRecord {
    pub id: String,
    pub session_id: String,
    pub source_question_id: Option<String>,
    pub question_type: String,
    pub prompt: String,
    pub points: i64,
    pub position: i64,
    pub answer_config: Value,
    pub grading_config: Value,
    pub metadata: Value,
    pub config_version: i64,
    pub state: String,
    pub created_at: String,
    pub opened_at: Option<String>,
    pub locked_at: Option<String>,
    pub revealed_at: Option<String>,
}
#[derive(Debug, Clone)]
pub struct SessionQuestionAssetRecord {
    pub id: String,
    pub session_question_id: String,
    pub source_asset_id: Option<String>,
    pub asset_type: String,
    pub storage_path: String,
    pub display_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub position: i64,
    pub page_reference: Option<i64>,
}
#[derive(Debug, Clone)]
pub struct SubmissionRecord {
    pub id: String,
    pub session_question_id: String,
    pub participant_id: String,
    pub revision: i64,
    pub answer_json: Value,
    pub grading_status: String,
    pub is_correct: Option<bool>,
    pub score: Option<i64>,
    pub max_score: i64,
    pub submitted_at: String,
}
pub struct NewSessionQuestion {
    pub id: String,
    pub session_id: String,
    pub source_question_id: String,
    pub question_type: String,
    pub prompt: String,
    pub points: i64,
    pub answer_config: Value,
    pub grading_config: Value,
    pub metadata: Value,
    pub config_version: i64,
    pub assets: Vec<NewSessionQuestionAsset>,
}
pub struct NewSessionQuestionAsset {
    pub id: String,
    pub source_asset_id: String,
    pub asset_type: String,
    pub storage_path: String,
    pub display_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub position: i64,
    pub page_reference: Option<i64>,
}
pub struct NewSubmission {
    pub id: String,
    pub session_question_id: String,
    pub participant_id: String,
    pub answer_json: Value,
    pub grading_status: String,
    pub is_correct: Option<bool>,
    pub score: Option<i64>,
    pub max_score: i64,
}
pub struct LiveQuizRepository;
impl LiveQuizRepository {
    pub fn create_snapshot(
        database: &Database,
        input: NewSessionQuestion,
    ) -> Result<SessionQuestionRecord, AppError> {
        let mut c = database.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let active = tx
            .query_row(
                "SELECT 1 FROM local_sessions WHERE id=?1 AND state='ACTIVE'",
                [&input.session_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !active {
            return Err(AppError::SessionNotOpen);
        }
        let pos: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position)+1,0) FROM session_questions WHERE session_id=?1",
            [&input.session_id],
            |r| r.get(0),
        )?;
        let now = now_utc();
        tx.execute("INSERT INTO session_questions(id,session_id,source_question_id,question_type,prompt,points,position,answer_config,grading_config,metadata,config_version,state,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'HIDDEN',?12,?12)",params![input.id,input.session_id,input.source_question_id,input.question_type,input.prompt,input.points,pos,json_text(&input.answer_config)?,json_text(&input.grading_config)?,json_text(&input.metadata)?,input.config_version,now])?;
        for a in input.assets {
            tx.execute("INSERT INTO session_question_assets(id,session_question_id,source_asset_id,asset_type,storage_path,display_name,mime_type,size_bytes,sha256,position,page_reference,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",params![a.id,input.id,a.source_asset_id,a.asset_type,a.storage_path,a.display_name,a.mime_type,a.size_bytes,a.sha256,a.position,a.page_reference,now])?;
        }
        tx.commit()?;
        Self::get_question(database, &input.id)?.ok_or(AppError::Storage)
    }
    pub fn get_question(d: &Database, id: &str) -> Result<Option<SessionQuestionRecord>, AppError> {
        let c = d.connection()?;
        c.query_row(&question_select("WHERE id=?1"), [id], question_row)
            .optional()
            .map_err(Into::into)
    }
    pub fn list_questions(d: &Database, sid: &str) -> Result<Vec<SessionQuestionRecord>, AppError> {
        let c = d.connection()?;
        let mut s = c.prepare(&question_select("WHERE session_id=?1 ORDER BY position,id"))?;
        let rows = s
            .query_map([sid], question_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into);
        rows
    }
    pub fn current_visible(
        d: &Database,
        sid: &str,
    ) -> Result<Option<SessionQuestionRecord>, AppError> {
        let c = d.connection()?;
        c.query_row(&question_select("WHERE session_id=?1 AND state IN ('OPEN','LOCKED','REVEALED') ORDER BY position DESC LIMIT 1"),[sid],question_row).optional().map_err(Into::into)
    }
    pub fn transition(
        d: &Database,
        id: &str,
        target: &str,
    ) -> Result<SessionQuestionRecord, AppError> {
        let mut c = d.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = tx
            .query_row(&question_select("WHERE id=?1"), [id], question_row)
            .optional()?
            .ok_or(AppError::NotFound("session question".to_owned()))?;
        if !matches!(
            (current.state.as_str(), target),
            ("HIDDEN", "OPEN") | ("OPEN", "LOCKED") | ("LOCKED", "OPEN") | ("LOCKED", "REVEALED")
        ) {
            return Err(AppError::Conflict(
                "question state transition is not allowed".to_owned(),
            ));
        }
        let now = now_utc();
        tx.execute("UPDATE session_questions SET state=?1,opened_at=CASE WHEN ?1='OPEN' THEN ?2 ELSE opened_at END,locked_at=CASE WHEN ?1='LOCKED' THEN ?2 ELSE locked_at END,revealed_at=CASE WHEN ?1='REVEALED' THEN ?2 ELSE revealed_at END,updated_at=?2 WHERE id=?3",params![target,now,id])?;
        tx.commit()?;
        Self::get_question(d, id)?.ok_or(AppError::Storage)
    }
    pub fn list_assets(
        d: &Database,
        qid: &str,
    ) -> Result<Vec<SessionQuestionAssetRecord>, AppError> {
        let c = d.connection()?;
        let mut s=c.prepare("SELECT id,session_question_id,source_asset_id,asset_type,storage_path,display_name,mime_type,size_bytes,sha256,position,page_reference FROM session_question_assets WHERE session_question_id=?1 ORDER BY position,id")?;
        let rows = s
            .query_map([qid], asset_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into);
        rows
    }
    pub fn get_asset(
        d: &Database,
        id: &str,
    ) -> Result<Option<SessionQuestionAssetRecord>, AppError> {
        let c = d.connection()?;
        c.query_row("SELECT id,session_question_id,source_asset_id,asset_type,storage_path,display_name,mime_type,size_bytes,sha256,position,page_reference FROM session_question_assets WHERE id=?1",[id],asset_row).optional().map_err(Into::into)
    }
    pub fn submit(
        d: &Database,
        input: NewSubmission,
    ) -> Result<(SubmissionRecord, bool), AppError> {
        let mut c = d.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(e) = tx
            .query_row(
                &submission_select("WHERE id=?1"),
                [&input.id],
                submission_row,
            )
            .optional()?
        {
            return if e.session_question_id == input.session_question_id
                && e.participant_id == input.participant_id
                && e.answer_json == input.answer_json
            {
                Ok((e, true))
            } else {
                Err(AppError::Conflict(
                    "submission ID was reused with another payload".to_owned(),
                ))
            };
        }
        let state: Option<String> = tx
            .query_row(
                "SELECT state FROM session_questions WHERE id=?1",
                [&input.session_question_id],
                |r| r.get(0),
            )
            .optional()?;
        if state.is_none() {
            return Err(AppError::NotFound("session question".to_owned()));
        }
        if state.as_deref() != Some("OPEN") {
            return Err(AppError::QuestionLocked);
        }
        let revision:i64=tx.query_row("SELECT COALESCE(MAX(revision)+1,1) FROM submissions WHERE session_question_id=?1 AND participant_id=?2",params![input.session_question_id,input.participant_id],|r|r.get(0))?;
        let at = now_utc();
        tx.execute("INSERT INTO submissions(id,session_question_id,participant_id,revision,answer_json,grading_status,is_correct,score,max_score,submitted_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![input.id,input.session_question_id,input.participant_id,revision,json_text(&input.answer_json)?,input.grading_status,input.is_correct.map(i64::from),input.score,input.max_score,at])?;
        tx.commit()?;
        Ok((
            Self::get_submission(d, &input.id)?.ok_or(AppError::Storage)?,
            false,
        ))
    }
    pub fn get_submission(d: &Database, id: &str) -> Result<Option<SubmissionRecord>, AppError> {
        let c = d.connection()?;
        c.query_row(&submission_select("WHERE id=?1"), [id], submission_row)
            .optional()
            .map_err(Into::into)
    }
    pub fn latest_submission(
        d: &Database,
        qid: &str,
        pid: &str,
    ) -> Result<Option<SubmissionRecord>, AppError> {
        let c = d.connection()?;
        c.query_row(
            &submission_select(
                "WHERE session_question_id=?1 AND participant_id=?2 ORDER BY revision DESC LIMIT 1",
            ),
            params![qid, pid],
            submission_row,
        )
        .optional()
        .map_err(Into::into)
    }
    pub fn answered_participants(d: &Database, qid: &str) -> Result<Vec<String>, AppError> {
        let c = d.connection()?;
        let mut s = c.prepare(
            "SELECT DISTINCT participant_id FROM submissions WHERE session_question_id=?1",
        )?;
        let rows = s
            .query_map([qid], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into);
        rows
    }
}
fn question_select(c: &str) -> String {
    format!("SELECT id,session_id,source_question_id,question_type,prompt,points,position,answer_config,grading_config,metadata,config_version,state,created_at,opened_at,locked_at,revealed_at FROM session_questions {c}")
}
fn submission_select(c: &str) -> String {
    format!("SELECT id,session_question_id,participant_id,revision,answer_json,grading_status,is_correct,score,max_score,submitted_at FROM submissions {c}")
}
fn question_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SessionQuestionRecord> {
    Ok(SessionQuestionRecord {
        id: r.get(0)?,
        session_id: r.get(1)?,
        source_question_id: r.get(2)?,
        question_type: r.get(3)?,
        prompt: r.get(4)?,
        points: r.get(5)?,
        position: r.get(6)?,
        answer_config: json(r.get(7)?)?,
        grading_config: json(r.get(8)?)?,
        metadata: json(r.get(9)?)?,
        config_version: r.get(10)?,
        state: r.get(11)?,
        created_at: r.get(12)?,
        opened_at: r.get(13)?,
        locked_at: r.get(14)?,
        revealed_at: r.get(15)?,
    })
}
fn asset_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SessionQuestionAssetRecord> {
    Ok(SessionQuestionAssetRecord {
        id: r.get(0)?,
        session_question_id: r.get(1)?,
        source_asset_id: r.get(2)?,
        asset_type: r.get(3)?,
        storage_path: r.get(4)?,
        display_name: r.get(5)?,
        mime_type: r.get(6)?,
        size_bytes: r.get(7)?,
        sha256: r.get(8)?,
        position: r.get(9)?,
        page_reference: r.get(10)?,
    })
}
fn submission_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SubmissionRecord> {
    Ok(SubmissionRecord {
        id: r.get(0)?,
        session_question_id: r.get(1)?,
        participant_id: r.get(2)?,
        revision: r.get(3)?,
        answer_json: json(r.get(4)?)?,
        grading_status: r.get(5)?,
        is_correct: r.get::<_, Option<i64>>(6)?.map(|v| v != 0),
        score: r.get(7)?,
        max_score: r.get(8)?,
        submitted_at: r.get(9)?,
    })
}
fn json(raw: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}
fn json_text(v: &Value) -> Result<String, AppError> {
    serde_json::to_string(v).map_err(|_| AppError::Storage)
}
