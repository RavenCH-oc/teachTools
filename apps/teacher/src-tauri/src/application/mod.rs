use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::infrastructure::persistence::database::{Database, DatabaseStatus};
use crate::infrastructure::persistence::repositories::{
    Classroom, ClassroomRepository, Course, CourseRepository, Lesson, LessonRepository,
    NewClassroom, NewCourse, NewLesson, NewStudent, Student, StudentRepository,
};
mod assets;
pub(crate) mod grouping;
mod live_quiz;
mod local_server;
mod local_session;
pub mod peer_review;
pub(crate) mod peer_review_monitor;
pub(crate) mod peer_review_setup;
pub(crate) mod peer_review_student;
mod questions;
pub(crate) mod session_report;
mod session_report_xlsx;
mod statistics;
mod student_assets;
pub use assets::{
    DeleteQuestionDraftAssetRequest, DraftQuestionAssetDto, ImportQuestionAssetRequest,
    ImportQuestionDraftAssetRequest, QuestionAssetDto, QuestionAssetPreviewDto, QuestionDraftDto,
    UpdateQuestionAssetPageReferenceRequest,
};
pub use live_quiz::{
    LiveQuizService, OwnSubmissionResultDto, QuestionPublicView, QuestionRevealView,
    SessionQuestionDto, SessionSyncDto, SubmissionAckDto, TeacherQuestionProgressDto,
};
pub use local_server::{LocalServerService, LocalServerStatus};
pub use local_session::{
    LocalSessionDto, LocalSessionService, ParticipantSelfView, SessionHistoryDto,
    TeacherParticipantDto, DEFAULT_HISTORY_LIMIT,
};
pub use questions::{
    CreateQuestionRequest, CreateQuestionSetRequest, CreateQuestionWithDraftAssetsRequest,
    QuestionDto, QuestionSetDto, ReorderQuestionsRequest, UpdateQuestionRequest,
    UpdateQuestionSetRequest,
};
pub use statistics::{
    ParticipantSessionStatisticsDto, QuestionDifficultyDto, QuestionStatisticsDto,
    SessionStatisticsDto, StatisticsService,
};
pub use student_assets::StudentAssetLocation;
pub(crate) use student_assets::StudentAssetProvider;

pub struct PersistenceService {
    database: Database,
    assets: assets::AssetService,
}

impl PersistenceService {
    pub fn initialize(app_data_dir: impl AsRef<Path>) -> Result<Self, AppError> {
        let app_data_dir = app_data_dir.as_ref();
        let database = Database::open_in_app_data(app_data_dir)?;
        database.initialize()?;
        let assets = assets::AssetService::initialize(database.clone(), app_data_dir)?;
        Ok(Self { database, assets })
    }
    pub fn status(&self) -> Result<LocalDatabaseStatus, AppError> {
        Ok(LocalDatabaseStatus::from(self.database.status()?))
    }
    pub fn list_classrooms(&self) -> Result<Vec<ClassroomDto>, AppError> {
        Ok(ClassroomRepository::list(&self.database)?
            .into_iter()
            .map(Into::into)
            .collect())
    }
    pub fn create_classroom(
        &self,
        request: CreateClassroomRequest,
    ) -> Result<ClassroomDto, AppError> {
        Ok(ClassroomRepository::create(
            &self.database,
            NewClassroom {
                name: request.name.trim().to_owned(),
                academic_year: clean_optional(request.academic_year),
            },
        )?
        .into())
    }
    pub fn update_classroom(
        &self,
        id: String,
        request: UpdateClassroomRequest,
    ) -> Result<ClassroomDto, AppError> {
        Ok(ClassroomRepository::update(
            &self.database,
            &id,
            request.name.trim().to_owned(),
            clean_optional(request.academic_year),
        )?
        .into())
    }
    pub fn delete_classroom(&self, id: String) -> Result<(), AppError> {
        ClassroomRepository::delete(&self.database, &id)
    }
    pub fn list_students(&self, class_id: String) -> Result<Vec<StudentDto>, AppError> {
        Ok(StudentRepository::list_by_class(&self.database, &class_id)?
            .into_iter()
            .map(Into::into)
            .collect())
    }
    pub fn create_student(&self, request: CreateStudentRequest) -> Result<StudentDto, AppError> {
        Ok(StudentRepository::create(
            &self.database,
            NewStudent {
                class_id: request.class_id,
                seat_number: request.seat_number,
                name: request.name.trim().to_owned(),
            },
        )?
        .into())
    }
    pub fn update_student(
        &self,
        id: String,
        request: UpdateStudentRequest,
    ) -> Result<StudentDto, AppError> {
        Ok(StudentRepository::update(
            &self.database,
            &id,
            request.seat_number,
            request.name.trim().to_owned(),
        )?
        .into())
    }
    pub fn delete_student(&self, id: String) -> Result<(), AppError> {
        StudentRepository::delete(&self.database, &id)
    }
    pub fn list_courses(&self) -> Result<Vec<CourseDto>, AppError> {
        Ok(CourseRepository::list(&self.database)?
            .into_iter()
            .map(Into::into)
            .collect())
    }
    pub fn create_course(&self, request: CreateCourseRequest) -> Result<CourseDto, AppError> {
        Ok(CourseRepository::create(
            &self.database,
            NewCourse {
                name: request.name.trim().to_owned(),
                description: clean_optional(request.description),
            },
        )?
        .into())
    }
    pub fn update_course(
        &self,
        id: String,
        request: UpdateCourseRequest,
    ) -> Result<CourseDto, AppError> {
        Ok(CourseRepository::update(
            &self.database,
            &id,
            request.name.trim().to_owned(),
            clean_optional(request.description),
        )?
        .into())
    }
    pub fn delete_course(&self, id: String) -> Result<(), AppError> {
        CourseRepository::delete(&self.database, &id)
    }
    pub fn list_lessons(&self, course_id: String) -> Result<Vec<LessonDto>, AppError> {
        Ok(
            LessonRepository::list_by_course(&self.database, &course_id)?
                .into_iter()
                .map(Into::into)
                .collect(),
        )
    }
    pub fn list_all_lessons(&self) -> Result<Vec<LessonDto>, AppError> {
        Ok(LessonRepository::list_all(&self.database)?
            .into_iter()
            .map(Into::into)
            .collect())
    }
    pub fn create_lesson(&self, request: CreateLessonRequest) -> Result<LessonDto, AppError> {
        Ok(LessonRepository::create(
            &self.database,
            NewLesson {
                course_id: request.course_id,
                title: request.title.trim().to_owned(),
                description: clean_optional(request.description),
                content_metadata: serde_json::json!({}),
                position: request.position,
            },
        )?
        .into())
    }
    pub fn update_lesson(
        &self,
        id: String,
        request: UpdateLessonRequest,
    ) -> Result<LessonDto, AppError> {
        Ok(LessonRepository::update(
            &self.database,
            &id,
            request.title.trim().to_owned(),
            clean_optional(request.description),
            request.position,
        )?
        .into())
    }
    pub fn delete_lesson(&self, id: String) -> Result<(), AppError> {
        LessonRepository::delete(&self.database, &id)
    }
    pub fn list_question_assets(
        &self,
        question_id: String,
    ) -> Result<Vec<QuestionAssetDto>, AppError> {
        self.assets.list_by_question(question_id)
    }
    pub fn import_question_asset(
        &self,
        request: ImportQuestionAssetRequest,
    ) -> Result<QuestionAssetDto, AppError> {
        self.assets.import(request)
    }
    pub fn create_question_draft(&self) -> Result<QuestionDraftDto, AppError> {
        self.assets.create_draft()
    }
    pub fn import_question_draft_asset(
        &self,
        request: ImportQuestionDraftAssetRequest,
    ) -> Result<DraftQuestionAssetDto, AppError> {
        self.assets.import_draft(request)
    }
    pub fn delete_question_draft_asset(
        &self,
        request: DeleteQuestionDraftAssetRequest,
    ) -> Result<(), AppError> {
        self.assets.delete_draft_asset(request)
    }
    pub fn discard_question_draft(&self, draft_id: String) -> Result<(), AppError> {
        self.assets.discard_draft(draft_id)
    }
    pub fn delete_question_asset(&self, asset_id: String) -> Result<(), AppError> {
        self.assets.delete(asset_id)
    }
    pub fn get_question_asset_preview(
        &self,
        asset_id: String,
    ) -> Result<QuestionAssetPreviewDto, AppError> {
        self.assets.get_preview(asset_id)
    }
    pub fn update_question_asset_page_reference(
        &self,
        asset_id: String,
        request: UpdateQuestionAssetPageReferenceRequest,
    ) -> Result<QuestionAssetDto, AppError> {
        self.assets.update_page_reference(asset_id, request)
    }
    pub(crate) fn delete_question_with_assets(&self, question_id: &str) -> Result<(), AppError> {
        self.assets.delete_question_with_assets(question_id)
    }
    pub(crate) fn database_for_local_session(&self) -> Database {
        self.database.clone()
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim().to_owned();
        (!trimmed.is_empty()).then_some(trimmed)
    })
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

#[derive(Debug, Clone, Deserialize)]
pub struct CreateClassroomRequest {
    pub name: String,
    pub academic_year: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateClassroomRequest {
    pub name: String,
    pub academic_year: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct ClassroomDto {
    pub id: String,
    pub name: String,
    pub academic_year: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Deserialize)]
pub struct CreateStudentRequest {
    pub class_id: String,
    pub seat_number: i64,
    pub name: String,
}
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateStudentRequest {
    pub seat_number: i64,
    pub name: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct StudentDto {
    pub id: String,
    pub class_id: String,
    pub seat_number: i64,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Deserialize)]
pub struct CreateCourseRequest {
    pub name: String,
    pub description: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateCourseRequest {
    pub name: String,
    pub description: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct CourseDto {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Deserialize)]
pub struct CreateLessonRequest {
    pub course_id: String,
    pub title: String,
    pub description: Option<String>,
    pub position: i64,
}
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateLessonRequest {
    pub title: String,
    pub description: Option<String>,
    pub position: i64,
}
#[derive(Debug, Clone, Serialize)]
pub struct LessonDto {
    pub id: String,
    pub course_id: String,
    pub title: String,
    pub description: Option<String>,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Classroom> for ClassroomDto {
    fn from(v: Classroom) -> Self {
        Self {
            id: v.id,
            name: v.name,
            academic_year: v.academic_year,
            created_at: v.created_at,
            updated_at: v.updated_at,
        }
    }
}
impl From<Student> for StudentDto {
    fn from(v: Student) -> Self {
        Self {
            id: v.id,
            class_id: v.class_id,
            seat_number: v.seat_number,
            name: v.name,
            created_at: v.created_at,
            updated_at: v.updated_at,
        }
    }
}
impl From<Course> for CourseDto {
    fn from(v: Course) -> Self {
        Self {
            id: v.id,
            name: v.name,
            description: v.description,
            created_at: v.created_at,
            updated_at: v.updated_at,
        }
    }
}
impl From<Lesson> for LessonDto {
    fn from(v: Lesson) -> Self {
        Self {
            id: v.id,
            course_id: v.course_id,
            title: v.title,
            description: v.description,
            position: v.position,
            created_at: v.created_at,
            updated_at: v.updated_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teacher_data_service_covers_crud_and_delete_conflicts() {
        let directory = tempfile::tempdir().expect("temp directory");
        let service = PersistenceService::initialize(directory.path()).expect("service");
        let classroom = service
            .create_classroom(CreateClassroomRequest {
                name: "  3A  ".to_owned(),
                academic_year: Some("2026".to_owned()),
            })
            .expect("classroom");
        assert_eq!(classroom.name, "3A");
        let classroom = service
            .update_classroom(
                classroom.id.clone(),
                UpdateClassroomRequest {
                    name: "3B".to_owned(),
                    academic_year: None,
                },
            )
            .expect("update classroom");
        let student = service
            .create_student(CreateStudentRequest {
                class_id: classroom.id.clone(),
                seat_number: 1,
                name: "Ada".to_owned(),
            })
            .expect("student");
        assert!(service
            .create_student(CreateStudentRequest {
                class_id: classroom.id.clone(),
                seat_number: 1,
                name: "Grace".to_owned()
            })
            .is_err());
        assert!(service.delete_classroom(classroom.id.clone()).is_err());
        let course = service
            .create_course(CreateCourseRequest {
                name: "Math".to_owned(),
                description: None,
            })
            .expect("course");
        let lesson = service
            .create_lesson(CreateLessonRequest {
                course_id: course.id.clone(),
                title: "Intro".to_owned(),
                description: None,
                position: 0,
            })
            .expect("lesson");
        assert!(service.delete_course(course.id.clone()).is_err());
        service.delete_lesson(lesson.id).expect("delete lesson");
        service.delete_course(course.id).expect("delete course");
        service.delete_student(student.id).expect("delete student");
        service
            .delete_classroom(classroom.id)
            .expect("delete classroom");
        assert!(service.list_classrooms().expect("list").is_empty());
    }
}
