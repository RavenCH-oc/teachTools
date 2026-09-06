//! Internal feedback-only domain. These types are not Student protocol DTOs.
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PeerReviewMode {
    RandomOneToOne,
    StudentSelect,
    CrossGroup,
}

impl PeerReviewMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::RandomOneToOne => "RANDOM_ONE_TO_ONE",
            Self::StudentSelect => "STUDENT_SELECT",
            Self::CrossGroup => "CROSS_GROUP",
        }
    }
    pub(crate) fn from_storage(value: &str) -> Result<Self, PeerReviewError> {
        match value {
            "RANDOM_ONE_TO_ONE" => Ok(Self::RandomOneToOne),
            "STUDENT_SELECT" => Ok(Self::StudentSelect),
            "CROSS_GROUP" => Ok(Self::CrossGroup),
            _ => Err(PeerReviewError::Storage),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PeerReviewActivityState {
    Draft,
    Open,
    Closed,
    Cancelled,
}

impl PeerReviewActivityState {
    pub(crate) fn from_storage(value: &str) -> Result<Self, PeerReviewError> {
        match value {
            "DRAFT" => Ok(Self::Draft),
            "OPEN" => Ok(Self::Open),
            "CLOSED" => Ok(Self::Closed),
            "CANCELLED" => Ok(Self::Cancelled),
            _ => Err(PeerReviewError::Storage),
        }
    }
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PeerReviewError {
    #[error("peer review activity not found")]
    PeerReviewActivityNotFound,
    #[error("peer review is not open")]
    PeerReviewNotOpen,
    #[error("peer review is already open")]
    PeerReviewAlreadyOpen,
    #[error("peer review is closed")]
    PeerReviewClosed,
    #[error("an essay question is required")]
    PeerReviewEssayRequired,
    #[error("the source question must be locked or revealed")]
    QuestionNotReady,
    #[error("insufficient review participants")]
    InsufficientReviewParticipants,
    #[error("self review is not allowed")]
    SelfReviewNotAllowed,
    #[error("target not found")]
    TargetNotFound,
    #[error("target review capacity full")]
    TargetReviewCapacityFull,
    #[error("reviewer is not eligible")]
    ReviewerNotEligible,
    #[error("review target locked after submission")]
    ReviewTargetLockedAfterSubmission,
    #[error("group set required")]
    GroupSetRequired,
    #[error("group set belongs to another session")]
    GroupSetSessionMismatch,
    #[error("insufficient review groups")]
    InsufficientReviewGroups,
    #[error("same group review is not allowed")]
    SameGroupReviewNotAllowed,
    #[error("review revision conflict")]
    ReviewRevisionConflict,
    #[error("review submission conflict")]
    ReviewSubmissionConflict,
    #[error("assignment not found")]
    AssignmentNotFound,
    #[error("reviewer is not authorized")]
    ReviewerNotAuthorized,
    #[error("session ended")]
    SessionEnded,
    #[error("an active session is required")]
    SessionNotActive,
    #[error("question belongs to another session")]
    QuestionSessionMismatch,
    #[error("invalid peer review configuration or text")]
    InvalidInput,
    #[error("random assignment unavailable")]
    RandomizationFailed,
    #[error("peer review storage operation failed")]
    Storage,
}
impl From<rusqlite::Error> for PeerReviewError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}
impl From<crate::error::AppError> for PeerReviewError {
    fn from(_: crate::error::AppError) -> Self {
        Self::Storage
    }
}

#[derive(Debug, Clone)]
pub struct CreatePeerReviewActivity {
    pub session_id: String,
    pub session_question_id: String,
    pub mode: PeerReviewMode,
    pub session_group_set_id: Option<String>,
    pub max_reviews_per_target: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerReviewActivity {
    pub id: String,
    pub session_id: String,
    pub session_question_id: String,
    pub mode: PeerReviewMode,
    pub state: PeerReviewActivityState,
    pub session_group_set_id: Option<String>,
    pub max_reviews_per_target: Option<i64>,
    pub created_at: String,
    pub opened_at: Option<String>,
    pub closed_at: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerReviewTarget {
    pub id: String,
    pub activity_id: String,
    pub submission_id: String,
    pub participant_id: String,
    pub source_revision: i64,
    pub essay_text: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerReviewTargetStatus {
    pub target: PeerReviewTarget,
    pub claimed_review_count: i64,
    pub submitted_review_count: i64,
    pub max_reviews_per_target: Option<i64>,
    pub remaining_capacity: Option<i64>,
    pub has_received_any_review: bool,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerReviewGroupTarget {
    pub id: String,
    pub session_group_id: String,
    pub name: String,
    pub captured_submission_items: Vec<PeerReviewTarget>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerReviewResponse {
    pub id: String,
    pub assignment_id: String,
    pub submitted_by_participant_id: String,
    pub revision: i64,
    pub expected_base_revision: i64,
    pub body: String,
    pub submitted_at: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerReviewAssignmentState {
    Assigned,
    Submitted,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerReviewAssignment {
    pub id: String,
    pub activity_id: String,
    pub reviewer_participant_id: Option<String>,
    pub reviewer_session_group_id: Option<String>,
    pub target_id: Option<String>,
    pub target_group_id: Option<String>,
    pub slot_index: i64,
    pub state: PeerReviewAssignmentState,
    pub latest_review_revision: Option<PeerReviewResponse>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerReviewAssignmentDetail {
    pub assignment: PeerReviewAssignment,
    pub target: Option<PeerReviewTarget>,
    pub group_target: Option<PeerReviewGroupTarget>,
}
#[derive(Debug, Clone)]
pub struct SubmitPeerReview {
    pub review_submission_id: String,
    pub assignment_id: String,
    pub submitted_by_participant_id: String,
    pub expected_base_revision: i64,
    pub body: String,
}

pub(crate) fn review_text(body: &str) -> Result<String, PeerReviewError> {
    let body = body.trim();
    if body.is_empty() || body.contains('\0') || body.chars().count() > 10_000 {
        return Err(PeerReviewError::InvalidInput);
    }
    Ok(body.to_owned())
}

/// One bounded shuffle followed by a cycle; every principal has one incoming/outgoing edge.
pub(crate) fn shuffled_cycle(ids: &[String]) -> Result<Vec<(String, String)>, PeerReviewError> {
    if ids.len() < 2 {
        return Err(PeerReviewError::InsufficientReviewParticipants);
    }
    let mut keyed = ids
        .iter()
        .map(|id| {
            let mut bytes = [0_u8; 16];
            getrandom::fill(&mut bytes).map_err(|_| PeerReviewError::RandomizationFailed)?;
            Ok((bytes, id.clone()))
        })
        .collect::<Result<Vec<_>, PeerReviewError>>()?;
    keyed.sort();
    Ok((0..keyed.len())
        .map(|i| (keyed[i].1.clone(), keyed[(i + 1) % keyed.len()].1.clone()))
        .collect())
}
