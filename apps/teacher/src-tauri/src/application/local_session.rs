use std::sync::Arc;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use getrandom::fill as random_fill;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;
use crate::infrastructure::persistence::repositories::local_session::{
    LocalSessionRecord, LocalSessionRepository, NewLocalSession, NewParticipant, ParticipantRecord,
    SessionHistoryRecord,
};

pub const JOIN_CODE_LENGTH: usize = 8;
pub const JOIN_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionDto {
    pub id: String,
    pub classroom_id: String,
    pub classroom_name: String,
    pub server_instance_id: String,
    pub state: String,
    pub join_mode: String,
    pub join_code: String,
    pub created_at: String,
    pub lobby_opened_at: Option<String>,
    pub ended_at: Option<String>,
    pub ended_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHistoryDto {
    pub session_id: String,
    pub classroom_id: String,
    pub classroom_name: String,
    pub state: String,
    pub created_at: String,
    pub lobby_opened_at: Option<String>,
    pub ended_at: Option<String>,
    pub participant_count: i64,
    pub eligible_question_count: i64,
}

pub const DEFAULT_HISTORY_LIMIT: i64 = 30;
pub const MAX_HISTORY_LIMIT: i64 = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeacherParticipantDto {
    pub participant_id: String,
    pub student_id: Option<String>,
    pub seat_number: i64,
    pub display_name: String,
    pub joined_at: String,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPublicView {
    pub session_id: String,
    pub classroom_name: String,
    pub state: String,
    pub join_mode: String,
    pub server_instance_id: String,
    pub protocol_version: u8,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantSelfView {
    pub participant_id: String,
    pub session_id: String,
    pub seat_number: i64,
    pub display_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinSuccess {
    pub session_id: String,
    pub participant_id: String,
    pub credential: String,
    pub participant: ParticipantSelfView,
    pub server_instance_id: String,
}

#[derive(Clone)]
pub struct AuthenticatedParticipant {
    pub participant: ParticipantSelfView,
    pub classroom_name: String,
    pub session_state: String,
}

#[derive(Debug, Clone)]
pub struct SessionStateChanged {
    pub session_id: String,
    pub state: String,
}

pub struct LocalSessionService {
    database: Database,
    events: broadcast::Sender<SessionStateChanged>,
    pub(crate) peer_review: super::peer_review_student::StudentPeerReviewService,
}

impl LocalSessionService {
    pub fn initialize(database: Database) -> Result<Arc<Self>, AppError> {
        LocalSessionRepository::end_stale_sessions(&database)?;
        let (events, _) = broadcast::channel(64);
        let peer_review =
            super::peer_review_student::StudentPeerReviewService::new(database.clone());
        Ok(Arc::new(Self {
            database,
            events,
            peer_review,
        }))
    }

    pub fn create(
        &self,
        classroom_id: String,
        server_instance_id: String,
    ) -> Result<LocalSessionDto, AppError> {
        let join_code = generate_join_code()?;
        let session = LocalSessionRepository::create(
            &self.database,
            NewLocalSession {
                id: Uuid::now_v7().to_string(),
                classroom_id,
                server_instance_id,
                join_code,
            },
        )?;
        Ok(session.into())
    }

    pub fn open_lobby(
        &self,
        session_id: String,
        server_instance_id: String,
    ) -> Result<LocalSessionDto, AppError> {
        let session =
            LocalSessionRepository::open_lobby(&self.database, &session_id, &server_instance_id)?;
        Ok(session.into())
    }

    pub fn end(&self, session_id: String, reason: &str) -> Result<LocalSessionDto, AppError> {
        let session = LocalSessionRepository::end(&self.database, &session_id, reason)?;
        let _ = self.events.send(SessionStateChanged {
            session_id: session.id.clone(),
            state: session.state.clone(),
        });
        Ok(session.into())
    }

    pub fn start(
        &self,
        session_id: String,
        server_instance_id: String,
    ) -> Result<LocalSessionDto, AppError> {
        let session =
            LocalSessionRepository::start(&self.database, &session_id, &server_instance_id)?;
        let _ = self.events.send(SessionStateChanged {
            session_id: session.id.clone(),
            state: session.state.clone(),
        });
        Ok(session.into())
    }

    pub fn active(&self) -> Result<Option<LocalSessionDto>, AppError> {
        Ok(LocalSessionRepository::get_active(&self.database)?.map(Into::into))
    }

    pub fn list_history(
        &self,
        classroom_id: String,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<SessionHistoryDto>, AppError> {
        if !(1..=MAX_HISTORY_LIMIT).contains(&limit) || offset < 0 {
            return Err(AppError::Validation(
                "invalid history pagination".to_owned(),
            ));
        }
        Ok(
            LocalSessionRepository::list_history(&self.database, &classroom_id, limit, offset)?
                .into_iter()
                .map(Into::into)
                .collect(),
        )
    }

    pub fn has_nonterminal_session(&self) -> Result<bool, AppError> {
        Ok(LocalSessionRepository::get_active(&self.database)?.is_some())
    }

    pub fn end_active_for_exit(&self) -> Result<(), AppError> {
        if let Some(session) = LocalSessionRepository::get_active(&self.database)? {
            let _ = self.end(session.id, "app_exit")?;
        }
        Ok(())
    }

    pub fn public_join_info(
        &self,
        join_code: &str,
        server_instance_id: &str,
        protocol_version: u8,
    ) -> Result<SessionPublicView, AppError> {
        let session = self.open_session_for_join(join_code, server_instance_id)?;
        Ok(SessionPublicView {
            session_id: session.id,
            classroom_name: session.classroom_name,
            state: session.state,
            join_mode: session.join_mode,
            server_instance_id: session.server_instance_id,
            protocol_version,
        })
    }

    pub fn join(
        &self,
        join_code: &str,
        seat_number: i64,
        name: &str,
        server_instance_id: &str,
    ) -> Result<JoinSuccess, AppError> {
        if seat_number <= 0 || name.trim().is_empty() || name.chars().count() > 200 {
            return Err(AppError::IdentityMismatch);
        }
        let session = self.open_session_for_join(join_code, server_instance_id)?;
        let Some(student) = LocalSessionRepository::roster_student(
            &self.database,
            &session.classroom_id,
            seat_number,
        )?
        else {
            return Err(AppError::IdentityMismatch);
        };
        if normalize_name(&student.name) != normalize_name(name) {
            return Err(AppError::IdentityMismatch);
        }
        let credential = generate_credential()?;
        let participant = LocalSessionRepository::create_participant(
            &self.database,
            NewParticipant {
                id: Uuid::now_v7().to_string(),
                session_id: session.id.clone(),
                student_id: student.id,
                seat_number,
                display_name: student.name,
                credential_hash: credential_hash(&credential),
                server_instance_id: session.server_instance_id.clone(),
            },
        )?;
        Ok(JoinSuccess {
            session_id: session.id,
            participant_id: participant.id.clone(),
            credential,
            participant: participant_self_view(&participant),
            server_instance_id: session.server_instance_id,
        })
    }

    pub fn authenticate(
        &self,
        session_id: &str,
        participant_id: &str,
        credential: &str,
        server_instance_id: &str,
    ) -> Result<AuthenticatedParticipant, AppError> {
        let Some(session) = LocalSessionRepository::get_by_id(&self.database, session_id)? else {
            return Err(AppError::AuthenticationFailed);
        };
        if session.server_instance_id != server_instance_id {
            return Err(AppError::ServerInstanceMismatch);
        }
        if session.state != "LOBBY" && session.state != "ACTIVE" {
            return Err(AppError::SessionNotOpen);
        }
        let Some(participant) =
            LocalSessionRepository::get_participant(&self.database, participant_id)?
        else {
            return Err(AppError::AuthenticationFailed);
        };
        if participant.session_id != session.id
            || credential_hash(credential) != participant.credential_hash
        {
            return Err(AppError::AuthenticationFailed);
        }
        LocalSessionRepository::touch_authenticated(&self.database, participant_id)?;
        Ok(AuthenticatedParticipant {
            participant: participant_self_view(&participant),
            classroom_name: session.classroom_name,
            session_state: session.state,
        })
    }

    pub fn list_participants(
        &self,
        session_id: &str,
    ) -> Result<Vec<TeacherParticipantDto>, AppError> {
        Ok(
            LocalSessionRepository::list_participants(&self.database, session_id)?
                .into_iter()
                .map(|participant| TeacherParticipantDto {
                    participant_id: participant.id,
                    student_id: participant.student_id,
                    seat_number: participant.seat_number,
                    display_name: participant.display_name,
                    joined_at: participant.joined_at,
                    online: false,
                })
                .collect(),
        )
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionStateChanged> {
        self.events.subscribe()
    }

    fn open_session_for_join(
        &self,
        join_code: &str,
        server_instance_id: &str,
    ) -> Result<LocalSessionRecord, AppError> {
        let code = normalize_join_code(join_code);
        let Some(session) = LocalSessionRepository::get_by_join_code(&self.database, &code)? else {
            return Err(AppError::JoinCodeInvalid);
        };
        if session.server_instance_id != server_instance_id {
            return Err(AppError::ServerInstanceMismatch);
        }
        if session.state != "LOBBY" {
            return Err(AppError::SessionNotOpen);
        }
        Ok(session)
    }
}

impl From<LocalSessionRecord> for LocalSessionDto {
    fn from(value: LocalSessionRecord) -> Self {
        Self {
            id: value.id,
            classroom_id: value.classroom_id,
            classroom_name: value.classroom_name,
            server_instance_id: value.server_instance_id,
            state: value.state,
            join_mode: value.join_mode,
            join_code: value.join_code,
            created_at: value.created_at,
            lobby_opened_at: value.lobby_opened_at,
            ended_at: value.ended_at,
            ended_reason: value.ended_reason,
        }
    }
}

impl From<SessionHistoryRecord> for SessionHistoryDto {
    fn from(value: SessionHistoryRecord) -> Self {
        Self {
            session_id: value.session_id,
            classroom_id: value.classroom_id,
            classroom_name: value.classroom_name,
            state: value.state,
            created_at: value.created_at,
            lobby_opened_at: value.lobby_opened_at,
            ended_at: value.ended_at,
            participant_count: value.participant_count,
            eligible_question_count: value.eligible_question_count,
        }
    }
}

fn participant_self_view(participant: &ParticipantRecord) -> ParticipantSelfView {
    ParticipantSelfView {
        participant_id: participant.id.clone(),
        session_id: participant.session_id.clone(),
        seat_number: participant.seat_number,
        display_name: participant.display_name.clone(),
    }
}

pub fn normalize_name(value: &str) -> String {
    value.trim().nfkc().collect()
}

pub fn normalize_join_code(value: &str) -> String {
    value.trim().to_ascii_uppercase()
}

fn generate_join_code() -> Result<String, AppError> {
    let mut code = String::with_capacity(JOIN_CODE_LENGTH);
    let rejection_limit = u8::MAX - (u8::MAX % JOIN_CODE_ALPHABET.len() as u8);
    while code.len() < JOIN_CODE_LENGTH {
        let mut byte = [0_u8; 1];
        random_fill(&mut byte).map_err(|_| AppError::Storage)?;
        if byte[0] < rejection_limit {
            code.push(
                JOIN_CODE_ALPHABET[(byte[0] % JOIN_CODE_ALPHABET.len() as u8) as usize] as char,
            );
        }
    }
    Ok(code)
}

fn generate_credential() -> Result<String, AppError> {
    let mut bytes = [0_u8; 32];
    random_fill(&mut bytes).map_err(|_| AppError::Storage)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn credential_hash(credential: &str) -> String {
    format!("{:x}", Sha256::digest(credential.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::{CreateClassroomRequest, CreateStudentRequest, PersistenceService};
    use crate::infrastructure::persistence::database::Database;

    fn service() -> (Arc<LocalSessionService>, String) {
        let directory = tempfile::tempdir().expect("temp directory");
        let persistence = PersistenceService::initialize(directory.path()).expect("persistence");
        let classroom = persistence
            .create_classroom(CreateClassroomRequest {
                name: "3A".to_owned(),
                academic_year: None,
            })
            .expect("classroom");
        persistence
            .create_student(CreateStudentRequest {
                class_id: classroom.id.clone(),
                seat_number: 12,
                name: "王小明".to_owned(),
            })
            .expect("student");
        let database = persistence.database_for_local_session();
        std::mem::forget(directory);
        (
            LocalSessionService::initialize(database).expect("session service"),
            classroom.id,
        )
    }

    #[test]
    fn join_code_and_name_normalization_are_deterministic() {
        let code = generate_join_code().expect("code");
        assert_eq!(code.len(), JOIN_CODE_LENGTH);
        assert!(code.bytes().all(|byte| JOIN_CODE_ALPHABET.contains(&byte)));
        assert_eq!(normalize_join_code(" ab7k9m2q "), "AB7K9M2Q");
        assert_eq!(normalize_name("  Ａｄａ  "), "Ada");
    }

    #[test]
    fn session_join_and_credential_lifecycle_are_safe() {
        let (service, classroom_id) = service();
        let server_id = Uuid::now_v7().to_string();
        let session = service
            .create(classroom_id.clone(), server_id.clone())
            .expect("session");
        assert!(service
            .create("missing".to_owned(), server_id.clone())
            .is_err());
        let session = service
            .open_lobby(session.id, server_id.clone())
            .expect("lobby");
        let joined = service
            .join(&session.join_code, 12, " 王小明 ", &server_id)
            .expect("join");
        let started = service
            .start(session.id.clone(), server_id.clone())
            .expect("start");
        assert_eq!(started.id, session.id);
        assert_eq!(started.state, "ACTIVE");
        let active = service
            .active()
            .expect("active query")
            .expect("active session");
        assert_eq!(active.id, session.id);
        assert_eq!(active.state, "ACTIVE");
        assert!(service.create(classroom_id, server_id.clone()).is_err());
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(&joined.credential)
                .expect("credential bytes")
                .len(),
            32
        );
        assert!(service
            .join(&session.join_code, 12, "王小明", &server_id)
            .is_err());
        assert!(service
            .authenticate(
                &joined.session_id,
                &joined.participant_id,
                "wrong",
                &server_id
            )
            .is_err());
        assert!(service
            .authenticate(
                &joined.session_id,
                &joined.participant_id,
                &joined.credential,
                &server_id
            )
            .is_ok());
        service
            .end(joined.session_id.clone(), "teacher_ended")
            .expect("end");
        assert!(service
            .authenticate(
                &joined.session_id,
                &joined.participant_id,
                &joined.credential,
                &server_id
            )
            .is_err());
    }

    #[test]
    fn history_is_ended_only_classroom_scoped_and_bounded() {
        let directory = tempfile::tempdir().expect("temp directory");
        let persistence = PersistenceService::initialize(directory.path()).expect("persistence");
        let first = persistence
            .create_classroom(CreateClassroomRequest {
                name: "3A".to_owned(),
                academic_year: None,
            })
            .expect("classroom");
        let second = persistence
            .create_classroom(CreateClassroomRequest {
                name: "3B".to_owned(),
                academic_year: None,
            })
            .expect("classroom");
        let service = LocalSessionService::initialize(persistence.database_for_local_session())
            .expect("session service");
        let server = Uuid::now_v7().to_string();
        let first_session = service
            .create(first.id.clone(), server.clone())
            .expect("session");
        service.end(first_session.id, "teacher_ended").expect("end");
        let second_session = service
            .create(first.id.clone(), server.clone())
            .expect("session");
        let second_session_id = second_session.id.clone();
        service
            .end(second_session.id, "teacher_ended")
            .expect("end");
        let other_session = service.create(second.id.clone(), server).expect("session");
        service.end(other_session.id, "teacher_ended").expect("end");
        let nonterminal = service
            .create(first.id.clone(), Uuid::now_v7().to_string())
            .expect("nonterminal session");
        service
            .open_lobby(nonterminal.id, nonterminal.server_instance_id)
            .expect("lobby");

        let page = service
            .list_history(first.id.clone(), 1, 0)
            .expect("history");
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].session_id, second_session_id);
        assert_eq!(page[0].state, "ENDED");
        assert_eq!(page[0].participant_count, 0);
        assert_eq!(
            service
                .list_history(first.id.clone(), 1, 1)
                .expect("next page")
                .len(),
            1
        );
        assert!(service
            .list_history(first.id.clone(), MAX_HISTORY_LIMIT + 1, 0)
            .is_err());
        assert_eq!(
            service
                .list_history(second.id.clone(), DEFAULT_HISTORY_LIMIT, 0)
                .expect("other classroom")
                .len(),
            1
        );
        let reopened_database = Database::open(directory.path().join("classroom.sqlite3"));
        reopened_database.initialize().expect("reopen database");
        let reopened_service =
            LocalSessionService::initialize(reopened_database).expect("reopen service");
        assert_eq!(
            reopened_service
                .list_history(first.id, DEFAULT_HISTORY_LIMIT, 0)
                .expect("reopen history")
                .len(),
            3
        );
    }
}
