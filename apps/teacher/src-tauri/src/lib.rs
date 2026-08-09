mod application;
mod error;
mod infrastructure;

use application::{LocalDatabaseStatus, PersistenceService};
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
        phase: "Phase 2",
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
) -> Result<Vec<infrastructure::persistence::repositories::Classroom>, AppError> {
    state.list_classrooms()
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
            list_classrooms
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
            phase: "Phase 2",
        };
        assert_eq!(info.app_name, "Classroom");
        assert_eq!(info.phase, "Phase 2");
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
