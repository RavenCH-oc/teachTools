use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use super::grouping::{GroupingEvent, GroupingService};
use super::live_quiz::QuizEvent;
use super::local_server::PresenceRegistry;
use super::local_session::SessionStateChanged;
use super::peer_review_student::Acknowledgement;
use super::{
    LiveQuizService, LocalSessionService, QuestionPublicView, QuestionRevealView, SessionSyncDto,
    SubmissionAckDto,
};
use crate::error::AppError;
use crate::peer_review_domain::{PeerReviewError, SubmitPeerReview};
use crate::question_domain::StudentAnswer;

#[cfg(test)]
#[path = "participant_realtime_tests.rs"]
mod tests;

pub(crate) const PARTICIPANT_PROTOCOL_VERSION: u8 = 1;
pub(crate) const MAX_PARTICIPANT_MESSAGE_BYTES: usize = 64 * 1024;

/// Application boundary shared by the LAN and Remote adapters. Both transports
/// reach the same participant validation and authoritative domain services.
#[derive(Clone)]
pub(crate) struct ParticipantRealtimeService {
    session: Arc<LocalSessionService>,
    quiz: Arc<LiveQuizService>,
    grouping: GroupingService,
    presence: PresenceRegistry,
}

#[derive(Clone)]
pub(crate) struct ParticipantConnection {
    pub session_id: String,
    pub participant_id: String,
    pub connection_id: Uuid,
}

pub(crate) struct ParticipantSubscriptions {
    pub session: broadcast::Receiver<SessionStateChanged>,
    pub quiz: broadcast::Receiver<QuizEvent>,
    pub grouping: broadcast::Receiver<GroupingEvent>,
    pub peer_review: broadcast::Receiver<String>,
}

impl ParticipantRealtimeService {
    pub(crate) fn new(
        session: Arc<LocalSessionService>,
        quiz: Arc<LiveQuizService>,
        grouping: GroupingService,
        presence: PresenceRegistry,
    ) -> Self {
        Self {
            session,
            quiz,
            grouping,
            presence,
        }
    }

    pub(crate) async fn authenticate(
        &self,
        server_instance_id: &str,
        text: &str,
        connection_id: Uuid,
    ) -> Result<(ParticipantConnection, Vec<ServerMessage>), &'static str> {
        let service = self.clone();
        let server_instance_id = server_instance_id.to_owned();
        let text = text.to_owned();
        tokio::task::spawn_blocking(move || {
            service.authenticate_sync(&server_instance_id, &text, connection_id)
        })
        .await
        .map_err(|_| "AUTH_FAILED")?
    }

    pub(crate) async fn handle(
        &self,
        participant: &ParticipantConnection,
        text: &str,
    ) -> Result<Vec<ServerMessage>, ()> {
        let service = self.clone();
        let participant = participant.clone();
        let text = text.to_owned();
        tokio::task::spawn_blocking(move || service.handle_sync(&participant, &text))
            .await
            .map_err(|_| ())?
    }

    pub(crate) async fn sync(
        &self,
        participant: &ParticipantConnection,
    ) -> Result<SessionSyncDto, AppError> {
        let service = self.clone();
        let participant = participant.clone();
        tokio::task::spawn_blocking(move || service.sync_inner(&participant))
            .await
            .map_err(|_| AppError::Storage)?
    }

    /// Authenticate exactly the existing participant credential. Remote requires
    /// this as its first application message; LAN keeps its pre-auth ping policy.
    fn authenticate_sync(
        &self,
        server_instance_id: &str,
        text: &str,
        connection_id: Uuid,
    ) -> Result<(ParticipantConnection, Vec<ServerMessage>), &'static str> {
        let ClientMessage::ParticipantAuth {
            session_id,
            participant_id,
            credential,
            ..
        } = parse_client_message(text).map_err(|()| "PROTOCOL_ERROR")?
        else {
            return Err("PROTOCOL_ERROR");
        };
        let authenticated = self
            .session
            .authenticate(
                &session_id,
                &participant_id,
                &credential,
                server_instance_id,
            )
            .map_err(|error| authentication_error_code(&error))?;
        let participant = ParticipantConnection {
            session_id: authenticated.participant.session_id.clone(),
            participant_id: authenticated.participant.participant_id.clone(),
            connection_id,
        };
        self.presence
            .connect_with_id(&participant.participant_id, connection_id);
        Ok((
            participant,
            vec![ServerMessage::ParticipantAuthenticated {
                protocol_version: PARTICIPANT_PROTOCOL_VERSION,
                participant: authenticated.participant,
                classroom_name: authenticated.classroom_name,
                session_state: authenticated.session_state,
            }],
        ))
    }

    fn handle_sync(
        &self,
        participant: &ParticipantConnection,
        text: &str,
    ) -> Result<Vec<ServerMessage>, ()> {
        let message = parse_client_message(text)?;
        let response = match message {
            ClientMessage::ClaimPeerReview {
                request_id,
                activity_id,
                target_id,
                ..
            } => peer_result(
                request_id,
                self.session.peer_review.claim(
                    &participant.session_id,
                    &participant.participant_id,
                    &activity_id,
                    &target_id,
                ),
            ),
            ClientMessage::SubmitPeerReview {
                request_id,
                review_submission_id,
                assignment_id,
                expected_base_revision,
                body,
                ..
            } => peer_result(
                request_id,
                self.session.peer_review.submit(
                    &participant.session_id,
                    &participant.participant_id,
                    SubmitPeerReview {
                        review_submission_id,
                        assignment_id,
                        expected_base_revision,
                        body,
                        submitted_by_participant_id: participant.participant_id.clone(),
                    },
                ),
            ),
            ClientMessage::Ping { request_id, .. } => {
                self.presence
                    .heartbeat(&participant.participant_id, participant.connection_id);
                ServerMessage::Pong {
                    protocol_version: PARTICIPANT_PROTOCOL_VERSION,
                    request_id,
                }
            }
            ClientMessage::SubmitAnswer {
                submission_id,
                session_question_id,
                answer,
                ..
            } => match self.quiz.submit(
                participant.participant_id.clone(),
                participant.session_id.clone(),
                session_question_id,
                submission_id,
                answer,
            ) {
                Ok(acknowledgement) => ServerMessage::SubmissionAcknowledged {
                    protocol_version: PARTICIPANT_PROTOCOL_VERSION,
                    acknowledgement,
                },
                Err(error) => Self::error(submission_error_code(&error)),
            },
            ClientMessage::SelectGroup {
                request_id,
                draft_id,
                group_id,
                ..
            } => {
                match self.grouping.select_group(
                    &draft_id,
                    &participant.participant_id,
                    &participant.session_id,
                    group_id.as_deref(),
                ) {
                    Ok(selection) => ServerMessage::GroupSelectionAcknowledged {
                        protocol_version: PARTICIPANT_PROTOCOL_VERSION,
                        acknowledgement: GroupSelectionAcknowledgement {
                            request_id,
                            selected_group_id: selection.selected_group_id,
                            accepted: true,
                        },
                    },
                    Err(error) => Self::error(grouping_error_code(&error)),
                }
            }
            ClientMessage::ParticipantAuth { .. } => return Err(()),
        };
        Ok(vec![response])
    }

    fn sync_inner(&self, participant: &ParticipantConnection) -> Result<SessionSyncDto, AppError> {
        let current_session = self
            .session
            .active()?
            .filter(|current| current.id == participant.session_id)
            .ok_or(AppError::SessionEnded)?;
        let mut sync = self.quiz.sync(
            &participant.participant_id,
            &participant.session_id,
            &current_session.state,
        )?;
        sync.grouping = Some(
            self.grouping
                .student_grouping_view(&participant.participant_id, &participant.session_id)?,
        );
        if current_session.state == "ACTIVE" {
            sync.peer_review = Some(
                self.session
                    .peer_review
                    .projection(&participant.session_id, &participant.participant_id)
                    .map_err(|_| AppError::Storage)?,
            );
        }
        Ok(sync)
    }

    pub(crate) async fn sync_messages(
        &self,
        participant: &ParticipantConnection,
    ) -> Result<Vec<ServerMessage>, AppError> {
        Ok(vec![ServerMessage::SessionSync {
            protocol_version: PARTICIPANT_PROTOCOL_VERSION,
            sync: Box::new(self.sync(participant).await?),
        }])
    }

    pub(crate) async fn quiz_sync_messages(
        &self,
        participant: &ParticipantConnection,
    ) -> Result<Vec<ServerMessage>, AppError> {
        Ok(Self::quiz_messages(self.sync(participant).await?))
    }

    pub(crate) fn quiz_messages(sync: SessionSyncDto) -> Vec<ServerMessage> {
        let revealed = sync.reveal.is_some();
        let mut messages = vec![ServerMessage::SessionSync {
            protocol_version: PARTICIPANT_PROTOCOL_VERSION,
            sync: Box::new(sync.clone()),
        }];
        if let Some(question) = sync.current_question {
            messages.push(ServerMessage::QuestionStateChanged {
                protocol_version: PARTICIPANT_PROTOCOL_VERSION,
                question,
            });
        }
        if let Some(reveal) = sync.reveal {
            messages.push(ServerMessage::QuestionRevealed {
                protocol_version: PARTICIPANT_PROTOCOL_VERSION,
                reveal,
            });
        }
        // Never send correctness or a score before authoritative reveal.
        if revealed {
            if let Some(result) = sync.own_latest_submission {
                messages.push(ServerMessage::SubmissionResult {
                    protocol_version: PARTICIPANT_PROTOCOL_VERSION,
                    result,
                });
            }
        }
        messages
    }

    pub(crate) fn disconnect(&self, participant: &ParticipantConnection) {
        self.presence
            .disconnect(&participant.participant_id, participant.connection_id);
    }

    pub(crate) fn subscribe(&self) -> ParticipantSubscriptions {
        ParticipantSubscriptions {
            session: self.session.subscribe(),
            quiz: self.quiz.subscribe(),
            grouping: self.grouping.subscribe(),
            peer_review: self.session.peer_review.subscribe(),
        }
    }

    pub(crate) fn error(code: &'static str) -> ServerMessage {
        ServerMessage::Error {
            protocol_version: PARTICIPANT_PROTOCOL_VERSION,
            code,
            message: transport_error_message(code),
        }
    }
}

fn peer_result(
    request_id: String,
    result: Result<Acknowledgement, PeerReviewError>,
) -> ServerMessage {
    match result {
        Ok(acknowledgement) => ServerMessage::PeerReviewAcknowledged {
            protocol_version: PARTICIPANT_PROTOCOL_VERSION,
            request_id,
            acknowledgement,
        },
        Err(code) => ServerMessage::PeerReviewRejected {
            protocol_version: PARTICIPANT_PROTOCOL_VERSION,
            request_id,
            code,
        },
    }
}

fn authentication_error_code(error: &AppError) -> &'static str {
    match error {
        AppError::ServerInstanceMismatch => "SERVER_INSTANCE_MISMATCH",
        AppError::SessionNotOpen => "SESSION_ENDED",
        _ => "AUTH_FAILED",
    }
}

fn submission_error_code(error: &AppError) -> &'static str {
    match error {
        AppError::QuestionLocked => "QUESTION_LOCKED",
        AppError::Conflict(_) => "SUBMISSION_CONFLICT",
        AppError::Validation(_) => "INVALID_ANSWER",
        _ => "PROTOCOL_ERROR",
    }
}

fn grouping_error_code(error: &AppError) -> &'static str {
    match error {
        AppError::GroupFull => "GROUP_FULL",
        AppError::GroupNotFound => "GROUP_NOT_FOUND",
        AppError::DraftNotOpen => "SELF_SELECTION_NOT_OPEN",
        AppError::StaleGroupingDraft
        | AppError::ParticipantSessionMismatch
        | AppError::ParticipantNotFound => "STALE_GROUPING_DRAFT",
        AppError::SessionEnded | AppError::SessionNotOpen => "SESSION_ENDED",
        _ => "STALE_GROUPING_DRAFT",
    }
}

fn transport_error_message(code: &str) -> &'static str {
    match code {
        "GROUP_FULL" => "The selected group is full.",
        "SELF_SELECTION_NOT_OPEN" => "Student group selection is not open.",
        "GROUP_NOT_FOUND" => "The selected group was not found.",
        "STALE_GROUPING_DRAFT" => "The grouping draft has changed. Refresh and try again.",
        "SESSION_ENDED" => "The classroom session has ended.",
        "QUESTION_LOCKED" => "The question is no longer accepting answers.",
        "INVALID_ANSWER" => "The answer is invalid.",
        "SUBMISSION_CONFLICT" => "The submission conflicts with an existing answer.",
        "PROTOCOL_ERROR" => "The transport message is invalid.",
        "AUTH_TIMEOUT" => "Participant authentication timed out.",
        "SERVER_INSTANCE_MISMATCH" => "The classroom server has changed.",
        _ => "Participant authentication failed.",
    }
}

pub(crate) fn internal_peer_id(value: &str) -> bool {
    Uuid::parse_str(value)
        .is_ok_and(|id| id.get_variant() == uuid::Variant::RFC4122 && id.get_version_num() == 7)
}

pub(crate) fn parse_client_message(text: &str) -> Result<ClientMessage, ()> {
    if text.len() > MAX_PARTICIPANT_MESSAGE_BYTES {
        return Err(());
    }
    let message: ClientMessage = serde_json::from_str(text).map_err(|_| ())?;
    match &message {
        ClientMessage::ClaimPeerReview {
            protocol_version,
            request_id,
            activity_id,
            target_id,
        } if *protocol_version == PARTICIPANT_PROTOCOL_VERSION
            && !request_id.trim().is_empty()
            && request_id.len() <= 120
            && internal_peer_id(activity_id)
            && internal_peer_id(target_id) =>
        {
            Ok(message)
        }
        ClientMessage::SubmitPeerReview {
            protocol_version,
            request_id,
            review_submission_id,
            assignment_id,
            expected_base_revision,
            body,
        } if *protocol_version == PARTICIPANT_PROTOCOL_VERSION
            && !request_id.trim().is_empty()
            && request_id.len() <= 120
            && internal_peer_id(assignment_id)
            && Uuid::parse_str(review_submission_id).is_ok_and(|id| {
                id.get_variant() == uuid::Variant::RFC4122 && matches!(id.get_version_num(), 4 | 7)
            })
            && *expected_base_revision >= 0
            && *expected_base_revision < 9_007_199_254_740_991
            && crate::peer_review_domain::review_text(body).is_ok() =>
        {
            Ok(message)
        }
        ClientMessage::Ping {
            protocol_version,
            request_id,
        } if *protocol_version == PARTICIPANT_PROTOCOL_VERSION
            && !request_id.trim().is_empty()
            && request_id.len() <= 120 =>
        {
            Ok(message)
        }
        ClientMessage::ParticipantAuth {
            protocol_version,
            request_id,
            session_id,
            participant_id,
            credential,
        } if *protocol_version == PARTICIPANT_PROTOCOL_VERSION
            && !request_id.trim().is_empty()
            && request_id.len() <= 120
            && Uuid::parse_str(session_id).is_ok()
            && Uuid::parse_str(participant_id).is_ok()
            && credential.len() == 43
            && credential
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') =>
        {
            Ok(message)
        }
        ClientMessage::SubmitAnswer {
            protocol_version,
            request_id,
            submission_id,
            session_question_id,
            ..
        } if *protocol_version == PARTICIPANT_PROTOCOL_VERSION
            && !request_id.trim().is_empty()
            && request_id.len() <= 120
            && Uuid::parse_str(submission_id).is_ok()
            && Uuid::parse_str(session_question_id).is_ok() =>
        {
            Ok(message)
        }
        ClientMessage::SelectGroup {
            protocol_version,
            request_id,
            draft_id,
            group_id,
        } if *protocol_version == PARTICIPANT_PROTOCOL_VERSION
            && !request_id.trim().is_empty()
            && request_id.len() <= 120
            && Uuid::parse_str(draft_id).is_ok()
            && group_id
                .as_deref()
                .is_none_or(|group_id| Uuid::parse_str(group_id).is_ok()) =>
        {
            Ok(message)
        }
        _ => Err(()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    deny_unknown_fields,
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ClientMessage {
    ClaimPeerReview {
        protocol_version: u8,
        request_id: String,
        activity_id: String,
        target_id: String,
    },
    SubmitPeerReview {
        protocol_version: u8,
        request_id: String,
        review_submission_id: String,
        assignment_id: String,
        expected_base_revision: i64,
        body: String,
    },
    Ping {
        protocol_version: u8,
        request_id: String,
    },
    ParticipantAuth {
        protocol_version: u8,
        request_id: String,
        session_id: String,
        participant_id: String,
        credential: String,
    },
    SubmitAnswer {
        protocol_version: u8,
        request_id: String,
        submission_id: String,
        session_question_id: String,
        answer: StudentAnswer,
    },
    SelectGroup {
        protocol_version: u8,
        request_id: String,
        draft_id: String,
        group_id: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ServerMessage {
    PeerReviewChanged {
        protocol_version: u8,
    },
    PeerReviewAcknowledged {
        protocol_version: u8,
        request_id: String,
        acknowledgement: Acknowledgement,
    },
    PeerReviewRejected {
        protocol_version: u8,
        request_id: String,
        code: PeerReviewError,
    },
    ServerHello {
        protocol_version: u8,
        server_instance_id: String,
    },
    Pong {
        protocol_version: u8,
        request_id: String,
    },
    ParticipantAuthenticated {
        protocol_version: u8,
        participant: crate::application::ParticipantSelfView,
        classroom_name: String,
        session_state: String,
    },
    SessionStateChanged {
        protocol_version: u8,
        session_id: String,
        state: String,
    },
    SessionSync {
        protocol_version: u8,
        sync: Box<SessionSyncDto>,
    },
    QuestionStateChanged {
        protocol_version: u8,
        question: QuestionPublicView,
    },
    QuestionRevealed {
        protocol_version: u8,
        reveal: QuestionRevealView,
    },
    SubmissionAcknowledged {
        protocol_version: u8,
        acknowledgement: SubmissionAckDto,
    },
    SubmissionResult {
        protocol_version: u8,
        result: crate::application::OwnSubmissionResultDto,
    },
    GroupSelectionAcknowledged {
        protocol_version: u8,
        acknowledgement: GroupSelectionAcknowledgement,
    },
    Error {
        protocol_version: u8,
        code: &'static str,
        message: &'static str,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupSelectionAcknowledgement {
    request_id: String,
    selected_group_id: Option<String>,
    accepted: bool,
}
