use super::{map_write_error, new_id, now_utc, validate_name};
use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;
use rusqlite::params;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Course {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
pub struct NewCourse {
    pub name: String,
    pub description: Option<String>,
}
pub struct CourseRepository;
impl CourseRepository {
    pub fn create(database: &Database, input: NewCourse) -> Result<Course, AppError> {
        validate_name(&input.name)?;
        let id = new_id();
        let now = now_utc();
        let c = database.connection()?;
        c.execute("INSERT INTO courses(id,name,description,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",params![id,input.name,input.description,now]).map_err(map_write_error)?;
        Self::get(database, &id)?.ok_or(AppError::Storage)
    }
    pub fn get(database: &Database, id: &str) -> Result<Option<Course>, AppError> {
        let c = database.connection()?;
        Ok(c.query_row(
            "SELECT id,name,description,created_at,updated_at FROM courses WHERE id=?1",
            [id],
            |r| {
                Ok(Course {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            },
        )
        .optional()?)
    }
    pub fn list(database: &Database) -> Result<Vec<Course>, AppError> {
        let c = database.connection()?;
        let mut s = c.prepare(
            "SELECT id,name,description,created_at,updated_at FROM courses ORDER BY name",
        )?;
        let rows = s
            .query_map([], |r| {
                Ok(Course {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn delete(database: &Database, id: &str) -> Result<(), AppError> {
        let c = database.connection()?;
        if c.execute("DELETE FROM courses WHERE id=?1", [id])
            .map_err(map_write_error)?
            == 0
        {
            return Err(AppError::NotFound("course".to_owned()));
        }
        Ok(())
    }
}
use rusqlite::OptionalExtension;
