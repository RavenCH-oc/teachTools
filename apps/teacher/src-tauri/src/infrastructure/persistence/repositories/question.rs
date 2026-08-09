use super::{map_write_error, new_id, now_utc};
use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;
use rusqlite::params;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Question {
    pub id: String,
    pub question_set_id: String,
    pub question_type: String,
    pub prompt: String,
    pub points: i64,
    pub position: i64,
    pub answer_config: serde_json::Value,
    pub grading_config: serde_json::Value,
    pub metadata: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}
pub struct NewQuestion {
    pub question_set_id: String,
    pub question_type: String,
    pub prompt: String,
    pub points: i64,
    pub position: i64,
    pub answer_config: serde_json::Value,
    pub grading_config: serde_json::Value,
    pub metadata: serde_json::Value,
}
pub struct QuestionRepository;
impl QuestionRepository {
    pub fn create(database: &Database, input: NewQuestion) -> Result<Question, AppError> {
        if input.prompt.trim().is_empty() {
            return Err(AppError::Validation("prompt must not be empty".to_owned()));
        }
        if input.points <= 0 || input.position < 0 {
            return Err(AppError::Validation(
                "points and position must not be negative".to_owned(),
            ));
        }
        if ![
            "true_false",
            "single_choice",
            "multiple_choice",
            "fill_blank",
            "essay",
        ]
        .contains(&input.question_type.as_str())
        {
            return Err(AppError::Validation(
                "question type is not supported".to_owned(),
            ));
        }
        let id = new_id();
        let now = now_utc();
        let c = database.connection()?;
        let values = [
            serde_json::to_string(&input.answer_config),
            serde_json::to_string(&input.grading_config),
            serde_json::to_string(&input.metadata),
        ];
        let (answer, grading, metadata) = (
            values[0]
                .as_ref()
                .map_err(|_| AppError::Validation("answer config must be JSON".to_owned()))?,
            values[1]
                .as_ref()
                .map_err(|_| AppError::Validation("grading config must be JSON".to_owned()))?,
            values[2]
                .as_ref()
                .map_err(|_| AppError::Validation("metadata must be JSON".to_owned()))?,
        );
        c.execute("INSERT INTO questions(id,question_set_id,type,prompt,points,position,answer_config,grading_config,metadata,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",params![id,input.question_set_id,input.question_type,input.prompt,input.points,input.position,answer,grading,metadata,now]).map_err(map_write_error)?;
        Self::get(database, &id)?.ok_or(AppError::Storage)
    }
    pub fn get(database: &Database, id: &str) -> Result<Option<Question>, AppError> {
        let c = database.connection()?;
        Ok(c.query_row("SELECT id,question_set_id,type,prompt,points,position,answer_config,grading_config,metadata,created_at,updated_at FROM questions WHERE id=?1",[id],|r|Ok(Question{id:r.get(0)?,question_set_id:r.get(1)?,question_type:r.get(2)?,prompt:r.get(3)?,points:r.get(4)?,position:r.get(5)?,answer_config:json(r.get(6)?)?,grading_config:json(r.get(7)?)?,metadata:json(r.get(8)?)?,created_at:r.get(9)?,updated_at:r.get(10)?})).optional()?)
    }
    pub fn list(database: &Database) -> Result<Vec<Question>, AppError> {
        let c = database.connection()?;
        let mut s=c.prepare("SELECT id,question_set_id,type,prompt,points,position,answer_config,grading_config,metadata,created_at,updated_at FROM questions ORDER BY position,id")?;
        let rows = s
            .query_map([], |r| {
                Ok(Question {
                    id: r.get(0)?,
                    question_set_id: r.get(1)?,
                    question_type: r.get(2)?,
                    prompt: r.get(3)?,
                    points: r.get(4)?,
                    position: r.get(5)?,
                    answer_config: json(r.get(6)?)?,
                    grading_config: json(r.get(7)?)?,
                    metadata: json(r.get(8)?)?,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn list_by_question_set(
        database: &Database,
        question_set_id: &str,
    ) -> Result<Vec<Question>, AppError> {
        let c = database.connection()?;
        let mut s = c.prepare("SELECT id,question_set_id,type,prompt,points,position,answer_config,grading_config,metadata,created_at,updated_at FROM questions WHERE question_set_id=?1 ORDER BY position,id")?;
        let rows = s
            .query_map([question_set_id], |r| {
                Ok(Question {
                    id: r.get(0)?,
                    question_set_id: r.get(1)?,
                    question_type: r.get(2)?,
                    prompt: r.get(3)?,
                    points: r.get(4)?,
                    position: r.get(5)?,
                    answer_config: json(r.get(6)?)?,
                    grading_config: json(r.get(7)?)?,
                    metadata: json(r.get(8)?)?,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn update(database: &Database, id: &str, input: NewQuestion) -> Result<Question, AppError> {
        if input.prompt.trim().is_empty() || input.points <= 0 || input.position < 0 {
            return Err(AppError::Validation(
                "question prompt, points, or position is invalid".to_owned(),
            ));
        }
        let c = database.connection()?;
        let values = [
            serde_json::to_string(&input.answer_config),
            serde_json::to_string(&input.grading_config),
            serde_json::to_string(&input.metadata),
        ];
        let answer = values[0]
            .as_ref()
            .map_err(|_| AppError::Validation("answer config must be JSON".to_owned()))?;
        let grading = values[1]
            .as_ref()
            .map_err(|_| AppError::Validation("grading config must be JSON".to_owned()))?;
        let metadata = values[2]
            .as_ref()
            .map_err(|_| AppError::Validation("metadata must be JSON".to_owned()))?;
        if c.execute("UPDATE questions SET question_set_id=?1,type=?2,prompt=?3,points=?4,position=?5,answer_config=?6,grading_config=?7,metadata=?8,updated_at=?9 WHERE id=?10", params![input.question_set_id,input.question_type,input.prompt,input.points,input.position,answer,grading,metadata,now_utc(),id]).map_err(map_write_error)? == 0 { return Err(AppError::NotFound("question".to_owned())); }
        Self::get(database, id)?.ok_or(AppError::Storage)
    }
    pub fn delete(database: &Database, id: &str) -> Result<(), AppError> {
        let c = database.connection()?;
        if c.execute("DELETE FROM questions WHERE id=?1", [id])
            .map_err(map_write_error)?
            == 0
        {
            return Err(AppError::NotFound("question".to_owned()));
        }
        Ok(())
    }
}
fn json(raw: String) -> Result<serde_json::Value, rusqlite::Error> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}
use rusqlite::OptionalExtension;
