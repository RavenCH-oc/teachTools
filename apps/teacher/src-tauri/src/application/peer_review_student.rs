//! Authenticated Student delivery; the caller supplies identity from Participant authentication.
use crate::infrastructure::persistence::{
    database::Database,
    repositories::peer_review::{student, PeerReviewRepository},
};
use crate::peer_review_domain::{PeerReviewError, SubmitPeerReview};
use serde::Serialize;
pub use student::{
    ActivityMetadata, CandidateMetadata, EssayDetail, FeedbackDetail, FeedbackMetadata, Page,
    PageRequest, Projection,
};
use tokio::sync::broadcast;

#[derive(Clone)]
pub struct StudentPeerReviewService {
    database: Database,
    events: broadcast::Sender<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Acknowledgement {
    pub assignment_id: String,
    pub review_submission_id: Option<String>,
    pub revision: i64,
}

impl StudentPeerReviewService {
    pub fn activity_metadata(
        &self,
        s: &str,
        p: &str,
        id: &str,
    ) -> Result<Page<ActivityMetadata>, PeerReviewError> {
        student::activity_metadata(&self.database, s, p, id)
    }
    pub fn feedback_scoped(
        &self,
        s: &str,
        p: &str,
        q: &PageRequest,
        a: Option<&str>,
    ) -> Result<Page<FeedbackMetadata>, PeerReviewError> {
        student::feedback_scoped(&self.database, s, p, q, a)
    }
    pub fn own_review(
        &self,
        s: &str,
        p: &str,
        a: &str,
    ) -> Result<Option<FeedbackDetail>, PeerReviewError> {
        student::own_review(&self.database, s, p, a)
    }
    pub fn new(database: Database) -> Self {
        let (events, _) = broadcast::channel(64);
        Self { database, events }
    }
    pub fn invalidate(&self, session: &str) {
        let _ = self.events.send(session.to_owned());
    }
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.events.subscribe()
    }
    pub fn projection(&self, s: &str, p: &str) -> Result<Projection, PeerReviewError> {
        student::projection(&self.database, s, p)
    }
    pub fn activities(
        &self,
        s: &str,
        p: &str,
        q: &PageRequest,
    ) -> Result<Page<ActivityMetadata>, PeerReviewError> {
        student::activities(&self.database, s, p, q)
    }
    pub fn candidates(
        &self,
        s: &str,
        p: &str,
        a: &str,
        q: &PageRequest,
    ) -> Result<Page<CandidateMetadata>, PeerReviewError> {
        student::candidates(&self.database, s, p, a, q)
    }
    pub fn feedback(
        &self,
        s: &str,
        p: &str,
        q: &PageRequest,
    ) -> Result<Page<FeedbackMetadata>, PeerReviewError> {
        student::feedback(&self.database, s, p, q)
    }
    pub fn essays(
        &self,
        s: &str,
        p: &str,
        a: &str,
        q: &PageRequest,
    ) -> Result<Page<EssayDetail>, PeerReviewError> {
        student::essays(&self.database, s, p, a, q)
    }
    pub fn feedback_detail(
        &self,
        s: &str,
        p: &str,
        a: &str,
    ) -> Result<FeedbackDetail, PeerReviewError> {
        student::feedback_detail(&self.database, s, p, a)
    }
    pub fn claim(
        &self,
        s: &str,
        p: &str,
        a: &str,
        target: &str,
    ) -> Result<Acknowledgement, PeerReviewError> {
        let activity = PeerReviewRepository::get(&self.database, a)?;
        if activity.session_id != s {
            return Err(PeerReviewError::ReviewerNotAuthorized);
        }
        let assignment = PeerReviewRepository::claim(&self.database, a, p, target)?;
        self.invalidate(s);
        Ok(Acknowledgement {
            assignment_id: assignment.id,
            review_submission_id: None,
            revision: assignment.latest_review_revision.map_or(0, |r| r.revision),
        })
    }
    pub fn submit(
        &self,
        s: &str,
        p: &str,
        mut request: SubmitPeerReview,
    ) -> Result<Acknowledgement, PeerReviewError> {
        student::authorize_assignment(&self.database, s, p, &request.assignment_id)?;
        request.submitted_by_participant_id = p.to_owned();
        let response = PeerReviewRepository::submit(&self.database, request)?;
        self.invalidate(s);
        Ok(Acknowledgement {
            assignment_id: response.assignment_id,
            review_submission_id: Some(response.id),
            revision: response.revision,
        })
    }
}
