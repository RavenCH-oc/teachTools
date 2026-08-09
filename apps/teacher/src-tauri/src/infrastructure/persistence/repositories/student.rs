use rusqlite::params;
use serde::Serialize;

use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;

use super::{map_write_error, new_id, now_utc, validate_name};

#[derive(Debug, Clone, Serialize)]
pub struct Student {
    pub id: String,
    pub class_id: String,
    pub seat_number: i64,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

pub struct NewStudent {
    pub class_id: String,
    pub seat_number: i64,
    pub name: String,
}
pub struct StudentRepository;

impl StudentRepository {
    pub fn create(database: &Database, input: NewStudent) -> Result<Student, AppError> {
        validate_name(&input.name)?;
        if input.seat_number <= 0 {
            return Err(AppError::Validation(
                "seat number must be positive".to_owned(),
            ));
        }
        let id = new_id();
        let now = now_utc();
        let connection = database.connection()?;
        connection.execute("INSERT INTO students(id,class_id,seat_number,name,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)", params![id,input.class_id,input.seat_number,input.name,now]).map_err(map_write_error)?;
        Self::get(database, &id)?.ok_or(AppError::Storage)
    }
    pub fn get(database: &Database, id: &str) -> Result<Option<Student>, AppError> {
        let connection = database.connection()?;
        Ok(connection.query_row("SELECT id,class_id,seat_number,name,created_at,updated_at FROM students WHERE id=?1", [id], |row| Ok(Student { id: row.get(0)?, class_id: row.get(1)?, seat_number: row.get(2)?, name: row.get(3)?, created_at: row.get(4)?, updated_at: row.get(5)? })).optional()?)
    }
    pub fn list_by_class(database: &Database, class_id: &str) -> Result<Vec<Student>, AppError> {
        let connection = database.connection()?;
        let mut statement = connection.prepare("SELECT id,class_id,seat_number,name,created_at,updated_at FROM students WHERE class_id=?1 ORDER BY seat_number")?;
        let rows = statement
            .query_map([class_id], |row| {
                Ok(Student {
                    id: row.get(0)?,
                    class_id: row.get(1)?,
                    seat_number: row.get(2)?,
                    name: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn delete(database: &Database, id: &str) -> Result<(), AppError> {
        let connection = database.connection()?;
        if connection.execute("DELETE FROM students WHERE id=?1", [id])? == 0 {
            return Err(AppError::NotFound("student".to_owned()));
        }
        Ok(())
    }
}
use rusqlite::OptionalExtension;
