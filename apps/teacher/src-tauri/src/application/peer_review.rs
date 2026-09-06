//! Peer Review foundation for future Teacher workflows; no IPC or Student transport surface.
use crate::infrastructure::persistence::database::Database;
use crate::infrastructure::persistence::repositories::peer_review::PeerReviewRepository;
pub use crate::peer_review_domain::*;
use std::path::Path;

#[derive(Clone)]
pub struct PeerReviewService {
    database: Database,
}
impl PeerReviewService {
    pub fn initialize(app_data_dir: impl AsRef<Path>) -> Result<Self, PeerReviewError> {
        let database = Database::open_in_app_data(app_data_dir)?;
        database.initialize()?;
        Ok(Self { database })
    }
    pub fn create_activity_draft(
        &self,
        request: CreatePeerReviewActivity,
    ) -> Result<PeerReviewActivity, PeerReviewError> {
        PeerReviewRepository::create(&self.database, request)
    }
    pub fn get_activity(&self, id: &str) -> Result<PeerReviewActivity, PeerReviewError> {
        PeerReviewRepository::get(&self.database, id)
    }
    pub fn list_session_activities(
        &self,
        session_id: &str,
    ) -> Result<Vec<PeerReviewActivity>, PeerReviewError> {
        PeerReviewRepository::list(&self.database, session_id)
    }
    pub fn open_activity(&self, id: &str) -> Result<PeerReviewActivity, PeerReviewError> {
        PeerReviewRepository::open(&self.database, id)
    }
    pub fn close_activity(&self, id: &str) -> Result<PeerReviewActivity, PeerReviewError> {
        PeerReviewRepository::finish(&self.database, id, false)
    }
    pub fn cancel_draft(&self, id: &str) -> Result<PeerReviewActivity, PeerReviewError> {
        PeerReviewRepository::finish(&self.database, id, true)
    }
    pub fn claim_target(
        &self,
        activity_id: &str,
        reviewer_id: &str,
        target_id: &str,
    ) -> Result<PeerReviewAssignment, PeerReviewError> {
        PeerReviewRepository::claim(&self.database, activity_id, reviewer_id, target_id)
    }
    pub fn list_target_statuses(
        &self,
        activity_id: &str,
    ) -> Result<Vec<PeerReviewTargetStatus>, PeerReviewError> {
        PeerReviewRepository::target_statuses(&self.database, activity_id)
    }
    pub fn list_group_targets(
        &self,
        activity_id: &str,
    ) -> Result<Vec<PeerReviewGroupTarget>, PeerReviewError> {
        PeerReviewRepository::group_targets(&self.database, activity_id)
    }
    pub fn list_assignments(
        &self,
        activity_id: &str,
    ) -> Result<Vec<PeerReviewAssignment>, PeerReviewError> {
        PeerReviewRepository::assignments(&self.database, activity_id)
    }
    pub fn get_assignment(&self, id: &str) -> Result<PeerReviewAssignmentDetail, PeerReviewError> {
        PeerReviewRepository::assignment_detail(&self.database, id)
    }
    pub fn submit_review_revision(
        &self,
        request: SubmitPeerReview,
    ) -> Result<PeerReviewResponse, PeerReviewError> {
        PeerReviewRepository::submit(&self.database, request)
    }
    pub fn list_review_revisions(
        &self,
        assignment_id: &str,
    ) -> Result<Vec<PeerReviewResponse>, PeerReviewError> {
        PeerReviewRepository::responses(&self.database, assignment_id)
    }
}
