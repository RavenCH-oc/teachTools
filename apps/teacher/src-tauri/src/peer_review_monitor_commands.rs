use crate::application::peer_review_monitor::{
    Page, PeerReviewMonitorService, Query, Revision, Status, Summary,
};
use crate::peer_review_domain::PeerReviewError;
#[tauri::command]
pub(crate) fn list_peer_review_monitor_activities(
    session_id: String,
    query: Query,
    service: tauri::State<'_, PeerReviewMonitorService>,
) -> Result<Page<Summary>, PeerReviewError> {
    service.activities(&session_id, &query)
}
#[tauri::command]
pub(crate) fn get_peer_review_monitor_summary(
    session_id: String,
    activity_id: String,
    service: tauri::State<'_, PeerReviewMonitorService>,
) -> Result<Summary, PeerReviewError> {
    service.summary(&session_id, &activity_id)
}
#[tauri::command]
pub(crate) fn list_peer_review_monitor_statuses(
    session_id: String,
    activity_id: String,
    kind: String,
    query: Query,
    service: tauri::State<'_, PeerReviewMonitorService>,
) -> Result<Page<Status>, PeerReviewError> {
    service.statuses(&session_id, &activity_id, &kind, &query)
}
#[tauri::command]
pub(crate) fn list_peer_review_record_revisions(
    session_id: String,
    activity_id: String,
    assignment_id: String,
    query: Query,
    latest: bool,
    service: tauri::State<'_, PeerReviewMonitorService>,
) -> Result<Page<Revision>, PeerReviewError> {
    service.revisions(&session_id, &activity_id, &assignment_id, &query, latest)
}
