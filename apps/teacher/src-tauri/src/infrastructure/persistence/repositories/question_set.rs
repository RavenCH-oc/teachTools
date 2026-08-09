use super::{map_write_error, new_id, now_utc, validate_name};
use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;
use rusqlite::params;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct QuestionSet {
    pub id: String,
    pub lesson_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
pub struct NewQuestionSet {
    pub lesson_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
}
pub struct QuestionSetRepository;
impl QuestionSetRepository {
    pub fn create(database: &Database, input: NewQuestionSet) -> Result<QuestionSet, AppError> {
        validate_name(&input.title)?;
        let id = new_id();
        let now = now_utc();
        let c = database.connection()?;
        c.execute("INSERT INTO question_sets(id,lesson_id,title,description,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)",params![id,input.lesson_id,input.title,input.description,now]).map_err(map_write_error)?;
        Self::get(database, &id)?.ok_or(AppError::Storage)
    }
    pub fn get(database: &Database, id: &str) -> Result<Option<QuestionSet>, AppError> {
        let c = database.connection()?;
        Ok(c.query_row("SELECT id,lesson_id,title,description,created_at,updated_at FROM question_sets WHERE id=?1",[id],|r|Ok(QuestionSet{id:r.get(0)?,lesson_id:r.get(1)?,title:r.get(2)?,description:r.get(3)?,created_at:r.get(4)?,updated_at:r.get(5)?})).optional()?)
    }
    pub fn list(database: &Database) -> Result<Vec<QuestionSet>, AppError> {
        let c = database.connection()?;
        let mut s=c.prepare("SELECT id,lesson_id,title,description,created_at,updated_at FROM question_sets ORDER BY title")?;
        let rows = s
            .query_map([], |r| {
                Ok(QuestionSet {
                    id: r.get(0)?,
                    lesson_id: r.get(1)?,
                    title: r.get(2)?,
                    description: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn delete(database: &Database, id: &str) -> Result<(), AppError> {
        let c = database.connection()?;
        if c.execute("DELETE FROM question_sets WHERE id=?1", [id])
            .map_err(map_write_error)?
            == 0
        {
            return Err(AppError::NotFound("question set".to_owned()));
        }
        Ok(())
    }
}
use rusqlite::OptionalExtension;
