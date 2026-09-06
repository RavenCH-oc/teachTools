//! Teacher-only setup control plane. No answer, response or participant projection.
use crate::infrastructure::persistence::{
    database::Database,
    repositories::peer_review::{setup, PeerReviewRepository},
};
use crate::peer_review_domain::{
    PeerReviewActivity, PeerReviewActivityState, PeerReviewError, PeerReviewMode,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavePeerReviewDraft {
    pub session_id: String,
    pub session_question_id: String,
    pub mode: PeerReviewMode,
    pub max_reviews_per_target: Option<i64>,
    pub session_group_set_id: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct SetupActivity {
    pub id: String,
    pub session_question_id: String,
    pub mode: PeerReviewMode,
    pub state: PeerReviewActivityState,
    pub max_reviews_per_target: Option<i64>,
    pub session_group_set_id: Option<String>,
    pub created_at: String,
    pub opened_at: Option<String>,
    pub closed_at: Option<String>,
    pub frozen_target_count: i64,
}
impl SetupActivity {
    pub(crate) fn from_activity(a: PeerReviewActivity, frozen_target_count: i64) -> Self {
        Self {
            id: a.id,
            session_question_id: a.session_question_id,
            mode: a.mode,
            state: a.state,
            max_reviews_per_target: a.max_reviews_per_target,
            session_group_set_id: a.session_group_set_id,
            created_at: a.created_at,
            opened_at: a.opened_at,
            closed_at: a.closed_at,
            frozen_target_count,
        }
    }
}
#[derive(Debug, Serialize)]
pub struct SetupQuestion {
    pub id: String,
    pub position: i64,
    pub prompt_summary: String,
    pub state: String,
    pub eligible_participant_count: i64,
}
#[derive(Debug, Serialize)]
pub struct SetupGroup {
    pub name: String,
    pub essay_count: i64,
}
#[derive(Debug, Serialize)]
pub struct GroupPreflight {
    pub session_question_id: String,
    pub eligible_group_count: i64,
    pub groups: Vec<SetupGroup>,
}
#[derive(Debug, Serialize)]
pub struct SetupGroupSet {
    pub id: String,
    pub revision: i64,
    pub created_at: String,
    pub questions: Vec<GroupPreflight>,
}
#[derive(Debug, Serialize)]
pub struct PeerReviewSetupContext {
    pub session_id: String,
    pub session_state: String,
    pub classroom_name: String,
    pub questions: Vec<SetupQuestion>,
    pub activities: Vec<SetupActivity>,
    pub group_sets: Vec<SetupGroupSet>,
}

pub struct PeerReviewSetupService {
    database: Database,
}
impl PeerReviewSetupService {
    pub fn initialize(database: Database) -> Self {
        Self { database }
    }
    pub fn context(&self, session: &str) -> Result<PeerReviewSetupContext, PeerReviewError> {
        setup::context(&self.database, session)
    }
    pub fn save(
        &self,
        id: Option<&str>,
        request: SavePeerReviewDraft,
    ) -> Result<SetupActivity, PeerReviewError> {
        setup::save(&self.database, id, request)
    }
    pub fn open(&self, session: &str, id: &str) -> Result<SetupActivity, PeerReviewError> {
        setup::owned(&self.database, session, id)?;
        PeerReviewRepository::open_for_teacher(&self.database, id)?;
        setup::owned(&self.database, session, id)
    }
    pub fn close(&self, session: &str, id: &str) -> Result<SetupActivity, PeerReviewError> {
        setup::owned(&self.database, session, id)?;
        PeerReviewRepository::finish(&self.database, id, false)?;
        setup::owned(&self.database, session, id)
    }
    pub fn cancel(&self, session: &str, id: &str) -> Result<SetupActivity, PeerReviewError> {
        setup::owned(&self.database, session, id)?;
        PeerReviewRepository::finish(&self.database, id, true)?;
        setup::owned(&self.database, session, id)
    }
}
