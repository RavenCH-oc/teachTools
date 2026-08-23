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
    #[error("unsupported media type")]
    UnsupportedMediaType,
    #[error("file exceeds the supported size limit")]
    FileTooLarge,
    #[error("managed asset is missing")]
    AssetMissing,
    #[error("managed asset failed its integrity check")]
    AssetCorrupted,
    #[error("database operation failed")]
    Storage,
    #[error("database migration failed")]
    MigrationFailed(String),
    #[error("application initialization failed")]
    Initialization(String),
    #[error("local server could not bind")]
    ServerBindFailed,
    #[error("local server could not start")]
    ServerStartFailed,
    #[error("local server could not stop")]
    ServerShutdownFailed,
    #[error("local transport protocol error")]
    ProtocolError,
    #[error("local session not found")]
    SessionNotFound,
    #[error("local session is not open")]
    SessionNotOpen,
    #[error("local session server instance does not match")]
    ServerInstanceMismatch,
    #[error("local session join code is invalid")]
    JoinCodeInvalid,
    #[error("local session identity does not match")]
    IdentityMismatch,
    #[error("local session seat has already joined")]
    SeatAlreadyJoined,
    #[error("local session participant authentication failed")]
    AuthenticationFailed,
    #[error("live question is locked")]
    QuestionLocked,
    #[error("student static assets are unavailable")]
    StudentAssetsUnavailable,
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
            Self::UnsupportedMediaType => (
                "unsupported_media_type",
                "Only PNG, JPEG, WebP, and PDF files can be imported.",
                false,
            ),
            Self::FileTooLarge => (
                "file_too_large",
                "The selected file exceeds the supported size limit.",
                false,
            ),
            Self::AssetMissing => (
                "asset_missing",
                "The managed asset file is missing. You can remove the attachment and import it again.",
                false,
            ),
            Self::AssetCorrupted => (
                "asset_corrupted",
                "The managed asset file did not pass its integrity check. You can remove the attachment and import it again.",
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
            Self::ServerBindFailed => (
                "server_bind_failed",
                "The local classroom server could not start. Check that your network is available and try again.",
                true,
            ),
            Self::ServerStartFailed => (
                "server_start_failed",
                "The local classroom server could not be started.",
                true,
            ),
            Self::ServerShutdownFailed => (
                "server_shutdown_failed",
                "The local classroom server could not be stopped cleanly.",
                true,
            ),
            Self::ProtocolError => (
                "protocol_error",
                "The local transport message is invalid.",
                false,
            ),
            Self::SessionNotFound => ("session_not_found", "The classroom session was not found.", false),
            Self::SessionNotOpen => ("session_not_open", "The classroom lobby is not open.", false),
            Self::ServerInstanceMismatch => (
                "server_instance_mismatch",
                "The classroom server has changed. Refresh the session and try again.",
                false,
            ),
            Self::JoinCodeInvalid => ("join_code_invalid", "The classroom code is invalid.", false),
            Self::IdentityMismatch => ("identity_mismatch", "The supplied identity does not match.", false),
            Self::SeatAlreadyJoined => ("seat_already_joined", "This seat has already joined the classroom.", false),
            Self::AuthenticationFailed => ("authentication_failed", "Participant authentication failed.", false),
            Self::QuestionLocked => ("question_locked", "The question is no longer accepting answers.", false),
            Self::StudentAssetsUnavailable => (
                "student_assets_unavailable",
                "The student application is not available. Build it before starting the local server.",
                true,
            ),
        };
        state.serialize_field("code", code)?;
        state.serialize_field("message", message)?;
        state.serialize_field("retryable", &retryable)?;
        state.end()
    }
}
