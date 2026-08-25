mod application;
mod error;
mod grading;
mod infrastructure;
mod question_domain;

use application::grouping::{CreateGroupPresetRequest, GroupingService, UpdateGroupPresetRequest};
use application::{
    CreateClassroomRequest, CreateCourseRequest, CreateLessonRequest, CreateQuestionRequest,
    CreateQuestionSetRequest, CreateQuestionWithDraftAssetsRequest, CreateStudentRequest,
    DeleteQuestionDraftAssetRequest, ImportQuestionAssetRequest, ImportQuestionDraftAssetRequest,
    LiveQuizService, LocalDatabaseStatus, LocalServerService, LocalServerStatus, LocalSessionDto,
    LocalSessionService, PersistenceService, ReorderQuestionsRequest, SessionHistoryDto,
    StatisticsService, UpdateClassroomRequest, UpdateCourseRequest, UpdateLessonRequest,
    UpdateQuestionAssetPageReferenceRequest, UpdateQuestionRequest, UpdateQuestionSetRequest,
    UpdateStudentRequest, DEFAULT_HISTORY_LIMIT,
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
        phase: "Phase 9",
    }
}

#[tauri::command]
fn get_local_database_status(
    state: tauri::State<'_, PersistenceService>,
) -> Result<LocalDatabaseStatus, AppError> {
    state.status()
}

#[tauri::command]
fn list_group_presets(
    classroom_id: String,
    grouping: tauri::State<'_, GroupingService>,
) -> Result<Vec<application::grouping::GroupPresetDto>, AppError> {
    grouping.list_presets(&classroom_id)
}

#[tauri::command]
fn get_group_preset(
    classroom_id: String,
    preset_id: String,
    grouping: tauri::State<'_, GroupingService>,
) -> Result<application::grouping::GroupPresetDetailDto, AppError> {
    grouping.get_preset_detail(&classroom_id, &preset_id)
}

#[tauri::command]
fn create_group_preset(
    request: CreateGroupPresetRequest,
    grouping: tauri::State<'_, GroupingService>,
) -> Result<application::grouping::GroupPresetDetailDto, AppError> {
    grouping.create_preset(request)
}

#[tauri::command]
fn update_group_preset(
    request: UpdateGroupPresetRequest,
    grouping: tauri::State<'_, GroupingService>,
) -> Result<application::grouping::GroupPresetDetailDto, AppError> {
    grouping.update_preset(request)
}

#[tauri::command]
fn delete_group_preset(
    classroom_id: String,
    preset_id: String,
    grouping: tauri::State<'_, GroupingService>,
) -> Result<(), AppError> {
    grouping.delete_preset(&classroom_id, &preset_id)
}

#[tauri::command]
async fn start_local_server(
    state: tauri::State<'_, LocalServerService>,
) -> Result<LocalServerStatus, AppError> {
    state.start().await
}

#[tauri::command]
async fn stop_local_server(
    state: tauri::State<'_, LocalServerService>,
) -> Result<LocalServerStatus, AppError> {
    state.stop().await
}

#[tauri::command]
fn get_local_server_status(
    state: tauri::State<'_, LocalServerService>,
) -> Result<LocalServerStatus, AppError> {
    state.status()
}

#[tauri::command]
fn create_local_session(
    classroom_id: String,
    sessions: tauri::State<'_, std::sync::Arc<LocalSessionService>>,
    server: tauri::State<'_, LocalServerService>,
) -> Result<LocalSessionDto, AppError> {
    let status = server.status()?;
    let Some(server_instance_id) = status.server_instance_id else {
        return Err(AppError::ServerStartFailed);
    };
    sessions.create(classroom_id, server_instance_id)
}

#[tauri::command]
fn open_local_session_lobby(
    session_id: String,
    sessions: tauri::State<'_, std::sync::Arc<LocalSessionService>>,
    server: tauri::State<'_, LocalServerService>,
) -> Result<LocalSessionDto, AppError> {
    let status = server.status()?;
    let Some(server_instance_id) = status.server_instance_id else {
        return Err(AppError::ServerStartFailed);
    };
    sessions.open_lobby(session_id, server_instance_id)
}

#[tauri::command]
fn start_local_session(
    session_id: String,
    sessions: tauri::State<'_, std::sync::Arc<LocalSessionService>>,
    server: tauri::State<'_, LocalServerService>,
) -> Result<LocalSessionDto, AppError> {
    let status = server.status()?;
    let Some(server_instance_id) = status.server_instance_id else {
        return Err(AppError::ServerStartFailed);
    };
    sessions.start(session_id, server_instance_id)
}

#[tauri::command]
fn publish_session_question(
    session_id: String,
    source_question_id: String,
    quiz: tauri::State<'_, std::sync::Arc<LiveQuizService>>,
) -> Result<application::SessionQuestionDto, AppError> {
    quiz.publish(session_id, source_question_id)
}
#[tauri::command]
fn list_session_questions(
    session_id: String,
    quiz: tauri::State<'_, std::sync::Arc<LiveQuizService>>,
) -> Result<Vec<application::SessionQuestionDto>, AppError> {
    quiz.list(session_id)
}
#[tauri::command]
fn open_session_question(
    session_question_id: String,
    quiz: tauri::State<'_, std::sync::Arc<LiveQuizService>>,
) -> Result<application::SessionQuestionDto, AppError> {
    quiz.open(session_question_id)
}
#[tauri::command]
fn lock_session_question(
    session_question_id: String,
    quiz: tauri::State<'_, std::sync::Arc<LiveQuizService>>,
) -> Result<application::SessionQuestionDto, AppError> {
    quiz.lock(session_question_id)
}
#[tauri::command]
fn reopen_session_question(
    session_question_id: String,
    quiz: tauri::State<'_, std::sync::Arc<LiveQuizService>>,
) -> Result<application::SessionQuestionDto, AppError> {
    quiz.reopen(session_question_id)
}
#[tauri::command]
fn reveal_session_question(
    session_question_id: String,
    quiz: tauri::State<'_, std::sync::Arc<LiveQuizService>>,
) -> Result<application::SessionQuestionDto, AppError> {
    quiz.reveal(session_question_id)
}
#[tauri::command]
fn get_session_question_progress(
    session_question_id: String,
    session_id: String,
    quiz: tauri::State<'_, std::sync::Arc<LiveQuizService>>,
    sessions: tauri::State<'_, std::sync::Arc<LocalSessionService>>,
) -> Result<application::TeacherQuestionProgressDto, AppError> {
    quiz.teacher_progress(
        session_question_id,
        sessions.list_participants(&session_id)?.len(),
    )
}

#[tauri::command]
fn get_question_statistics(
    session_id: String,
    session_question_id: String,
    statistics: tauri::State<'_, std::sync::Arc<StatisticsService>>,
) -> Result<application::QuestionStatisticsDto, AppError> {
    statistics.question_statistics(&session_id, &session_question_id)
}

#[tauri::command]
fn list_question_statistics(
    session_id: String,
    statistics: tauri::State<'_, std::sync::Arc<StatisticsService>>,
) -> Result<Vec<application::QuestionStatisticsDto>, AppError> {
    statistics.list_question_statistics(&session_id)
}

#[tauri::command]
fn get_participant_session_statistics(
    session_id: String,
    participant_id: String,
    statistics: tauri::State<'_, std::sync::Arc<StatisticsService>>,
) -> Result<application::ParticipantSessionStatisticsDto, AppError> {
    statistics.participant_statistics(&session_id, &participant_id)
}

#[tauri::command]
fn get_session_statistics(
    session_id: String,
    statistics: tauri::State<'_, std::sync::Arc<StatisticsService>>,
) -> Result<application::SessionStatisticsDto, AppError> {
    statistics.session_statistics(&session_id)
}

#[tauri::command]
fn get_difficult_questions(
    session_id: String,
    statistics: tauri::State<'_, std::sync::Arc<StatisticsService>>,
) -> Result<Vec<application::QuestionDifficultyDto>, AppError> {
    statistics.difficult_questions(&session_id)
}

#[tauri::command]
fn get_active_local_session(
    sessions: tauri::State<'_, std::sync::Arc<LocalSessionService>>,
) -> Result<Option<LocalSessionDto>, AppError> {
    sessions.active()
}

#[tauri::command]
fn list_classroom_session_history(
    classroom_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
    sessions: tauri::State<'_, std::sync::Arc<LocalSessionService>>,
) -> Result<Vec<SessionHistoryDto>, AppError> {
    sessions.list_history(
        classroom_id,
        limit.unwrap_or(DEFAULT_HISTORY_LIMIT),
        offset.unwrap_or(0),
    )
}

#[tauri::command]
fn end_local_session(
    session_id: String,
    sessions: tauri::State<'_, std::sync::Arc<LocalSessionService>>,
) -> Result<LocalSessionDto, AppError> {
    sessions.end(session_id, "teacher_ended")
}

#[tauri::command]
fn list_local_session_participants(
    session_id: String,
    sessions: tauri::State<'_, std::sync::Arc<LocalSessionService>>,
    server: tauri::State<'_, LocalServerService>,
) -> Result<Vec<application::TeacherParticipantDto>, AppError> {
    let mut participants = sessions.list_participants(&session_id)?;
    for participant in &mut participants {
        participant.online = server.is_participant_online(&participant.participant_id);
    }
    Ok(participants)
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
fn list_all_lessons(
    state: tauri::State<'_, PersistenceService>,
) -> Result<Vec<application::LessonDto>, AppError> {
    state.list_all_lessons()
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
fn create_question_with_draft_assets(
    state: tauri::State<'_, PersistenceService>,
    request: CreateQuestionWithDraftAssetsRequest,
) -> Result<application::QuestionDto, AppError> {
    state.create_question_with_draft_assets(request)
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
#[tauri::command]
fn reorder_questions(
    state: tauri::State<'_, PersistenceService>,
    request: ReorderQuestionsRequest,
) -> Result<Vec<application::QuestionDto>, AppError> {
    state.reorder_questions(request)
}

#[tauri::command]
fn list_question_assets(
    state: tauri::State<'_, PersistenceService>,
    question_id: String,
) -> Result<Vec<application::QuestionAssetDto>, AppError> {
    state.list_question_assets(question_id)
}

#[tauri::command]
fn import_question_asset(
    state: tauri::State<'_, PersistenceService>,
    request: ImportQuestionAssetRequest,
) -> Result<application::QuestionAssetDto, AppError> {
    state.import_question_asset(request)
}

#[tauri::command]
fn create_question_draft(
    state: tauri::State<'_, PersistenceService>,
) -> Result<application::QuestionDraftDto, AppError> {
    state.create_question_draft()
}

#[tauri::command]
fn import_question_draft_asset(
    state: tauri::State<'_, PersistenceService>,
    request: ImportQuestionDraftAssetRequest,
) -> Result<application::DraftQuestionAssetDto, AppError> {
    state.import_question_draft_asset(request)
}

#[tauri::command]
fn delete_question_draft_asset(
    state: tauri::State<'_, PersistenceService>,
    request: DeleteQuestionDraftAssetRequest,
) -> Result<(), AppError> {
    state.delete_question_draft_asset(request)
}

#[tauri::command]
fn discard_question_draft(
    state: tauri::State<'_, PersistenceService>,
    draft_id: String,
) -> Result<(), AppError> {
    state.discard_question_draft(draft_id)
}

#[tauri::command]
fn delete_question_asset(
    state: tauri::State<'_, PersistenceService>,
    asset_id: String,
) -> Result<(), AppError> {
    state.delete_question_asset(asset_id)
}

#[tauri::command]
fn get_question_asset_preview(
    state: tauri::State<'_, PersistenceService>,
    asset_id: String,
) -> Result<application::QuestionAssetPreviewDto, AppError> {
    state.get_question_asset_preview(asset_id)
}

#[tauri::command]
fn update_question_asset_page_reference(
    state: tauri::State<'_, PersistenceService>,
    asset_id: String,
    request: UpdateQuestionAssetPageReferenceRequest,
) -> Result<application::QuestionAssetDto, AppError> {
    state.update_question_asset_page_reference(asset_id, request)
}

pub fn run() -> Result<(), String> {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| AppError::Initialization(error.to_string()))?;
            let service = PersistenceService::initialize(&app_data_dir)?;
            let sessions = LocalSessionService::initialize(service.database_for_local_session())?;
            let quiz =
                LiveQuizService::initialize(service.database_for_local_session(), app_data_dir)?;
            let statistics = std::sync::Arc::new(StatisticsService::initialize(
                service.database_for_local_session(),
            ));
            let grouping = GroupingService::initialize(service.database_for_local_session());
            let student_assets =
                application::StudentAssetLocation::development_or_bundle(app.handle())?;
            app.manage(LocalServerService::new(
                std::sync::Arc::clone(&sessions),
                std::sync::Arc::clone(&quiz),
                student_assets,
            ));
            app.manage(quiz);
            app.manage(sessions);
            app.manage(statistics);
            app.manage(grouping);
            app.manage(service);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_runtime_info,
            get_local_database_status,
            list_group_presets,
            get_group_preset,
            create_group_preset,
            update_group_preset,
            delete_group_preset,
            start_local_server,
            stop_local_server,
            get_local_server_status,
            create_local_session,
            open_local_session_lobby,
            start_local_session,
            get_active_local_session,
            list_classroom_session_history,
            end_local_session,
            list_local_session_participants,
            publish_session_question,
            list_session_questions,
            open_session_question,
            lock_session_question,
            reopen_session_question,
            reveal_session_question,
            get_session_question_progress,
            get_question_statistics,
            list_question_statistics,
            get_participant_session_statistics,
            get_session_statistics,
            get_difficult_questions,
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
            list_all_lessons,
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
            create_question_with_draft_assets,
            update_question,
            delete_question,
            reorder_questions,
            list_question_assets,
            import_question_asset,
            create_question_draft,
            import_question_draft_asset,
            delete_question_draft_asset,
            discard_question_draft,
            delete_question_asset,
            get_question_asset_preview,
            update_question_asset_page_reference
        ])
        .build(tauri::generate_context!())
        .map_err(|error| error.to_string())?;
    application.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            let sessions = app.state::<std::sync::Arc<LocalSessionService>>();
            if sessions.end_active_for_exit().is_err() {
                eprintln!("Local session shutdown failed during application exit.");
            }
            let server = app.state::<LocalServerService>();
            if tauri::async_runtime::block_on(server.stop()).is_err() {
                eprintln!("Local server shutdown failed during application exit.");
            }
        }
    });
    Ok(())
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
            phase: "Phase 9",
        };
        assert_eq!(info.app_name, "Classroom");
        assert_eq!(info.phase, "Phase 9");
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
