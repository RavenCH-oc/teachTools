//! Teacher-only export orchestration. No Student transport or generic file IPC.
use super::statistics::{statistics_from_snapshot, SessionStatisticsDto};
use crate::infrastructure::persistence::{database::Database, repositories::session_report};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExportSection {
    SessionSummary,
    QuestionStatistics,
    StudentStatistics,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportRequest {
    pub session_id: String,
    pub sections: Vec<ExportSection>,
    pub output_path: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub filename: String,
}

pub use crate::error::ReportError;

pub(super) struct Report {
    pub classroom_name: String,
    pub created_at: String,
    pub lobby_opened_at: Option<String>,
    pub ended_at: Option<String>,
    pub statistics: SessionStatisticsDto,
}

pub struct SessionReportService {
    database: Database,
}
impl SessionReportService {
    pub fn initialize(database: Database) -> Self {
        Self { database }
    }
    pub fn export(&self, request: ExportRequest) -> Result<ExportResult, ReportError> {
        validate_request(&request)?;
        let target = output_target(&request.output_path)?;
        let snapshot = session_report::read(&self.database, &request.session_id)?;
        // All database reads have finished. Calculations reuse Phase 10 semantics.
        let report = Report {
            statistics: statistics_from_snapshot(&snapshot.statistics)?,
            classroom_name: snapshot.classroom_name,
            created_at: snapshot.created_at,
            lobby_opened_at: snapshot.lobby_opened_at,
            ended_at: snapshot.ended_at,
        };
        let bytes = super::session_report_xlsx::render(&report, &request.sections)?;
        // Generation completes before touching the destination. IO errors are never success.
        std::fs::write(&target, bytes).map_err(|_| ReportError::Write)?;
        Ok(ExportResult {
            filename: target
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or(ReportError::InvalidOutputPath)?
                .to_owned(),
        })
    }
}
fn validate_request(request: &ExportRequest) -> Result<(), ReportError> {
    let id =
        uuid::Uuid::parse_str(&request.session_id).map_err(|_| ReportError::InvalidSessionId)?;
    if id.is_nil() {
        return Err(ReportError::InvalidSessionId);
    }
    if request.sections.is_empty()
        || request.sections.len() > 3
        || request
            .sections
            .iter()
            .enumerate()
            .any(|(i, section)| request.sections[..i].contains(section))
    {
        return Err(ReportError::InvalidSections);
    }
    Ok(())
}
fn output_target(value: &str) -> Result<PathBuf, ReportError> {
    if value.is_empty() || value.contains('\0') {
        return Err(ReportError::InvalidOutputPath);
    }
    let mut path = Path::new(value).to_path_buf();
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(ReportError::InvalidOutputPath);
    }
    match path.extension().and_then(|extension| extension.to_str()) {
        None => {
            path.set_extension("xlsx");
        }
        Some(extension) if extension.eq_ignore_ascii_case("xlsx") => {}
        _ => return Err(ReportError::InvalidOutputPath),
    }
    Ok(path)
}

#[cfg(test)]
#[path = "session_report_tests.rs"]
mod tests;
