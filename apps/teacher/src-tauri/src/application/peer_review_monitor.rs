//! Teacher IPC read boundary, isolated from Student transport and all mutations.
use crate::infrastructure::persistence::{database::Database, repositories::peer_review::monitor};
use crate::peer_review_domain::PeerReviewError;
pub use monitor::{Page, Query, Revision, Status, Summary};
pub struct PeerReviewMonitorService {
    database: Database,
}
impl PeerReviewMonitorService {
    pub fn initialize(database: Database) -> Self {
        Self { database }
    }
    pub fn activities(&self, s: &str, q: &Query) -> Result<Page<Summary>, PeerReviewError> {
        monitor::activities(&self.database, s, q)
    }
    pub fn summary(&self, s: &str, id: &str) -> Result<Summary, PeerReviewError> {
        monitor::get_summary(&self.database, s, id)
    }
    pub fn statuses(
        &self,
        s: &str,
        id: &str,
        kind: &str,
        q: &Query,
    ) -> Result<Page<Status>, PeerReviewError> {
        monitor::statuses(&self.database, s, id, kind, q)
    }
    pub fn revisions(
        &self,
        s: &str,
        id: &str,
        assignment: &str,
        q: &Query,
        latest: bool,
    ) -> Result<Page<Revision>, PeerReviewError> {
        monitor::revisions(&self.database, s, id, assignment, q, latest)
    }
}
