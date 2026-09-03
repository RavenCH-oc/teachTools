use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::application::grouping::StudentGroupingViewDto;
use crate::error::AppError;
use crate::grading::{grade_question, GradeResult, GradingError};
use crate::infrastructure::persistence::database::Database;
use crate::infrastructure::persistence::repositories::{
    LiveQuizRepository, NewSessionQuestion, NewSessionQuestionAsset, NewSubmission,
    QuestionAssetRepository, QuestionRepository, SessionQuestionAssetRecord, SessionQuestionRecord,
    SubmissionRecord,
};
use crate::question_domain::{
    QuestionConfiguration, QuestionType, StudentAnswer, QUESTION_CONFIG_VERSION,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionQuestionDto {
    pub id: String,
    pub session_id: String,
    pub source_question_id: Option<String>,
    #[serde(rename = "type")]
    pub question_type: QuestionType,
    pub prompt: String,
    pub points: i64,
    pub position: i64,
    pub answer_config: QuestionConfiguration,
    pub grading_config: serde_json::Value,
    pub metadata: serde_json::Value,
    pub config_version: i64,
    pub state: String,
    pub created_at: String,
    pub opened_at: Option<String>,
    pub locked_at: Option<String>,
    pub revealed_at: Option<String>,
    pub assets: Vec<SessionQuestionAssetDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionQuestionAssetDto {
    pub id: String,
    pub asset_type: String,
    pub display_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub position: i64,
    pub page_reference: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPublicView {
    pub session_question_id: String,
    #[serde(rename = "type")]
    pub question_type: QuestionType,
    pub prompt: String,
    pub points: i64,
    pub state: String,
    pub options: Vec<PublicChoiceOption>,
    pub blanks: Vec<String>,
    pub assets: Vec<SessionQuestionAssetDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicChoiceOption {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRevealView {
    #[serde(flatten)]
    pub question: QuestionPublicView,
    pub correct_answer: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionAckDto {
    pub submission_id: String,
    pub session_question_id: String,
    pub revision: i64,
    pub accepted: bool,
    pub submitted_at: String,
    pub grading_status: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnSubmissionResultDto {
    pub submission_id: String,
    pub revision: i64,
    pub grading_status: String,
    pub is_correct: Option<bool>,
    pub score: Option<i64>,
    pub max_score: i64,
    pub answer: StudentAnswer,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSyncDto {
    pub session_state: String,
    pub current_question: Option<QuestionPublicView>,
    pub own_latest_submission: Option<OwnSubmissionResultDto>,
    pub reveal: Option<QuestionRevealView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grouping: Option<StudentGroupingViewDto>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeacherQuestionProgressDto {
    pub session_question_id: String,
    pub answered_count: usize,
    pub participant_count: usize,
    pub answered_participant_ids: Vec<String>,
}
#[derive(Debug, Clone)]
pub struct QuizEvent {
    pub session_id: String,
}

pub struct LiveQuizService {
    database: Database,
    app_data_dir: PathBuf,
    events: broadcast::Sender<QuizEvent>,
}

impl LiveQuizService {
    pub fn initialize(
        database: Database,
        app_data_dir: impl AsRef<Path>,
    ) -> Result<Arc<Self>, AppError> {
        let root = app_data_dir.as_ref().join("session-assets");
        fs::create_dir_all(&root).map_err(|_| AppError::Storage)?;
        let (events, _) = broadcast::channel(64);
        Ok(Arc::new(Self {
            database,
            app_data_dir: app_data_dir.as_ref().to_path_buf(),
            events,
        }))
    }

    pub fn publish(
        &self,
        session_id: String,
        source_question_id: String,
    ) -> Result<SessionQuestionDto, AppError> {
        let question = QuestionRepository::get(&self.database, &source_question_id)?
            .ok_or(AppError::NotFound("question".to_owned()))?;
        let question_type = parse_type(&question.question_type)?;
        let answer_config: QuestionConfiguration =
            serde_json::from_value(question.answer_config.clone())
                .map_err(|_| AppError::Storage)?;
        answer_config
            .validate_for(&question_type)
            .map_err(|_| AppError::Storage)?;
        if question.points <= 0 {
            return Err(AppError::Storage);
        }
        let id = Uuid::now_v7().to_string();
        let (assets, final_directory) = self.copy_assets(&session_id, &id, &source_question_id)?;
        let created = LiveQuizRepository::create_snapshot(
            &self.database,
            NewSessionQuestion {
                id: id.clone(),
                session_id,
                source_question_id,
                question_type: question.question_type,
                prompt: question.prompt,
                points: question.points,
                answer_config: question.answer_config,
                grading_config: question.grading_config,
                metadata: question.metadata,
                config_version: QUESTION_CONFIG_VERSION,
                assets,
            },
        );
        match created {
            Ok(record) => self.dto(record),
            Err(error) => {
                remove_tree(&final_directory);
                Err(error)
            }
        }
    }

    pub fn list(&self, session_id: String) -> Result<Vec<SessionQuestionDto>, AppError> {
        LiveQuizRepository::list_questions(&self.database, &session_id)?
            .into_iter()
            .map(|v| self.dto(v))
            .collect()
    }
    pub fn transition(&self, id: String, target: &str) -> Result<SessionQuestionDto, AppError> {
        let record = LiveQuizRepository::transition(&self.database, &id, target)?;
        let _ = self.events.send(QuizEvent {
            session_id: record.session_id.clone(),
        });
        self.dto(record)
    }
    pub fn open(&self, id: String) -> Result<SessionQuestionDto, AppError> {
        self.transition(id, "OPEN")
    }
    pub fn lock(&self, id: String) -> Result<SessionQuestionDto, AppError> {
        self.transition(id, "LOCKED")
    }
    pub fn reopen(&self, id: String) -> Result<SessionQuestionDto, AppError> {
        self.transition(id, "OPEN")
    }
    pub fn reveal(&self, id: String) -> Result<SessionQuestionDto, AppError> {
        self.transition(id, "REVEALED")
    }
    pub fn subscribe(&self) -> broadcast::Receiver<QuizEvent> {
        self.events.subscribe()
    }

    pub fn submit(
        &self,
        participant_id: String,
        session_id: String,
        question_id: String,
        submission_id: String,
        answer: StudentAnswer,
    ) -> Result<SubmissionAckDto, AppError> {
        parse_uuid(&submission_id)?;
        let question = LiveQuizRepository::get_question(&self.database, &question_id)?
            .ok_or(AppError::NotFound("session question".to_owned()))?;
        if question.session_id != session_id {
            return Err(AppError::AuthenticationFailed);
        }
        let (question_type, config) = snapshot_config(&question)?;
        let grade = grade_question(&question_type, &config, question.points, &answer)
            .map_err(map_grading_error)?;
        let (status, correct, score, max_score) = match grade {
            GradeResult::Graded {
                correct,
                score,
                max_score,
                ..
            } => ("graded".to_owned(), Some(correct), Some(score), max_score),
            GradeResult::Pending { max_score } => ("pending".to_owned(), None, None, max_score),
        };
        let (stored, _) = LiveQuizRepository::submit(
            &self.database,
            NewSubmission {
                id: submission_id,
                session_question_id: question_id,
                participant_id,
                answer_json: serde_json::to_value(answer)
                    .map_err(|_| AppError::Validation("invalid answer".to_owned()))?,
                grading_status: status,
                is_correct: correct,
                score,
                max_score,
            },
        )?;
        Ok(ack(stored))
    }

    pub fn sync(
        &self,
        participant_id: &str,
        session_id: &str,
        session_state: &str,
    ) -> Result<SessionSyncDto, AppError> {
        let Some(question) = LiveQuizRepository::current_visible(&self.database, session_id)?
        else {
            return Ok(SessionSyncDto {
                session_state: session_state.to_owned(),
                current_question: None,
                own_latest_submission: None,
                reveal: None,
                grouping: None,
            });
        };
        let public = self.public_view(&question)?;
        let latest =
            LiveQuizRepository::latest_submission(&self.database, &question.id, participant_id)?;
        let own = latest.clone().map(submission_result).transpose()?;
        let reveal = if question.state == "REVEALED" {
            Some(self.reveal_view(&question)?)
        } else {
            None
        };
        Ok(SessionSyncDto {
            session_state: session_state.to_owned(),
            current_question: Some(public),
            own_latest_submission: own,
            reveal,
            grouping: None,
        })
    }

    pub fn teacher_progress(
        &self,
        question_id: String,
        participant_count: usize,
    ) -> Result<TeacherQuestionProgressDto, AppError> {
        let answered = LiveQuizRepository::answered_participants(&self.database, &question_id)?;
        Ok(TeacherQuestionProgressDto {
            session_question_id: question_id,
            answered_count: answered.len(),
            participant_count,
            answered_participant_ids: answered,
        })
    }

    pub fn read_asset(&self, asset_id: &str) -> Result<(Vec<u8>, String), AppError> {
        let asset = LiveQuizRepository::get_asset(&self.database, asset_id)?
            .ok_or(AppError::NotFound("session asset".to_owned()))?;
        let path = self.resolve_session_path(&asset.storage_path)?;
        let bytes = fs::read(&path).map_err(|_| AppError::AssetMissing)?;
        if hash_bytes(&bytes) != asset.sha256 {
            return Err(AppError::AssetCorrupted);
        }
        Ok((bytes, asset.mime_type))
    }
    pub fn read_asset_for_session(
        &self,
        asset_id: &str,
        session_id: &str,
    ) -> Result<(Vec<u8>, String), AppError> {
        let asset = LiveQuizRepository::get_asset(&self.database, asset_id)?
            .ok_or(AppError::NotFound("session asset".to_owned()))?;
        let question =
            LiveQuizRepository::get_question(&self.database, &asset.session_question_id)?
                .ok_or(AppError::NotFound("session question".to_owned()))?;
        if question.session_id != session_id
            || !matches!(question.state.as_str(), "OPEN" | "LOCKED" | "REVEALED")
        {
            return Err(AppError::AuthenticationFailed);
        }
        self.read_asset(asset_id)
    }

    fn dto(&self, record: SessionQuestionRecord) -> Result<SessionQuestionDto, AppError> {
        let (question_type, answer_config) = snapshot_config(&record)?;
        Ok(SessionQuestionDto {
            id: record.id.clone(),
            session_id: record.session_id,
            source_question_id: record.source_question_id,
            question_type,
            prompt: record.prompt,
            points: record.points,
            position: record.position,
            answer_config,
            grading_config: record.grading_config,
            metadata: record.metadata,
            config_version: record.config_version,
            state: record.state,
            created_at: record.created_at,
            opened_at: record.opened_at,
            locked_at: record.locked_at,
            revealed_at: record.revealed_at,
            assets: LiveQuizRepository::list_assets(&self.database, &record.id)?
                .into_iter()
                .map(asset_dto)
                .collect(),
        })
    }
    fn public_view(&self, record: &SessionQuestionRecord) -> Result<QuestionPublicView, AppError> {
        let (question_type, config) = snapshot_config(record)?;
        let (options, blanks) = match config {
            QuestionConfiguration::SingleChoice(v) => (
                v.options
                    .into_iter()
                    .map(|v| PublicChoiceOption {
                        id: v.id,
                        text: v.text,
                    })
                    .collect(),
                Vec::new(),
            ),
            QuestionConfiguration::MultipleChoice(v) => (
                v.options
                    .into_iter()
                    .map(|v| PublicChoiceOption {
                        id: v.id,
                        text: v.text,
                    })
                    .collect(),
                Vec::new(),
            ),
            QuestionConfiguration::FillBlank(v) => {
                (Vec::new(), v.blanks.into_iter().map(|v| v.id).collect())
            }
            _ => (Vec::new(), Vec::new()),
        };
        Ok(QuestionPublicView {
            session_question_id: record.id.clone(),
            question_type,
            prompt: record.prompt.clone(),
            points: record.points,
            state: record.state.clone(),
            options,
            blanks,
            assets: LiveQuizRepository::list_assets(&self.database, &record.id)?
                .into_iter()
                .map(asset_dto)
                .collect(),
        })
    }
    fn reveal_view(&self, record: &SessionQuestionRecord) -> Result<QuestionRevealView, AppError> {
        let (_, config) = snapshot_config(record)?;
        let correct_answer = match config {
            QuestionConfiguration::TrueFalse(v) => Some(serde_json::json!(v.correct_answer)),
            QuestionConfiguration::SingleChoice(v) => Some(serde_json::json!(v.correct_option_id)),
            QuestionConfiguration::MultipleChoice(v) => {
                Some(serde_json::json!(v.correct_option_ids))
            }
            QuestionConfiguration::FillBlank(v) => Some(serde_json::json!(v
                .blanks
                .into_iter()
                .map(|b| serde_json::json!({"id":b.id,"acceptedAnswers":b.accepted_answers}))
                .collect::<Vec<_>>())),
            QuestionConfiguration::Essay(_) => None,
        };
        Ok(QuestionRevealView {
            question: self.public_view(record)?,
            correct_answer,
        })
    }
    fn copy_assets(
        &self,
        session_id: &str,
        question_id: &str,
        source_question_id: &str,
    ) -> Result<(Vec<NewSessionQuestionAsset>, PathBuf), AppError> {
        let final_dir = self
            .app_data_dir
            .join("session-assets")
            .join(session_id)
            .join(question_id);
        let temp_dir = self
            .app_data_dir
            .join("session-assets")
            .join(session_id)
            .join(format!(".{question_id}.tmp"));
        remove_tree(&temp_dir);
        fs::create_dir_all(&temp_dir).map_err(|_| AppError::Storage)?;
        let source_assets =
            QuestionAssetRepository::list_by_question(&self.database, source_question_id)?;
        let mut copied = Vec::new();
        for source in source_assets {
            let extension = match Path::new(&source.storage_path)
                .extension()
                .and_then(|v| v.to_str())
            {
                Some(extension) => extension,
                None => {
                    remove_tree(&temp_dir);
                    return Err(AppError::AssetCorrupted);
                }
            };
            let id = Uuid::now_v7().to_string();
            let source_path = match self.resolve_source_path(&source.storage_path) {
                Ok(path) => path,
                Err(error) => {
                    remove_tree(&temp_dir);
                    return Err(error);
                }
            };
            let destination = temp_dir.join(format!("{id}.{extension}"));
            let (size, sha) = match copy_with_hash(&source_path, &destination) {
                Ok(value) => value,
                Err(error) => {
                    remove_tree(&temp_dir);
                    return Err(error);
                }
            };
            if source.sha256.as_deref() != Some(sha.as_str()) || size != source.size_bytes {
                remove_tree(&temp_dir);
                return Err(AppError::AssetCorrupted);
            };
            copied.push(NewSessionQuestionAsset {
                id,
                source_asset_id: source.id,
                asset_type: source.asset_type,
                storage_path: format!(
                    "session-assets/{session_id}/{question_id}/{}.{}",
                    copied.len(),
                    extension
                ),
                display_name: source.display_name,
                mime_type: source.mime_type,
                size_bytes: size,
                sha256: sha,
                position: source.position,
                page_reference: source.page_reference,
            });
            let last = copied.last_mut().ok_or(AppError::Storage)?;
            last.storage_path = format!(
                "session-assets/{session_id}/{question_id}/{}.{}",
                last.id, extension
            );
            let actual = temp_dir.join(format!("{}.{}", last.id, extension));
            if actual != destination {
                fs::rename(destination, actual).map_err(|_| AppError::Storage)?;
            }
        }
        if fs::rename(&temp_dir, &final_dir).is_err() {
            remove_tree(&temp_dir);
            return Err(AppError::Storage);
        };
        Ok((copied, final_dir))
    }
    fn resolve_source_path(&self, storage: &str) -> Result<PathBuf, AppError> {
        let path = relative(storage)?;
        let full = self.app_data_dir.join(path);
        if !full.starts_with(self.app_data_dir.join("assets")) {
            return Err(AppError::AssetCorrupted);
        }
        Ok(full)
    }
    fn resolve_session_path(&self, storage: &str) -> Result<PathBuf, AppError> {
        let path = relative(storage)?;
        let full = self.app_data_dir.join(path);
        if !full.starts_with(self.app_data_dir.join("session-assets")) {
            return Err(AppError::AssetCorrupted);
        }
        Ok(full)
    }
}

fn relative(value: &str) -> Result<&Path, AppError> {
    let path = Path::new(value);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        Err(AppError::AssetCorrupted)
    } else {
        Ok(path)
    }
}
fn parse_type(raw: &str) -> Result<QuestionType, AppError> {
    serde_json::from_value(serde_json::Value::String(raw.to_owned())).map_err(|_| AppError::Storage)
}
fn snapshot_config(
    record: &SessionQuestionRecord,
) -> Result<(QuestionType, QuestionConfiguration), AppError> {
    let kind = parse_type(&record.question_type)?;
    if record.config_version != QUESTION_CONFIG_VERSION {
        return Err(AppError::Storage);
    }
    let config: QuestionConfiguration =
        serde_json::from_value(record.answer_config.clone()).map_err(|_| AppError::Storage)?;
    config.validate_for(&kind).map_err(|_| AppError::Storage)?;
    Ok((kind, config))
}
fn asset_dto(record: SessionQuestionAssetRecord) -> SessionQuestionAssetDto {
    SessionQuestionAssetDto {
        id: record.id,
        asset_type: record.asset_type,
        display_name: record.display_name,
        mime_type: record.mime_type,
        size_bytes: record.size_bytes,
        position: record.position,
        page_reference: record.page_reference,
    }
}
fn ack(value: SubmissionRecord) -> SubmissionAckDto {
    SubmissionAckDto {
        submission_id: value.id,
        session_question_id: value.session_question_id,
        revision: value.revision,
        accepted: true,
        submitted_at: value.submitted_at,
        grading_status: value.grading_status,
    }
}
fn submission_result(value: SubmissionRecord) -> Result<OwnSubmissionResultDto, AppError> {
    Ok(OwnSubmissionResultDto {
        submission_id: value.id,
        revision: value.revision,
        grading_status: value.grading_status,
        is_correct: value.is_correct,
        score: value.score,
        max_score: value.max_score,
        answer: serde_json::from_value(value.answer_json).map_err(|_| AppError::Storage)?,
    })
}
fn map_grading_error(_: GradingError) -> AppError {
    AppError::Validation("invalid answer".to_owned())
}
fn parse_uuid(id: &str) -> Result<(), AppError> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| AppError::Validation("submission ID must be a UUID".to_owned()))
}
fn copy_with_hash(from: &Path, to: &Path) -> Result<(i64, String), AppError> {
    let mut input = File::open(from).map_err(|_| AppError::AssetMissing)?;
    let mut output = File::create(to).map_err(|_| AppError::Storage)?;
    let mut hash = Sha256::new();
    let mut size = 0_i64;
    let mut buf = [0_u8; 8192];
    loop {
        let n = input.read(&mut buf).map_err(|_| AppError::Storage)?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n]).map_err(|_| AppError::Storage)?;
        hash.update(&buf[..n]);
        size += i64::try_from(n).map_err(|_| AppError::Storage)?;
    }
    Ok((size, format!("{:x}", hash.finalize())))
}
fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn remove_tree(path: &Path) {
    if path.exists() {
        let _ = fs::remove_dir_all(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::LocalSessionService;
    use crate::infrastructure::persistence::repositories::{
        ClassroomRepository, NewClassroom, NewQuestion, NewQuestionAsset, NewQuestionSet,
        NewStudent, QuestionAssetRepository, QuestionRepository, QuestionSetRepository,
        StudentRepository,
    };

    #[test]
    fn snapshot_submission_revisions_and_reveal_are_authoritative() {
        let directory = tempfile::tempdir().expect("directory");
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database.initialize().expect("database");
        let classroom = ClassroomRepository::create(
            &database,
            NewClassroom {
                name: "Class".to_owned(),
                academic_year: None,
            },
        )
        .expect("classroom");
        StudentRepository::create(
            &database,
            NewStudent {
                class_id: classroom.id.clone(),
                seat_number: 1,
                name: "Ada".to_owned(),
            },
        )
        .expect("student");
        let set = QuestionSetRepository::create(
            &database,
            NewQuestionSet {
                lesson_id: None,
                title: "Set".to_owned(),
                description: None,
            },
        )
        .expect("set");
        let source = QuestionRepository::create(
            &database,
            NewQuestion {
                question_set_id: set.id,
                question_type: "true_false".to_owned(),
                prompt: "Original".to_owned(),
                points: 2,
                position: 0,
                answer_config: serde_json::json!({"correctAnswer":true}),
                grading_config: serde_json::json!({}),
                metadata: serde_json::json!({}),
            },
        )
        .expect("question");
        let sessions = LocalSessionService::initialize(database.clone()).expect("sessions");
        let session = sessions
            .create(classroom.id, Uuid::now_v7().to_string())
            .expect("session");
        let lobby = sessions
            .open_lobby(session.id.clone(), session.server_instance_id.clone())
            .expect("lobby");
        let joined = sessions
            .join(&lobby.join_code, 1, "Ada", &lobby.server_instance_id)
            .expect("participant");
        sessions
            .start(lobby.id.clone(), lobby.server_instance_id)
            .expect("start");
        let quiz = LiveQuizService::initialize(database, directory.path()).expect("quiz");
        let snapshot = quiz.publish(lobby.id.clone(), source.id).expect("snapshot");
        assert_eq!(snapshot.state, "HIDDEN");
        assert_eq!(snapshot.prompt, "Original");
        let opened = quiz.open(snapshot.id.clone()).expect("open");
        assert_eq!(opened.state, "OPEN");
        let first = quiz
            .submit(
                joined.participant_id.clone(),
                lobby.id.clone(),
                opened.id.clone(),
                Uuid::now_v7().to_string(),
                StudentAnswer::TrueFalse { value: true },
            )
            .expect("first");
        assert_eq!(first.revision, 1);
        assert_eq!(first.grading_status, "graded");
        let retry = quiz
            .submit(
                joined.participant_id.clone(),
                lobby.id.clone(),
                opened.id.clone(),
                first.submission_id.clone(),
                StudentAnswer::TrueFalse { value: true },
            )
            .expect("retry");
        assert_eq!(retry.revision, 1);
        let second = quiz
            .submit(
                joined.participant_id.clone(),
                lobby.id.clone(),
                opened.id.clone(),
                Uuid::now_v7().to_string(),
                StudentAnswer::TrueFalse { value: false },
            )
            .expect("revision");
        assert_eq!(second.revision, 2);
        quiz.lock(opened.id.clone()).expect("lock");
        assert!(quiz
            .submit(
                joined.participant_id.clone(),
                lobby.id.clone(),
                opened.id.clone(),
                Uuid::now_v7().to_string(),
                StudentAnswer::TrueFalse { value: true }
            )
            .is_err());
        quiz.reveal(opened.id.clone()).expect("reveal");
        let sync = quiz
            .sync(&joined.participant_id, &lobby.id, "ACTIVE")
            .expect("sync");
        assert!(sync.reveal.is_some());
        assert_eq!(sync.own_latest_submission.expect("latest").revision, 2);
    }

    #[test]
    fn hidden_session_assets_are_not_available_until_question_opens() {
        let directory = tempfile::tempdir().expect("directory");
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database.initialize().expect("database");
        let classroom = ClassroomRepository::create(
            &database,
            NewClassroom {
                name: "Class".to_owned(),
                academic_year: None,
            },
        )
        .expect("classroom");
        let set = QuestionSetRepository::create(
            &database,
            NewQuestionSet {
                lesson_id: None,
                title: "Set".to_owned(),
                description: None,
            },
        )
        .expect("set");
        let source = QuestionRepository::create(
            &database,
            NewQuestion {
                question_set_id: set.id,
                question_type: "true_false".to_owned(),
                prompt: "With media".to_owned(),
                points: 1,
                position: 0,
                answer_config: serde_json::json!({"correctAnswer":true}),
                grading_config: serde_json::json!({}),
                metadata: serde_json::json!({}),
            },
        )
        .expect("question");
        let bytes = b"managed-session-media";
        let source_path = directory.path().join("assets").join("aa");
        fs::create_dir_all(&source_path).expect("source directory");
        fs::write(source_path.join("asset.bin"), bytes).expect("source asset");
        QuestionAssetRepository::create(
            &database,
            NewQuestionAsset {
                id: Uuid::now_v7().to_string(),
                question_id: source.id.clone(),
                asset_type: "image".to_owned(),
                storage_path: "assets/aa/asset.bin".to_owned(),
                display_name: "asset".to_owned(),
                mime_type: "image/png".to_owned(),
                size_bytes: bytes.len() as i64,
                sha256: hash_bytes(bytes),
                position: 0,
                page_reference: None,
            },
        )
        .expect("source asset row");
        let sessions = LocalSessionService::initialize(database.clone()).expect("sessions");
        let session = sessions
            .create(classroom.id, Uuid::now_v7().to_string())
            .expect("session");
        let lobby = sessions
            .open_lobby(session.id.clone(), session.server_instance_id.clone())
            .expect("lobby");
        sessions
            .start(lobby.id.clone(), lobby.server_instance_id.clone())
            .expect("start");
        let quiz = LiveQuizService::initialize(database, directory.path()).expect("quiz");
        let snapshot = quiz.publish(lobby.id, source.id).expect("snapshot");
        let asset_id = snapshot.assets.first().expect("snapshot asset").id.clone();
        assert!(matches!(
            quiz.read_asset_for_session(&asset_id, &snapshot.session_id),
            Err(AppError::AuthenticationFailed)
        ));
        quiz.open(snapshot.id).expect("open");
        let (read, mime) = quiz
            .read_asset_for_session(&asset_id, &snapshot.session_id)
            .expect("opened asset");
        assert_eq!(read, bytes);
        assert_eq!(mime, "image/png");
    }
}
