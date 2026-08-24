use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;

use super::{now_utc, Student};

#[derive(Debug, Clone)]
pub struct LocalSessionRecord {
    pub id: String,
    pub classroom_id: String,
    pub classroom_name: String,
    pub server_instance_id: String,
    pub state: String,
    pub join_mode: String,
    pub join_code: String,
    pub created_at: String,
    pub lobby_opened_at: Option<String>,
    pub ended_at: Option<String>,
    pub ended_reason: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct SessionHistoryRecord {
    pub session_id: String,
    pub classroom_id: String,
    pub classroom_name: String,
    pub state: String,
    pub created_at: String,
    pub lobby_opened_at: Option<String>,
    pub ended_at: Option<String>,
    pub participant_count: i64,
    pub eligible_question_count: i64,
}

#[derive(Debug, Clone)]
pub struct ParticipantRecord {
    pub id: String,
    pub session_id: String,
    pub student_id: Option<String>,
    pub seat_number: i64,
    pub display_name: String,
    pub credential_hash: String,
    pub joined_at: String,
    pub updated_at: String,
    pub last_authenticated_at: Option<String>,
}

pub struct NewLocalSession {
    pub id: String,
    pub classroom_id: String,
    pub server_instance_id: String,
    pub join_code: String,
}

pub struct NewParticipant {
    pub id: String,
    pub session_id: String,
    pub student_id: String,
    pub seat_number: i64,
    pub display_name: String,
    pub credential_hash: String,
    pub server_instance_id: String,
}

pub struct LocalSessionRepository;

impl LocalSessionRepository {
    pub fn create(
        database: &Database,
        input: NewLocalSession,
    ) -> Result<LocalSessionRecord, AppError> {
        let mut connection = database.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let classroom_exists = transaction
            .query_row(
                "SELECT 1 FROM classes WHERE id = ?1",
                [&input.classroom_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !classroom_exists {
            return Err(AppError::NotFound("classroom".to_owned()));
        }
        let active_exists = transaction
            .query_row(
                "SELECT 1 FROM local_sessions WHERE state IN ('CREATED', 'LOBBY', 'ACTIVE') LIMIT 1",
                [],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if active_exists {
            return Err(AppError::Conflict(
                "an active local session already exists".to_owned(),
            ));
        }
        let now = now_utc();
        transaction.execute(
            "INSERT INTO local_sessions(id, classroom_id, server_instance_id, state, join_mode, join_code, created_at, updated_at) VALUES (?1, ?2, ?3, 'CREATED', 'roster_match', ?4, ?5, ?5)",
            params![input.id, input.classroom_id, input.server_instance_id, input.join_code, now],
        ).map_err(|_| AppError::Conflict("could not create local session".to_owned()))?;
        transaction.commit()?;
        Self::get_by_id(database, &input.id)?.ok_or(AppError::Storage)
    }

    pub fn get_active(database: &Database) -> Result<Option<LocalSessionRecord>, AppError> {
        let connection = database.connection()?;
        connection
            .query_row(
                &session_select(
                    "WHERE s.state IN ('CREATED', 'LOBBY', 'ACTIVE') ORDER BY s.created_at DESC LIMIT 1",
                ),
                [],
                session_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn get_by_id(
        database: &Database,
        id: &str,
    ) -> Result<Option<LocalSessionRecord>, AppError> {
        let connection = database.connection()?;
        connection
            .query_row(&session_select("WHERE s.id = ?1"), [id], session_from_row)
            .optional()
            .map_err(Into::into)
    }

    pub fn get_by_join_code(
        database: &Database,
        join_code: &str,
    ) -> Result<Option<LocalSessionRecord>, AppError> {
        let connection = database.connection()?;
        connection
            .query_row(
                &session_select("WHERE s.join_code = ?1"),
                [join_code],
                session_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_history(
        database: &Database,
        classroom_id: &str,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<SessionHistoryRecord>, AppError> {
        let connection = database.connection()?;
        let mut statement = connection.prepare(
            "SELECT s.id,s.classroom_id,c.name,s.state,s.created_at,s.lobby_opened_at,s.ended_at,
                (SELECT COUNT(*) FROM session_participants p WHERE p.session_id=s.id),
                (SELECT COUNT(*) FROM session_questions q WHERE q.session_id=s.id AND q.state IN ('OPEN','LOCKED','REVEALED'))
             FROM local_sessions s JOIN classes c ON c.id=s.classroom_id
             WHERE s.classroom_id=?1 AND s.state='ENDED' AND s.ended_at IS NOT NULL
             ORDER BY s.ended_at DESC, s.id DESC LIMIT ?2 OFFSET ?3",
        )?;
        let rows = statement
            .query_map(params![classroom_id, limit, offset], |row| {
                Ok(SessionHistoryRecord {
                    session_id: row.get(0)?,
                    classroom_id: row.get(1)?,
                    classroom_name: row.get(2)?,
                    state: row.get(3)?,
                    created_at: row.get(4)?,
                    lobby_opened_at: row.get(5)?,
                    ended_at: row.get(6)?,
                    participant_count: row.get(7)?,
                    eligible_question_count: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn open_lobby(
        database: &Database,
        id: &str,
        server_instance_id: &str,
    ) -> Result<LocalSessionRecord, AppError> {
        let connection = database.connection()?;
        let now = now_utc();
        let changed = connection.execute(
            "UPDATE local_sessions SET state = 'LOBBY', lobby_opened_at = ?1, updated_at = ?1 WHERE id = ?2 AND state = 'CREATED' AND server_instance_id = ?3",
            params![now, id, server_instance_id],
        )?;
        if changed == 0 {
            return Err(session_transition_error(database, id, server_instance_id)?);
        }
        Self::get_by_id(database, id)?.ok_or(AppError::Storage)
    }

    pub fn end(
        database: &Database,
        id: &str,
        reason: &str,
    ) -> Result<LocalSessionRecord, AppError> {
        let mut connection = database.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_utc();
        let changed = transaction.execute(
            "UPDATE local_sessions SET state = 'ENDED', ended_at = ?1, ended_reason = ?2, updated_at = ?1 WHERE id = ?3 AND state IN ('CREATED', 'LOBBY', 'ACTIVE')",
            params![now, reason, id],
        )?;
        if changed == 0 {
            return Err(AppError::SessionNotOpen);
        }
        transaction.execute(
            "UPDATE session_grouping_drafts SET state='CANCELLED',updated_at=?1 WHERE session_id=?2 AND state IN ('DRAFT','OPEN')",
            params![now, id],
        )?;
        transaction.commit()?;
        Self::get_by_id(database, id)?.ok_or(AppError::Storage)
    }

    pub fn start(
        database: &Database,
        id: &str,
        server_instance_id: &str,
    ) -> Result<LocalSessionRecord, AppError> {
        let connection = database.connection()?;
        let now = now_utc();
        let changed = connection.execute(
            "UPDATE local_sessions SET state = 'ACTIVE', updated_at = ?1 WHERE id = ?2 AND state = 'LOBBY' AND server_instance_id = ?3",
            params![now, id, server_instance_id],
        )?;
        if changed == 0 {
            return Err(session_transition_error(database, id, server_instance_id)?);
        }
        Self::get_by_id(database, id)?.ok_or(AppError::Storage)
    }

    pub fn end_stale_sessions(database: &Database) -> Result<(), AppError> {
        let mut connection = database.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = now_utc();
        let mut stale_sessions = transaction.prepare(
            "SELECT id FROM local_sessions WHERE state IN ('CREATED', 'LOBBY', 'ACTIVE')",
        )?;
        let stale_session_ids = stale_sessions
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stale_sessions);
        transaction.execute(
            "UPDATE local_sessions SET state = 'ENDED', ended_at = ?1, ended_reason = 'server_restart', updated_at = ?1 WHERE state IN ('CREATED', 'LOBBY', 'ACTIVE')",
            [now.clone()],
        )?;
        for session_id in stale_session_ids {
            transaction.execute(
                "UPDATE session_grouping_drafts SET state='CANCELLED',updated_at=?1 WHERE session_id=?2 AND state IN ('DRAFT','OPEN')",
                params![now, session_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn roster_student(
        database: &Database,
        classroom_id: &str,
        seat_number: i64,
    ) -> Result<Option<Student>, AppError> {
        let connection = database.connection()?;
        connection.query_row(
            "SELECT id,class_id,seat_number,name,created_at,updated_at FROM students WHERE class_id = ?1 AND seat_number = ?2",
            params![classroom_id, seat_number],
            |row| Ok(Student { id: row.get(0)?, class_id: row.get(1)?, seat_number: row.get(2)?, name: row.get(3)?, created_at: row.get(4)?, updated_at: row.get(5)? }),
        ).optional().map_err(Into::into)
    }

    pub fn create_participant(
        database: &Database,
        input: NewParticipant,
    ) -> Result<ParticipantRecord, AppError> {
        let mut connection = database.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let active = transaction
            .query_row(
                "SELECT 1 FROM local_sessions WHERE id = ?1 AND state = 'LOBBY' AND server_instance_id = ?2",
                params![input.session_id, input.server_instance_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !active {
            return Err(AppError::SessionNotOpen);
        }
        let now = now_utc();
        transaction.execute(
            "INSERT INTO session_participants(id, session_id, student_id, seat_number, display_name, credential_hash, joined_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![input.id, input.session_id, input.student_id, input.seat_number, input.display_name, input.credential_hash, now],
        ).map_err(|error| match error {
            rusqlite::Error::SqliteFailure(ref failure, _) if failure.code == rusqlite::ErrorCode::ConstraintViolation => AppError::SeatAlreadyJoined,
            _ => AppError::Storage,
        })?;
        transaction.commit()?;
        Self::get_participant(database, &input.id)?.ok_or(AppError::Storage)
    }

    pub fn get_participant(
        database: &Database,
        id: &str,
    ) -> Result<Option<ParticipantRecord>, AppError> {
        let connection = database.connection()?;
        connection
            .query_row(
                &participant_select("WHERE p.id = ?1"),
                [id],
                participant_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_participants(
        database: &Database,
        session_id: &str,
    ) -> Result<Vec<ParticipantRecord>, AppError> {
        let connection = database.connection()?;
        let mut statement = connection.prepare(&participant_select(
            "WHERE p.session_id = ?1 ORDER BY p.seat_number, p.id",
        ))?;
        let participants = statement
            .query_map([session_id], participant_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        Ok(participants)
    }

    pub fn touch_authenticated(database: &Database, participant_id: &str) -> Result<(), AppError> {
        let connection = database.connection()?;
        connection.execute(
            "UPDATE session_participants SET last_authenticated_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now_utc(), participant_id],
        )?;
        Ok(())
    }
}

fn session_select(clause: &str) -> String {
    format!("SELECT s.id,s.classroom_id,c.name,s.server_instance_id,s.state,s.join_mode,s.join_code,s.created_at,s.lobby_opened_at,s.ended_at,s.ended_reason,s.updated_at FROM local_sessions s JOIN classes c ON c.id=s.classroom_id {clause}")
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalSessionRecord> {
    Ok(LocalSessionRecord {
        id: row.get(0)?,
        classroom_id: row.get(1)?,
        classroom_name: row.get(2)?,
        server_instance_id: row.get(3)?,
        state: row.get(4)?,
        join_mode: row.get(5)?,
        join_code: row.get(6)?,
        created_at: row.get(7)?,
        lobby_opened_at: row.get(8)?,
        ended_at: row.get(9)?,
        ended_reason: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn participant_select(clause: &str) -> String {
    format!("SELECT p.id,p.session_id,p.student_id,p.seat_number,p.display_name,p.credential_hash,p.joined_at,p.updated_at,p.last_authenticated_at FROM session_participants p {clause}")
}

fn participant_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ParticipantRecord> {
    Ok(ParticipantRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        student_id: row.get(2)?,
        seat_number: row.get(3)?,
        display_name: row.get(4)?,
        credential_hash: row.get(5)?,
        joined_at: row.get(6)?,
        updated_at: row.get(7)?,
        last_authenticated_at: row.get(8)?,
    })
}

fn session_transition_error(
    database: &Database,
    id: &str,
    server_instance_id: &str,
) -> Result<AppError, AppError> {
    let Some(session) = LocalSessionRepository::get_by_id(database, id)? else {
        return Ok(AppError::SessionNotFound);
    };
    if session.server_instance_id != server_instance_id {
        return Ok(AppError::ServerInstanceMismatch);
    }
    Ok(AppError::SessionNotOpen)
}
