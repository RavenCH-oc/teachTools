use super::{map_write_error, new_id, now_utc, validate_name};
use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;
use rusqlite::params;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Lesson {
    pub id: String,
    pub course_id: String,
    pub title: String,
    pub description: Option<String>,
    pub content_metadata: serde_json::Value,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}
pub struct NewLesson {
    pub course_id: String,
    pub title: String,
    pub description: Option<String>,
    pub content_metadata: serde_json::Value,
    pub position: i64,
}
pub struct LessonRepository;
impl LessonRepository {
    pub fn create(database: &Database, input: NewLesson) -> Result<Lesson, AppError> {
        validate_name(&input.title)?;
        let id = new_id();
        let now = now_utc();
        let metadata = serde_json::to_string(&input.content_metadata)
            .map_err(|_| AppError::Validation("content metadata must be JSON".to_owned()))?;
        let c = database.connection()?;
        c.execute("INSERT INTO lessons(id,course_id,title,description,content_metadata,position,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7)",params![id,input.course_id,input.title,input.description,metadata,input.position,now]).map_err(map_write_error)?;
        Self::get(database, &id)?.ok_or(AppError::Storage)
    }
    pub fn get(database: &Database, id: &str) -> Result<Option<Lesson>, AppError> {
        let c = database.connection()?;
        Ok(c.query_row("SELECT id,course_id,title,description,content_metadata,position,created_at,updated_at FROM lessons WHERE id=?1",[id],|r|{let raw:String=r.get(4)?;let metadata=serde_json::from_str(&raw).map_err(|error|rusqlite::Error::FromSqlConversionFailure(4,rusqlite::types::Type::Text,Box::new(error)))?;Ok(Lesson{id:r.get(0)?,course_id:r.get(1)?,title:r.get(2)?,description:r.get(3)?,content_metadata:metadata,position:r.get(5)?,created_at:r.get(6)?,updated_at:r.get(7)?})}).optional()?)
    }
    pub fn list_by_course(database: &Database, course_id: &str) -> Result<Vec<Lesson>, AppError> {
        let c = database.connection()?;
        let mut s=c.prepare("SELECT id,course_id,title,description,content_metadata,position,created_at,updated_at FROM lessons WHERE course_id=?1 ORDER BY position,id")?;
        let rows = s
            .query_map([course_id], |r| {
                let raw: String = r.get(4)?;
                Ok(Lesson {
                    id: r.get(0)?,
                    course_id: r.get(1)?,
                    title: r.get(2)?,
                    description: r.get(3)?,
                    content_metadata: serde_json::from_str(&raw).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            4,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?,
                    position: r.get(5)?,
                    created_at: r.get(6)?,
                    updated_at: r.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn update(
        database: &Database,
        id: &str,
        title: String,
        description: Option<String>,
        position: i64,
    ) -> Result<Lesson, AppError> {
        validate_name(&title)?;
        if position < 0 {
            return Err(AppError::Validation(
                "position must not be negative".to_owned(),
            ));
        }
        let c = database.connection()?;
        if c.execute(
            "UPDATE lessons SET title=?1,description=?2,position=?3,updated_at=?4 WHERE id=?5",
            params![title, description, position, now_utc(), id],
        )? == 0
        {
            return Err(AppError::NotFound("lesson".to_owned()));
        }
        Self::get(database, id)?.ok_or(AppError::Storage)
    }
    pub fn delete(database: &Database, id: &str) -> Result<(), AppError> {
        let c = database.connection()?;
        if c.execute("DELETE FROM lessons WHERE id=?1", [id])
            .map_err(map_write_error)?
            == 0
        {
            return Err(AppError::NotFound("lesson".to_owned()));
        }
        Ok(())
    }
}
use rusqlite::OptionalExtension;
