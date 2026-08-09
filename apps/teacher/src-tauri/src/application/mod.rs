use std::path::Path;

use serde::Serialize;

use crate::error::AppError;
use crate::infrastructure::persistence::database::{Database, DatabaseStatus};
use crate::infrastructure::persistence::repositories::{Classroom, ClassroomRepository};

pub struct PersistenceService {
    database: Database,
}

impl PersistenceService {
    pub fn initialize(app_data_dir: impl AsRef<Path>) -> Result<Self, AppError> {
        let database = Database::open_in_app_data(app_data_dir)?;
        database.initialize()?;
        Ok(Self { database })
    }

    pub fn status(&self) -> Result<LocalDatabaseStatus, AppError> {
        let status = self.database.status()?;
        Ok(LocalDatabaseStatus::from(status))
    }

    pub fn list_classrooms(&self) -> Result<Vec<Classroom>, AppError> {
        ClassroomRepository::list(&self.database)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalDatabaseStatus {
    pub database_open: bool,
    pub schema_version: i64,
    pub path_classification: &'static str,
}

impl From<DatabaseStatus> for LocalDatabaseStatus {
    fn from(value: DatabaseStatus) -> Self {
        Self {
            database_open: value.database_open,
            schema_version: value.schema_version,
            path_classification: "app_data",
        }
    }
}
