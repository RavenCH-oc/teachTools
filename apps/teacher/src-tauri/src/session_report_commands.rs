use crate::application::session_report::{
    ExportRequest, ExportResult, ReportError, SessionReportService,
};

#[tauri::command]
pub(crate) fn export_session_report(
    request: ExportRequest,
    service: tauri::State<'_, SessionReportService>,
) -> Result<ExportResult, ReportError> {
    service.export(request)
}
