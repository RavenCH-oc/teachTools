mod application;
mod error;
mod grading;
mod infrastructure;
mod question_domain;

use application::{
    CreateClassroomRequest, CreateCourseRequest, CreateLessonRequest, CreateQuestionRequest,
    CreateQuestionSetRequest, CreateStudentRequest, LocalDatabaseStatus, PersistenceService,
    UpdateClassroomRequest, UpdateCourseRequest, UpdateLessonRequest, UpdateQuestionRequest,
    UpdateQuestionSetRequest, UpdateStudentRequest,
};
use error::AppError;
use serde::Serialize;
use tauri::Manager;

#[derive(Debug, Serialize)]
pub struct RuntimeInfo {
    pub app_name: &'static str,
    pub phase: &'static str,
}

#[tauri::command]
fn get_app_runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        app_name: "Classroom",
        phase: "Phase 4",
    }
}

#[tauri::command]
fn get_local_database_status(
    state: tauri::State<'_, PersistenceService>,
) -> Result<LocalDatabaseStatus, AppError> {
    state.status()
}

#[tauri::command]
fn list_classrooms(
    state: tauri::State<'_, PersistenceService>,
) -> Result<Vec<application::ClassroomDto>, AppError> {
    state.list_classrooms()
}
#[tauri::command]
fn create_classroom(
    state: tauri::State<'_, PersistenceService>,
    request: CreateClassroomRequest,
) -> Result<application::ClassroomDto, AppError> {
    state.create_classroom(request)
}
#[tauri::command]
fn update_classroom(
    state: tauri::State<'_, PersistenceService>,
    id: String,
    request: UpdateClassroomRequest,
) -> Result<application::ClassroomDto, AppError> {
    state.update_classroom(id, request)
}
#[tauri::command]
fn delete_classroom(
    state: tauri::State<'_, PersistenceService>,
    id: String,
) -> Result<(), AppError> {
    state.delete_classroom(id)
}
#[tauri::command]
fn list_students(
    state: tauri::State<'_, PersistenceService>,
    class_id: String,
) -> Result<Vec<application::StudentDto>, AppError> {
    state.list_students(class_id)
}
#[tauri::command]
fn create_student(
    state: tauri::State<'_, PersistenceService>,
    request: CreateStudentRequest,
) -> Result<application::StudentDto, AppError> {
    state.create_student(request)
}
#[tauri::command]
fn update_student(
    state: tauri::State<'_, PersistenceService>,
    id: String,
    request: UpdateStudentRequest,
) -> Result<application::StudentDto, AppError> {
    state.update_student(id, request)
}
#[tauri::command]
fn delete_student(state: tauri::State<'_, PersistenceService>, id: String) -> Result<(), AppError> {
    state.delete_student(id)
}
#[tauri::command]
fn list_courses(
    state: tauri::State<'_, PersistenceService>,
) -> Result<Vec<application::CourseDto>, AppError> {
    state.list_courses()
}
#[tauri::command]
fn create_course(
    state: tauri::State<'_, PersistenceService>,
    request: CreateCourseRequest,
) -> Result<application::CourseDto, AppError> {
    state.create_course(request)
}
#[tauri::command]
fn update_course(
    state: tauri::State<'_, PersistenceService>,
    id: String,
    request: UpdateCourseRequest,
) -> Result<application::CourseDto, AppError> {
    state.update_course(id, request)
}
#[tauri::command]
fn delete_course(state: tauri::State<'_, PersistenceService>, id: String) -> Result<(), AppError> {
    state.delete_course(id)
}
#[tauri::command]
fn list_lessons(
    state: tauri::State<'_, PersistenceService>,
    course_id: String,
) -> Result<Vec<application::LessonDto>, AppError> {
    state.list_lessons(course_id)
}
#[tauri::command]
fn create_lesson(
    state: tauri::State<'_, PersistenceService>,
    request: CreateLessonRequest,
) -> Result<application::LessonDto, AppError> {
    state.create_lesson(request)
}
#[tauri::command]
fn update_lesson(
    state: tauri::State<'_, PersistenceService>,
    id: String,
    request: UpdateLessonRequest,
) -> Result<application::LessonDto, AppError> {
    state.update_lesson(id, request)
}
#[tauri::command]
fn delete_lesson(state: tauri::State<'_, PersistenceService>, id: String) -> Result<(), AppError> {
    state.delete_lesson(id)
}

#[tauri::command]
fn list_question_sets(
    state: tauri::State<'_, PersistenceService>,
) -> Result<Vec<application::QuestionSetDto>, AppError> {
    state.list_question_sets()
}
#[tauri::command]
fn get_question_set(
    state: tauri::State<'_, PersistenceService>,
    id: String,
) -> Result<application::QuestionSetDto, AppError> {
    state.get_question_set(id)
}
#[tauri::command]
fn create_question_set(
    state: tauri::State<'_, PersistenceService>,
    request: CreateQuestionSetRequest,
) -> Result<application::QuestionSetDto, AppError> {
    state.create_question_set(request)
}
#[tauri::command]
fn update_question_set(
    state: tauri::State<'_, PersistenceService>,
    id: String,
    request: UpdateQuestionSetRequest,
) -> Result<application::QuestionSetDto, AppError> {
    state.update_question_set(id, request)
}
#[tauri::command]
fn delete_question_set(
    state: tauri::State<'_, PersistenceService>,
    id: String,
) -> Result<(), AppError> {
    state.delete_question_set(id)
}
#[tauri::command]
fn list_questions(
    state: tauri::State<'_, PersistenceService>,
    question_set_id: String,
) -> Result<Vec<application::QuestionDto>, AppError> {
    state.list_questions(question_set_id)
}
#[tauri::command]
fn get_question(
    state: tauri::State<'_, PersistenceService>,
    id: String,
) -> Result<application::QuestionDto, AppError> {
    state.get_question(id)
}
#[tauri::command]
fn create_question(
    state: tauri::State<'_, PersistenceService>,
    request: CreateQuestionRequest,
) -> Result<application::QuestionDto, AppError> {
    state.create_question(request)
}
#[tauri::command]
fn update_question(
    state: tauri::State<'_, PersistenceService>,
    id: String,
    request: UpdateQuestionRequest,
) -> Result<application::QuestionDto, AppError> {
    state.update_question(id, request)
}
#[tauri::command]
fn delete_question(
    state: tauri::State<'_, PersistenceService>,
    id: String,
) -> Result<(), AppError> {
    state.delete_question(id)
}

pub fn run() -> Result<(), String> {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| AppError::Initialization(error.to_string()))?;
            let service = PersistenceService::initialize(app_data_dir)?;
            app.manage(service);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_runtime_info,
            get_local_database_status,
            list_classrooms,
            create_classroom,
            update_classroom,
            delete_classroom,
            list_students,
            create_student,
            update_student,
            delete_student,
            list_courses,
            create_course,
            update_course,
            delete_course,
            list_lessons,
            create_lesson,
            update_lesson,
            delete_lesson,
            list_question_sets,
            get_question_set,
            create_question_set,
            update_question_set,
            delete_question_set,
            list_questions,
            get_question,
            create_question,
            update_question,
            delete_question
        ])
        .run(tauri::generate_context!())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::RuntimeInfo;
    use crate::infrastructure::persistence::database::Database;
    use crate::infrastructure::persistence::repositories::classroom::NewClassroom;
    use crate::infrastructure::persistence::repositories::question::{
        NewQuestion, QuestionRepository,
    };
    use crate::infrastructure::persistence::repositories::question_set::{
        NewQuestionSet, QuestionSetRepository,
    };
    use crate::infrastructure::persistence::repositories::student::{
        NewStudent, StudentRepository,
    };
    use crate::infrastructure::persistence::repositories::ClassroomRepository;

    #[test]
    fn runtime_info_has_the_phase_marker() {
        let info = RuntimeInfo {
            app_name: "Classroom",
            phase: "Phase 4",
        };
        assert_eq!(info.app_name, "Classroom");
        assert_eq!(info.phase, "Phase 4");
    }

    #[test]
    fn classroom_and_student_persistence_enforce_relationships() {
        let directory = tempfile::tempdir().expect("temp directory");
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database.initialize().expect("database initializes");
        let classroom = ClassroomRepository::create(
            &database,
            NewClassroom {
                name: "A".to_owned(),
                academic_year: Some("2026".to_owned()),
            },
        )
        .expect("classroom");
        let student = StudentRepository::create(
            &database,
            NewStudent {
                class_id: classroom.id.clone(),
                seat_number: 1,
                name: "Ada".to_owned(),
            },
        )
        .expect("student");
        assert_eq!(
            StudentRepository::list_by_class(&database, &classroom.id)
                .expect("students")
                .len(),
            1
        );
        assert!(StudentRepository::create(
            &database,
            NewStudent {
                class_id: classroom.id,
                seat_number: 1,
                name: "Grace".to_owned()
            }
        )
        .is_err());
        StudentRepository::delete(&database, &student.id).expect("delete");
    }

    #[test]
    fn an_uncommitted_transaction_rolls_back() {
        let directory = tempfile::tempdir().expect("temp directory");
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database.initialize().expect("database initializes");
        {
            let mut connection = database.connection().expect("connection");
            let transaction = connection.transaction().expect("transaction");
            transaction
                .execute(
                    "INSERT INTO classes(id,name,created_at,updated_at) VALUES ('rollback','Rollback','now','now')",
                    [],
                )
                .expect("insert");
        }
        assert!(ClassroomRepository::get(&database, "rollback")
            .expect("lookup")
            .is_none());
    }

    #[test]
    fn malformed_json_is_a_controlled_storage_error() {
        let directory = tempfile::tempdir().expect("temp directory");
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database.initialize().expect("database initializes");
        let connection = database.connection().expect("connection");
        connection
            .execute(
                "INSERT INTO question_sets(id,title,created_at,updated_at) VALUES ('set','Set','now','now')",
                [],
            )
            .expect("question set");
        connection
            .execute(
                "INSERT INTO questions(id,question_set_id,type,prompt,answer_config,grading_config,metadata,created_at,updated_at) VALUES ('question','set','essay','Prompt','{','{}','{}','now','now')",
                [],
            )
            .expect("question");
        assert!(QuestionRepository::get(&database, "question").is_err());
    }

    #[test]
    fn question_json_round_trips_without_loss() {
        let directory = tempfile::tempdir().expect("temp directory");
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database.initialize().expect("database initializes");
        let set = QuestionSetRepository::create(
            &database,
            NewQuestionSet {
                lesson_id: None,
                title: "Set".to_owned(),
                description: None,
            },
        )
        .expect("question set");
        let answer = serde_json::json!({"correct": ["A"], "version": 1});
        let question = QuestionRepository::create(
            &database,
            NewQuestion {
                question_set_id: set.id,
                question_type: "single_choice".to_owned(),
                prompt: "Prompt".to_owned(),
                points: 1,
                position: 0,
                answer_config: answer.clone(),
                grading_config: serde_json::json!({"mode": "exact"}),
                metadata: serde_json::json!({"source": "test"}),
            },
        )
        .expect("question");
        let loaded = QuestionRepository::get(&database, &question.id)
            .expect("lookup")
            .expect("question exists");
        assert_eq!(loaded.answer_config, answer);
    }
}
