use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::error::AppError;

use super::migrations;

#[derive(Debug, Clone)]
pub struct Database {
    path: PathBuf,
}

#[derive(Debug, Clone, Copy)]
pub struct DatabaseStatus {
    pub database_open: bool,
    pub schema_version: i64,
}

impl Database {
    pub fn open_in_app_data(app_data_dir: impl AsRef<Path>) -> Result<Self, AppError> {
        let directory = app_data_dir.as_ref();
        fs::create_dir_all(directory)?;
        Ok(Self {
            path: directory.join("classroom.sqlite3"),
        })
    }

    pub fn open(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn connection(&self) -> Result<Connection, AppError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )?;
        configure_connection(&connection)?;
        Ok(connection)
    }

    pub fn initialize(&self) -> Result<(), AppError> {
        let mut connection = self.connection()?;
        migrations::run(&mut connection)?;
        migrations::verify(&connection)
    }

    pub fn status(&self) -> Result<DatabaseStatus, AppError> {
        let connection = self.connection()?;
        migrations::verify(&connection)?;
        Ok(DatabaseStatus {
            database_open: true,
            schema_version: migrations::current_version(&connection)?,
        })
    }
}

fn configure_connection(connection: &Connection) -> Result<(), AppError> {
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Database;

    #[test]
    fn configures_and_reopens_a_file_database() {
        let directory = tempfile::tempdir().expect("temp directory");
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database.initialize().expect("database initializes");
        let reopened = Database::open(directory.path().join("classroom.sqlite3"));
        reopened.initialize().expect("database reopens");
        assert_eq!(reopened.status().expect("status").schema_version, 5);
    }
}
