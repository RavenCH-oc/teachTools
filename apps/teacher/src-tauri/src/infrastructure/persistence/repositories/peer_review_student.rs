//! Student metadata reads are bounded at the SQLite boundary, not after materialization.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

pub const DEFAULT_LIMIT: usize = 50;
pub const MAX_LIMIT: usize = 100;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageRequest {
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

// Cursor keys contain only ordering metadata and opaque domain IDs. They grant no access.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    scope: String,
    key: String,
    id: String,
}

impl PageRequest {
    fn bounds(&self, scope: &str) -> Result<(usize, String, String)> {
        let limit = self.limit.unwrap_or(DEFAULT_LIMIT);
        if !(1..=MAX_LIMIT).contains(&limit) {
            return Err(PeerReviewError::InvalidInput);
        }
        let Some(encoded) = &self.cursor else {
            return Ok((limit, String::new(), String::new()));
        };
        if encoded.len() > 1024 {
            return Err(PeerReviewError::InvalidInput);
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| PeerReviewError::InvalidInput)?;
        let cursor: Cursor =
            serde_json::from_slice(&bytes).map_err(|_| PeerReviewError::InvalidInput)?;
        if cursor.scope != scope || cursor.id.is_empty() {
            return Err(PeerReviewError::InvalidInput);
        }
        Ok((limit, cursor.key, cursor.id))
    }
}

fn page<T>(mut rows: Vec<(String, String, T)>, limit: usize, scope: &str) -> Result<Page<T>> {
    let more = rows.len() > limit;
    if more {
        rows.pop();
    }
    let next_cursor = if more {
        rows.last()
            .map(|(key, id, _)| {
                serde_json::to_vec(&Cursor {
                    scope: scope.to_owned(),
                    key: key.clone(),
                    id: id.clone(),
                })
                .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
                .map_err(|_| PeerReviewError::Storage)
            })
            .transpose()?
    } else {
        None
    };
    Ok(Page {
        items: rows.into_iter().map(|(_, _, item)| item).collect(),
        next_cursor,
    })
}

// Parameters: ?1 session, ?2 authenticated participant. Frozen membership, never latest grouping.
const VISIBLE: &str = "a.session_id=?1 AND a.state IN ('OPEN','CLOSED') AND (
 EXISTS(SELECT 1 FROM peer_review_assignments x WHERE x.activity_id=a.id AND
  (x.reviewer_participant_id=?2 OR EXISTS(SELECT 1 FROM session_group_members m
   WHERE m.group_set_id=a.session_group_set_id AND m.group_id=x.reviewer_session_group_id AND m.participant_id=?2)))
 OR (a.state='OPEN' AND a.mode!='CROSS_GROUP' AND EXISTS(
  SELECT 1 FROM peer_review_targets t WHERE t.activity_id=a.id AND t.participant_id=?2))
 OR EXISTS(SELECT 1 FROM peer_review_assignments x WHERE x.activity_id=a.id
  AND EXISTS(SELECT 1 FROM peer_review_responses r WHERE r.assignment_id=x.id)
  AND (EXISTS(SELECT 1 FROM peer_review_targets t WHERE t.id=x.target_id AND t.participant_id=?2)
   OR EXISTS(SELECT 1 FROM peer_review_group_targets g JOIN session_group_members m
    ON m.group_set_id=g.session_group_set_id AND m.group_id=g.session_group_id
    WHERE g.id=x.target_group_id AND m.participant_id=?2))))";

fn authorize(connection: &Connection, session: &str, participant: &str) -> Result<()> {
    require_active(connection, session)?;
    let present: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_participants WHERE id=?1 AND session_id=?2)",
        params![participant, session],
        |r| r.get(0),
    )?;
    if !present {
        return Err(PeerReviewError::ReviewerNotAuthorized);
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityMetadata {
    pub question_summary: String,
    pub received_feedback_count: i64,
    pub reviewer_group_label: Option<String>,
    pub target_group_label: Option<String>,
    pub activity_id: String,
    pub session_question_id: String,
    pub mode: String,
    pub state: String,
    pub assignment_id: Option<String>,
    pub latest_review_revision: Option<i64>,
}

pub fn activities(
    database: &Database,
    session: &str,
    participant: &str,
    request: &PageRequest,
) -> Result<Page<ActivityMetadata>> {
    activities_query(database, session, participant, request, None)
}

pub fn activity_metadata(
    database: &Database,
    session: &str,
    participant: &str,
    id: &str,
) -> Result<Page<ActivityMetadata>> {
    let result = activities_query(
        database,
        session,
        participant,
        &PageRequest {
            limit: Some(1),
            cursor: None,
        },
        Some(id),
    )?;
    if result.items.is_empty() {
        return Err(PeerReviewError::ReviewerNotAuthorized);
    }
    Ok(result)
}

fn activities_query(
    database: &Database,
    session: &str,
    participant: &str,
    request: &PageRequest,
    activity_id: Option<&str>,
) -> Result<Page<ActivityMetadata>> {
    let scope = format!("activities:{session}:{participant}");
    let (limit, key, id) = request.bounds(&scope)?;
    let connection = database.connection()?;
    authorize(&connection, session, participant)?;
    let sql = format!("SELECT a.created_at,a.id,a.session_question_id,a.mode,a.state,
      (SELECT x.id FROM peer_review_assignments x WHERE x.activity_id=a.id AND
       (x.reviewer_participant_id=?2 OR EXISTS(SELECT 1 FROM session_group_members m
        WHERE m.group_set_id=a.session_group_set_id AND m.group_id=x.reviewer_session_group_id AND m.participant_id=?2))
       ORDER BY x.id LIMIT 1) AS own_assignment,
      (SELECT substr(q.prompt,1,201) FROM session_questions q WHERE q.id=a.session_question_id),
      (SELECT COUNT(*) FROM peer_review_assignments x WHERE x.activity_id=a.id AND {RECIPIENT}
       AND EXISTS(SELECT 1 FROM peer_review_responses r WHERE r.assignment_id=x.id))
      FROM peer_review_activities a WHERE {VISIBLE} AND (?6 IS NULL OR a.id=?6) AND (a.created_at,a.id)>(?3,?4)
      ORDER BY a.created_at,a.id LIMIT ?5");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement
        .query_map(
            params![
                session,
                participant,
                key,
                id,
                (limit + 1) as i64,
                activity_id
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    ActivityMetadata {
                        question_summary: presentation_summary(&r.get::<_, String>(6)?),
                        received_feedback_count: r.get(7)?,
                        reviewer_group_label: None,
                        target_group_label: None,
                        activity_id: r.get(1)?,
                        session_question_id: r.get(2)?,
                        mode: r.get(3)?,
                        state: r.get(4)?,
                        assignment_id: r.get(5)?,
                        latest_review_revision: None,
                    },
                ))
            },
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut result = page(rows, limit, &scope)?;
    for item in &mut result.items {
        if let Some(assignment) = &item.assignment_id {
            if item.mode == "CROSS_GROUP" {
                let labels = connection.query_row(
                    "SELECT reviewer.name,target.name FROM peer_review_assignments x
                     JOIN peer_review_activities a ON a.id=x.activity_id
                     JOIN session_groups reviewer ON reviewer.id=x.reviewer_session_group_id AND reviewer.group_set_id=a.session_group_set_id
                     JOIN peer_review_group_targets t ON t.id=x.target_group_id AND t.session_group_set_id=a.session_group_set_id
                     JOIN session_groups target ON target.id=t.session_group_id AND target.group_set_id=a.session_group_set_id
                     WHERE x.id=?1", [assignment], |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?;
                item.reviewer_group_label = Some(labels.0);
                item.target_group_label = Some(labels.1);
            }
            item.latest_review_revision = connection.query_row(
                "SELECT MAX(revision) FROM peer_review_responses WHERE assignment_id=?1",
                [assignment],
                |r| r.get(0),
            )?;
        }
    }
    Ok(result)
}

fn presentation_summary(prompt: &str) -> String {
    if prompt.chars().count() <= 200 {
        prompt.to_owned()
    } else {
        prompt
            .chars()
            .take(199)
            .chain(std::iter::once('…'))
            .collect()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateMetadata {
    pub peer_review_target_id: String,
    pub label: String,
    pub submitted_review_count: i64,
    pub has_received_any_review: bool,
    pub remaining_capacity: Option<i64>,
    pub full: bool,
    pub current_claim: bool,
}

pub fn candidates(
    database: &Database,
    session: &str,
    participant: &str,
    activity_id: &str,
    request: &PageRequest,
) -> Result<Page<CandidateMetadata>> {
    let scope = format!("candidates:{session}:{participant}:{activity_id}");
    let (limit, key, id) = request.bounds(&scope)?;
    // Only a public received/not-received bucket and opaque target ID enter the cursor.
    let bucket = if key.is_empty() {
        -1
    } else {
        key.parse::<i64>()
            .map_err(|_| PeerReviewError::InvalidInput)?
    };
    if !(-1..=1).contains(&bucket) {
        return Err(PeerReviewError::InvalidInput);
    }
    let connection = database.connection()?;
    authorize(&connection, session, participant)?;
    let eligible: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM peer_review_activities a JOIN peer_review_targets t ON t.activity_id=a.id
         WHERE a.id=?1 AND a.session_id=?2 AND a.mode='STUDENT_SELECT' AND a.state='OPEN' AND t.participant_id=?3)",
        params![activity_id,session,participant], |r| r.get(0))?;
    if !eligible {
        return Err(PeerReviewError::ReviewerNotAuthorized);
    }
    let mut statement = connection.prepare(
        "WITH candidates AS (SELECT t.id,p.display_name,a.max_reviews_per_target,
          (SELECT COUNT(*) FROM peer_review_assignments x WHERE x.target_id=t.id) AS claims,
          (SELECT COUNT(*) FROM peer_review_assignments x WHERE x.target_id=t.id AND
           EXISTS(SELECT 1 FROM peer_review_responses r WHERE r.assignment_id=x.id)) AS submitted,
          EXISTS(SELECT 1 FROM peer_review_assignments x WHERE x.target_id=t.id AND x.reviewer_participant_id=?2) AS current_claim
         FROM peer_review_targets t JOIN session_participants p ON p.id=t.participant_id
         JOIN peer_review_activities a ON a.id=t.activity_id WHERE t.activity_id=?1 AND t.participant_id!=?2)
         SELECT id,display_name,max_reviews_per_target,claims,submitted,current_claim FROM candidates
         WHERE ((submitted>0),id)>(?3,?4) ORDER BY (submitted>0),id LIMIT ?5")?;
    let rows = statement
        .query_map(
            params![activity_id, participant, bucket, id, (limit + 1) as i64],
            |r| {
                let submitted: i64 = r.get(4)?;
                let maximum: Option<i64> = r.get(2)?;
                let claims: i64 = r.get(3)?;
                let remaining = maximum.map(|max| (max - claims).max(0));
                Ok((
                    (i64::from(submitted > 0)).to_string(),
                    r.get::<_, String>(0)?,
                    CandidateMetadata {
                        peer_review_target_id: r.get(0)?,
                        label: r.get(1)?,
                        submitted_review_count: submitted,
                        has_received_any_review: submitted > 0,
                        remaining_capacity: remaining,
                        full: remaining == Some(0),
                        current_claim: r.get(5)?,
                    },
                ))
            },
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    page(rows, limit, &scope)
}

const RECIPIENT: &str =
    "(EXISTS(SELECT 1 FROM peer_review_targets t WHERE t.id=x.target_id AND t.participant_id=?2)
 OR EXISTS(SELECT 1 FROM peer_review_group_targets g JOIN session_group_members m
 ON m.group_set_id=g.session_group_set_id AND m.group_id=g.session_group_id
 WHERE g.id=x.target_group_id AND m.participant_id=?2))";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackMetadata {
    pub assignment_id: String,
    pub activity_id: String,
    pub revision: i64,
}

pub fn feedback(
    database: &Database,
    session: &str,
    participant: &str,
    request: &PageRequest,
) -> Result<Page<FeedbackMetadata>> {
    feedback_scoped(database, session, participant, request, None)
}

pub fn feedback_scoped(
    database: &Database,
    session: &str,
    participant: &str,
    request: &PageRequest,
    activity_id: Option<&str>,
) -> Result<Page<FeedbackMetadata>> {
    let scope = match activity_id {
        Some(id) => format!("feedback:{session}:{participant}:activity:{id}"),
        None => format!("feedback:{session}:{participant}"),
    };
    let (limit, _, id) = request.bounds(&scope)?;
    let connection = database.connection()?;
    authorize(&connection, session, participant)?;
    if let Some(activity_id) = activity_id {
        if !uuid::Uuid::parse_str(activity_id)
            .is_ok_and(|id| id.get_variant() == uuid::Variant::RFC4122 && id.get_version_num() == 7)
        {
            return Err(PeerReviewError::InvalidInput);
        }
        let visible: bool = connection.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM peer_review_activities a WHERE {VISIBLE} AND a.id=?3)"
            ),
            params![session, participant, activity_id],
            |r| r.get(0),
        )?;
        if !visible {
            return Err(PeerReviewError::ReviewerNotAuthorized);
        }
    }
    let sql = format!("SELECT x.id,x.activity_id,r.revision FROM peer_review_assignments x
      JOIN peer_review_activities a ON a.id=x.activity_id JOIN peer_review_responses r ON r.assignment_id=x.id
      AND r.revision=(SELECT MAX(latest.revision) FROM peer_review_responses latest WHERE latest.assignment_id=x.id)
      WHERE a.session_id=?1 AND a.state IN ('OPEN','CLOSED') AND {RECIPIENT} AND (?5 IS NULL OR a.id=?5) AND x.id>?3 ORDER BY x.id LIMIT ?4");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement
        .query_map(
            params![session, participant, id, (limit + 1) as i64, activity_id],
            |r| {
                Ok((
                    String::new(),
                    r.get::<_, String>(0)?,
                    FeedbackMetadata {
                        assignment_id: r.get(0)?,
                        activity_id: r.get(1)?,
                        revision: r.get(2)?,
                    },
                ))
            },
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    page(rows, limit, &scope)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    pub available: bool,
    pub visible_activity_count: i64,
    pub received_feedback_count: i64,
}

pub fn projection(database: &Database, session: &str, participant: &str) -> Result<Projection> {
    let connection = database.connection()?;
    authorize(&connection, session, participant)?;
    let visible_activity_count: i64 = connection.query_row(
        &format!("SELECT COUNT(*) FROM peer_review_activities a WHERE {VISIBLE}"),
        params![session, participant],
        |r| r.get(0),
    )?;
    let received_feedback_count = connection.query_row(
        &format!("SELECT COUNT(*) FROM peer_review_assignments x JOIN peer_review_activities a ON a.id=x.activity_id
        WHERE a.session_id=?1 AND a.state IN ('OPEN','CLOSED') AND {RECIPIENT}
        AND EXISTS(SELECT 1 FROM peer_review_responses r WHERE r.assignment_id=x.id)"),params![session,participant],|r|r.get(0))?;
    Ok(Projection {
        available: visible_activity_count > 0,
        visible_activity_count,
        received_feedback_count,
    })
}

pub fn authorize_assignment(
    database: &Database,
    session: &str,
    participant: &str,
    id: &str,
) -> Result<String> {
    let connection = database.connection()?;
    authorize(&connection, session, participant)?;
    connection.query_row(
        "SELECT a.id FROM peer_review_assignments x JOIN peer_review_activities a ON a.id=x.activity_id
         WHERE x.id=?1 AND a.session_id=?2 AND a.state IN ('OPEN','CLOSED') AND
         (x.reviewer_participant_id=?3 OR EXISTS(SELECT 1 FROM session_group_members m
          WHERE m.group_set_id=a.session_group_set_id AND m.group_id=x.reviewer_session_group_id AND m.participant_id=?3))",
        params![id,session,participant],|r|r.get(0)).optional()?.ok_or(PeerReviewError::ReviewerNotAuthorized)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EssayDetail {
    pub peer_review_target_id: String,
    pub label: String,
    pub essay: String,
}

pub fn essays(
    database: &Database,
    session: &str,
    participant: &str,
    assignment_id: &str,
    request: &PageRequest,
) -> Result<Page<EssayDetail>> {
    authorize_assignment(database, session, participant, assignment_id)?;
    let scope = format!("essays:{session}:{participant}:{assignment_id}");
    let (limit, _, id) = request.bounds(&scope)?;
    let connection = database.connection()?;
    let mut statement=connection.prepare(
        "SELECT t.id,p.display_name,json_extract(s.answer_json,'$.text') FROM peer_review_targets t
         JOIN submissions s ON s.id=t.submission_id JOIN session_participants p ON p.id=t.participant_id
         JOIN peer_review_assignments x ON x.id=?1 AND (x.target_id=t.id OR EXISTS(
          SELECT 1 FROM peer_review_group_target_items i WHERE i.group_target_id=x.target_group_id AND i.target_id=t.id))
         WHERE t.id>?2 ORDER BY t.id LIMIT ?3")?;
    let rows = statement
        .query_map(params![assignment_id, id, (limit + 1) as i64], |r| {
            Ok((
                String::new(),
                r.get::<_, String>(0)?,
                EssayDetail {
                    peer_review_target_id: r.get(0)?,
                    label: r.get(1)?,
                    essay: r.get(2)?,
                },
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    page(rows, limit, &scope)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackDetail {
    pub assignment_id: String,
    pub revision: i64,
    pub body: String,
}

pub fn own_review(
    database: &Database,
    session: &str,
    participant: &str,
    id: &str,
) -> Result<Option<FeedbackDetail>> {
    authorize_assignment(database, session, participant, id)?;
    let connection = database.connection()?;
    connection.query_row("SELECT revision,body FROM peer_review_responses WHERE assignment_id=?1 ORDER BY revision DESC LIMIT 1",[id],|r|Ok(FeedbackDetail {assignment_id:id.to_owned(),revision:r.get(0)?,body:r.get(1)?})).optional().map_err(Into::into)
}

pub fn feedback_detail(
    database: &Database,
    session: &str,
    participant: &str,
    assignment_id: &str,
) -> Result<FeedbackDetail> {
    let connection = database.connection()?;
    authorize(&connection, session, participant)?;
    let sql=format!("SELECT r.revision,r.body FROM peer_review_assignments x
        JOIN peer_review_activities a ON a.id=x.activity_id JOIN peer_review_responses r ON r.assignment_id=x.id
        WHERE a.session_id=?1 AND {RECIPIENT} AND x.id=?3 AND a.state IN ('OPEN','CLOSED') ORDER BY r.revision DESC LIMIT 1");
    connection
        .query_row(&sql, params![session, participant, assignment_id], |r| {
            Ok(FeedbackDetail {
                assignment_id: assignment_id.to_owned(),
                revision: r.get(0)?,
                body: r.get(1)?,
            })
        })
        .optional()?
        .ok_or(PeerReviewError::ReviewerNotAuthorized)
}
