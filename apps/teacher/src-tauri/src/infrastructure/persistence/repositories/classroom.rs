use rusqlite::params;
use serde::Serialize;

use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;

use super::{map_write_error, new_id, now_utc, validate_name};

#[derive(Debug, Clone, Serialize)]
pub struct Classroom {
    pub id: String,
    pub name: String,
    pub academic_year: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub struct NewClassroom {
    pub name: String,
    pub academic_year: Option<String>,
}

pub struct ClassroomRepository;

impl ClassroomRepository {
    pub fn create(database: &Database, input: NewClassroom) -> Result<Classroom, AppError> {
        validate_name(&input.name)?;
        let id = new_id();
        let now = now_utc();
        let connection = database.connection()?;
        connection.execute("INSERT INTO classes(id,name,academic_year,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)", params![id, input.name, input.academic_year, now]).map_err(map_write_error)?;
        Self::get(database, &id)?.ok_or(AppError::Storage)
    }

    pub fn get(database: &Database, id: &str) -> Result<Option<Classroom>, AppError> {
        let connection = database.connection()?;
        Ok(connection
            .query_row(
                "SELECT id,name,academic_year,created_at,updated_at FROM classes WHERE id=?1",
                [id],
                |row| {
                    Ok(Classroom {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        academic_year: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn list(database: &Database) -> Result<Vec<Classroom>, AppError> {
        let connection = database.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,name,academic_year,created_at,updated_at FROM classes ORDER BY name",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(Classroom {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    academic_year: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn update(
        database: &Database,
        id: &str,
        name: String,
        academic_year: Option<String>,
    ) -> Result<Classroom, AppError> {
        validate_name(&name)?;
        let connection = database.connection()?;
        let changed = connection.execute(
            "UPDATE classes SET name=?1,academic_year=?2,updated_at=?3 WHERE id=?4",
            params![name, academic_year, now_utc(), id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("classroom".to_owned()));
        }
        Self::get(database, id)?.ok_or(AppError::Storage)
    }

    pub fn delete(database: &Database, id: &str) -> Result<(), AppError> {
        let connection = database.connection()?;
        let changed = connection
            .execute("DELETE FROM classes WHERE id=?1", [id])
            .map_err(map_write_error)?;
        if changed == 0 {
            return Err(AppError::NotFound("classroom".to_owned()));
        }
        Ok(())
    }
}

use rusqlite::OptionalExtension;
