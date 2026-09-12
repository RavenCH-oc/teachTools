//! One connection and one read transaction for every section of an export.
use super::{
    live_quiz::LiveQuizRepository,
    local_session::LocalSessionRepository,
    statistics::{latest_submissions_on, StatisticsSnapshot},
};
use crate::error::AppError;
use crate::error::ReportError;
use crate::infrastructure::persistence::database::Database;
use rusqlite::OptionalExtension;

pub struct ReportSnapshot {
    pub classroom_name: String,
    pub created_at: String,
    pub lobby_opened_at: Option<String>,
    pub ended_at: Option<String>,
    pub statistics: StatisticsSnapshot,
}

pub fn read(database: &Database, session_id: &str) -> Result<ReportSnapshot, ReportError> {
    let mut connection = database.connection()?;
    let transaction = connection.transaction()?;
    let report = read_on(&transaction, session_id)?;
    transaction.commit()?;
    Ok(report)
}

// Requires a caller-owned read transaction; never opens another connection.
fn read_on(
    transaction: &rusqlite::Transaction<'_>,
    session_id: &str,
) -> Result<ReportSnapshot, ReportError> {
    let (state, classroom_name, created_at, lobby_opened_at, ended_at): (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
    ) = transaction
        .query_row(
            "SELECT s.state,c.name,s.created_at,s.lobby_opened_at,s.ended_at
         FROM local_sessions s JOIN classes c ON c.id=s.classroom_id WHERE s.id=?1",
            [session_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?
        .ok_or(ReportError::SessionNotFound)?;
    if state != "ENDED" {
        return Err(ReportError::SessionNotEnded);
    }
    Ok(ReportSnapshot {
        classroom_name,
        created_at,
        lobby_opened_at,
        ended_at,
        statistics: StatisticsSnapshot {
            session_id: session_id.to_owned(),
            session_state: state,
            participants: LocalSessionRepository::list_participants_on(transaction, session_id)?,
            questions: LiveQuizRepository::list_questions_on(transaction, session_id)?,
            latest_submissions: latest_submissions_on(transaction, session_id)?,
        },
    })
}

impl From<rusqlite::Error> for ReportError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}
impl From<AppError> for ReportError {
    fn from(_: AppError) -> Self {
        Self::Storage
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_report_read_stays_on_one_snapshot_during_another_connection_commit() {
        let directory = tempfile::tempdir().expect("directory");
        let database = Database::open(directory.path().join("report.sqlite3"));
        database.initialize().expect("initialize");
        database.connection().expect("connection").execute_batch(
            "INSERT INTO classes VALUES('c','Before',NULL,'now','now');
             INSERT INTO local_sessions(id,classroom_id,server_instance_id,state,join_mode,join_code,created_at,ended_at,updated_at)
             VALUES('s','c','server','ENDED','roster_match','code','now','now','now');
             INSERT INTO session_participants(id,session_id,seat_number,display_name,credential_hash,joined_at,updated_at)
             VALUES('p','s',1,'Before student','secret','now','now');"
        ).expect("fixture");
        let mut reader = database.connection().expect("reader");
        let transaction = reader.transaction().expect("read transaction");
        let _: String = transaction
            .query_row("SELECT state FROM local_sessions WHERE id='s'", [], |row| {
                row.get(0)
            })
            .expect("pin snapshot");
        database
            .connection()
            .expect("writer")
            .execute_batch(
                "BEGIN IMMEDIATE;
             UPDATE classes SET name='After';
             UPDATE session_participants SET display_name='After student';
             COMMIT;",
            )
            .expect("concurrent commit");
        let report = read_on(&transaction, "s").expect("read same transaction");
        assert_eq!(report.classroom_name, "Before");
        assert_eq!(
            report.statistics.participants[0].display_name,
            "Before student"
        );
        transaction.commit().expect("end read");
        let fresh = read(&database, "s").expect("fresh export snapshot");
        assert_eq!(fresh.classroom_name, "After");
        assert_eq!(
            fresh.statistics.participants[0].display_name,
            "After student"
        );
    }
}
