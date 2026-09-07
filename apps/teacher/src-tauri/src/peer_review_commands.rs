use crate::application::peer_review_setup::{
    PeerReviewSetupContext, PeerReviewSetupService, SavePeerReviewDraft, SetupActivity,
};
use crate::peer_review_domain::PeerReviewError;

#[tauri::command]
pub(crate) fn get_peer_review_setup_context(
    session_id: String,
    service: tauri::State<'_, PeerReviewSetupService>,
) -> Result<PeerReviewSetupContext, PeerReviewError> {
    service.context(&session_id)
}
#[tauri::command]
pub(crate) fn create_peer_review_activity(
    request: SavePeerReviewDraft,
    service: tauri::State<'_, PeerReviewSetupService>,
) -> Result<SetupActivity, PeerReviewError> {
    service.save(None, request)
}
#[tauri::command]
pub(crate) fn update_peer_review_activity_draft(
    activity_id: String,
    request: SavePeerReviewDraft,
    service: tauri::State<'_, PeerReviewSetupService>,
) -> Result<SetupActivity, PeerReviewError> {
    service.save(Some(&activity_id), request)
}
#[tauri::command]
pub(crate) fn open_peer_review_activity(
    session_id: String,
    activity_id: String,
    service: tauri::State<'_, PeerReviewSetupService>,
    sessions: tauri::State<'_, std::sync::Arc<crate::application::LocalSessionService>>,
) -> Result<SetupActivity, PeerReviewError> {
    let result = service.open(&session_id, &activity_id)?;
    sessions.peer_review.invalidate(&session_id);
    Ok(result)
}
#[tauri::command]
pub(crate) fn close_peer_review_activity(
    session_id: String,
    activity_id: String,
    service: tauri::State<'_, PeerReviewSetupService>,
    sessions: tauri::State<'_, std::sync::Arc<crate::application::LocalSessionService>>,
) -> Result<SetupActivity, PeerReviewError> {
    let result = service.close(&session_id, &activity_id)?;
    sessions.peer_review.invalidate(&session_id);
    Ok(result)
}
#[tauri::command]
pub(crate) fn cancel_peer_review_activity(
    session_id: String,
    activity_id: String,
    service: tauri::State<'_, PeerReviewSetupService>,
) -> Result<SetupActivity, PeerReviewError> {
    service.cancel(&session_id, &activity_id)
}
