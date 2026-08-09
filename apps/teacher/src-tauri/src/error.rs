use serde::ser::{Serialize, SerializeStruct, Serializer};
use thiserror::Error;

#[allow(dead_code)]
#[derive(Debug, Error)]
pub enum AppError {
    #[error("invalid input")]
    Validation(String),
    #[error("resource not found")]
    NotFound(String),
    #[error("resource conflict")]
    Conflict(String),
    #[error("database operation failed")]
    Storage,
    #[error("database migration failed")]
    MigrationFailed(String),
    #[error("application initialization failed")]
    Initialization(String),
}

impl From<rusqlite::Error> for AppError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}

impl From<std::io::Error> for AppError {
    fn from(_: std::io::Error) -> Self {
        Self::Initialization("local database directory could not be prepared".to_owned())
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("AppError", 3)?;
        let (code, message, retryable) = match self {
            Self::Validation(_) => ("validation_error", "The supplied data is invalid.", false),
            Self::NotFound(_) => ("not_found", "The requested resource was not found.", false),
            Self::Conflict(_) => (
                "conflict",
                "The operation conflicts with existing data.",
                false,
            ),
            Self::Storage => (
                "storage_error",
                "The local database operation failed.",
                true,
            ),
            Self::MigrationFailed(_) => (
                "migration_error",
                "The local database could not be prepared.",
                false,
            ),
            Self::Initialization(_) => (
                "initialization_error",
                "The local database could not be initialized.",
                false,
            ),
        };
        state.serialize_field("code", code)?;
        state.serialize_field("message", message)?;
        state.serialize_field("retryable", &retryable)?;
        state.end()
    }
}
