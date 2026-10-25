//! Typed read boundary shared by LAN and Remote. No URL or filesystem path enters this API.
use super::participant_realtime::internal_peer_id;
use super::peer_review_student::PageRequest;
use super::{LiveQuizService, LocalSessionService};
use crate::peer_review_domain::PeerReviewError;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    content = "arguments",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum HttpOperation {
    PeerReviewActivitiesList {
        #[serde(default)]
        page: PageRequest,
    },
    PeerReviewActivityGet {
        activity_id: String,
    },
    PeerReviewCandidatesList {
        activity_id: String,
        #[serde(default)]
        page: PageRequest,
    },
    // Existing LAN essays/{assignmentId} returns a page of exact authorized revisions.
    PeerReviewEssaysList {
        assignment_id: String,
        #[serde(default)]
        page: PageRequest,
    },
    PeerReviewFeedbackList {
        activity_id: Option<String>,
        #[serde(default)]
        page: PageRequest,
    },
    PeerReviewFeedbackGet {
        assignment_id: String,
    },
    PeerReviewOwnReviewGet {
        assignment_id: String,
    },
    SessionAssetGet {
        asset_id: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HttpIdentity {
    pub session_id: String,
    pub participant_id: String,
    pub credential: String,
}

pub(crate) struct HttpReadResponse {
    pub status: u16,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

impl HttpReadResponse {
    pub(crate) fn error(status: u16, code: &str, message: &str) -> Self {
        Self {
            status,
            content_type: "application/json".to_owned(),
            bytes: json!({"code":code,"message":message})
                .to_string()
                .into_bytes(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct ParticipantHttpService {
    sessions: Arc<LocalSessionService>,
    quiz: Arc<LiveQuizService>,
}

impl ParticipantHttpService {
    pub(crate) fn new(sessions: Arc<LocalSessionService>, quiz: Arc<LiveQuizService>) -> Self {
        Self { sessions, quiz }
    }

    pub(crate) fn read(
        &self,
        identity: HttpIdentity,
        instance: &str,
        expected_session: Option<&str>,
        operation: HttpOperation,
    ) -> HttpReadResponse {
        if expected_session.is_some_and(|id| id != identity.session_id)
            || self
                .sessions
                .authenticate(
                    &identity.session_id,
                    &identity.participant_id,
                    &identity.credential,
                    instance,
                )
                .is_err()
        {
            return HttpReadResponse::error(401, "AUTH_FAILED", "請重新連線課堂。");
        }
        let s = &identity.session_id;
        let p = &identity.participant_id;
        if let HttpOperation::SessionAssetGet { asset_id } = operation {
            return match self.quiz.read_asset_for_session(&asset_id, s) {
                Ok((bytes, content_type)) => HttpReadResponse {
                    status: 200,
                    content_type,
                    bytes,
                },
                Err(_) => {
                    HttpReadResponse::error(404, "ASSET_UNAVAILABLE", "檔案讀取失敗，請稍後重試。")
                }
            };
        }
        let service = &self.sessions.peer_review;
        let read = || -> Result<Value, PeerReviewError> {
            let value = match operation {
                HttpOperation::PeerReviewActivitiesList { page } => {
                    serde_json::to_value(service.activities(s, p, &page)?)
                }
                HttpOperation::PeerReviewActivityGet { activity_id }
                    if internal_peer_id(&activity_id) =>
                {
                    serde_json::to_value(service.activity_metadata(s, p, &activity_id)?)
                }
                HttpOperation::PeerReviewCandidatesList { activity_id, page } => {
                    serde_json::to_value(service.candidates(s, p, &activity_id, &page)?)
                }
                HttpOperation::PeerReviewEssaysList {
                    assignment_id,
                    page,
                } => serde_json::to_value(service.essays(s, p, &assignment_id, &page)?),
                HttpOperation::PeerReviewFeedbackList { activity_id, page } => {
                    serde_json::to_value(match activity_id.as_deref() {
                        Some(id) => service.feedback_scoped(s, p, &page, Some(id))?,
                        None => service.feedback(s, p, &page)?,
                    })
                }
                HttpOperation::PeerReviewFeedbackGet { assignment_id } => {
                    serde_json::to_value(service.feedback_detail(s, p, &assignment_id)?)
                }
                HttpOperation::PeerReviewOwnReviewGet { assignment_id } => {
                    serde_json::to_value(service.own_review(s, p, &assignment_id)?)
                }
                _ => return Err(PeerReviewError::InvalidInput),
            };
            value.map_err(|_| PeerReviewError::Storage)
        };
        match read() {
            Ok(value) => match serde_json::to_vec(&value) {
                Ok(bytes) => HttpReadResponse {
                    status: 200,
                    content_type: "application/json".to_owned(),
                    bytes,
                },
                Err(_) => HttpReadResponse::error(500, "REQUEST_FAILED", "無法讀取互評資料。"),
            },
            Err(PeerReviewError::InvalidInput) => {
                HttpReadResponse::error(400, "INVALID_INPUT", "分頁參數無效。")
            }
            Err(_) => HttpReadResponse::error(404, "NOT_FOUND", "無法讀取互評資料。"),
        }
    }
}
