pub(crate) mod classroom;
mod course;
mod lesson;
pub(crate) mod question;
pub(crate) mod question_asset;
pub(crate) mod question_set;
pub(crate) mod student;

pub use classroom::{Classroom, ClassroomRepository, NewClassroom};
pub use course::{Course, CourseRepository, NewCourse};
pub use lesson::{Lesson, LessonRepository, NewLesson};
pub use question::{NewQuestion, Question, QuestionRepository};
pub use question_asset::{NewQuestionAsset, QuestionAsset, QuestionAssetRepository};
pub use question_set::{NewQuestionSet, QuestionSet, QuestionSetRepository};
pub use student::{NewStudent, Student, StudentRepository};

use crate::error::AppError;

pub(crate) fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub(crate) fn now_utc() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

pub(crate) fn validate_name(name: &str) -> Result<(), AppError> {
    if name.trim().is_empty() {
        return Err(AppError::Validation("name must not be empty".to_owned()));
    }
    if name.trim().len() > 200 {
        return Err(AppError::Validation(
            "name must be at most 200 characters".to_owned(),
        ));
    }
    Ok(())
}

pub(crate) fn map_write_error(error: rusqlite::Error) -> AppError {
    match error {
        rusqlite::Error::SqliteFailure(ref failure, _)
            if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            AppError::Conflict("the operation conflicts with existing data".to_owned())
        }
        _ => AppError::Storage,
    }
}
