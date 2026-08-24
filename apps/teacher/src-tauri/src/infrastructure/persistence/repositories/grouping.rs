use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::HashSet;

use unicode_normalization::UnicodeNormalization;

use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;

use super::{map_write_error, new_id, now_utc, validate_name};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftState {
    Draft,
    Open,
    Finalized,
    Cancelled,
}

impl DraftState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "DRAFT",
            Self::Open => "OPEN",
            Self::Finalized => "FINALIZED",
            Self::Cancelled => "CANCELLED",
        }
    }

    fn from_storage(value: String) -> Result<Self, AppError> {
        match value.as_str() {
            "DRAFT" => Ok(Self::Draft),
            "OPEN" => Ok(Self::Open),
            "FINALIZED" => Ok(Self::Finalized),
            "CANCELLED" => Ok(Self::Cancelled),
            _ => Err(AppError::Storage),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupPreset {
    pub id: String,
    pub classroom_id: String,
    pub name: String,
    pub configuration: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresetGroup {
    pub id: String,
    pub preset_id: String,
    pub name: String,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresetMember {
    pub id: String,
    pub preset_id: String,
    pub group_id: String,
    pub student_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct NewPresetGroup {
    pub id: String,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionGroupingDraft {
    pub id: String,
    pub session_id: String,
    pub state: DraftState,
    pub created_at: String,
    pub updated_at: String,
    pub groups: Vec<DraftGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftGroup {
    pub id: String,
    pub draft_id: String,
    pub name: String,
    pub position: i64,
    pub capacity: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub members: Vec<DraftMember>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftMember {
    pub id: String,
    pub draft_id: String,
    pub group_id: String,
    pub participant_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct NewDraftGroup {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub capacity: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionGroupSet {
    pub id: String,
    pub session_id: String,
    pub revision: i64,
    pub created_at: String,
    pub groups: Vec<SessionGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionGroup {
    pub id: String,
    pub group_set_id: String,
    pub name: String,
    pub position: i64,
    pub created_at: String,
    pub members: Vec<SessionGroupMember>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionGroupMember {
    pub id: String,
    pub group_set_id: String,
    pub group_id: String,
    pub participant_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnassignedParticipant {
    pub id: String,
    pub session_id: String,
    pub seat_number: i64,
    pub display_name: String,
}

pub struct GroupingRepository;

impl GroupingRepository {
    pub fn create_preset(
        database: &Database,
        classroom_id: &str,
        name: &str,
        groups: &[NewPresetGroup],
    ) -> Result<GroupPreset, AppError> {
        validate_name(name)?;
        validate_group_inputs(groups)?;
        let mut connection = database.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let classroom_exists = transaction
            .query_row("SELECT 1 FROM classes WHERE id=?1", [classroom_id], |_| {
                Ok(())
            })
            .optional()?
            .is_some();
        if !classroom_exists {
            return Err(AppError::NotFound("classroom".to_owned()));
        }
        let preset_id = new_id();
        let now = now_utc();
        transaction.execute(
            "INSERT INTO group_presets(id,class_id,name,configuration,created_at,updated_at) VALUES (?1,?2,?3,'{}',?4,?4)",
            params![preset_id, classroom_id, name.trim(), now],
        ).map_err(map_write_error)?;
        for group in groups {
            transaction.execute(
                "INSERT INTO group_preset_groups(id,preset_id,name,position,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
                params![group.id, preset_id, group.name.trim(), group.position, now],
            ).map_err(map_write_error)?;
        }
        transaction.commit()?;
        Self::get_preset(database, &preset_id)?.ok_or(AppError::Storage)
    }

    pub fn list_presets(
        database: &Database,
        classroom_id: &str,
    ) -> Result<Vec<GroupPreset>, AppError> {
        let connection = database.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,class_id,name,configuration,created_at,updated_at FROM group_presets WHERE class_id=?1 ORDER BY name,id",
        )?;
        let rows = statement
            .query_map([classroom_id], preset_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_preset(
        database: &Database,
        preset_id: &str,
    ) -> Result<Option<GroupPreset>, AppError> {
        let connection = database.connection()?;
        connection
            .query_row(
                "SELECT id,class_id,name,configuration,created_at,updated_at FROM group_presets WHERE id=?1",
                [preset_id],
                preset_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_preset_groups(
        database: &Database,
        preset_id: &str,
    ) -> Result<Vec<PresetGroup>, AppError> {
        let connection = database.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,preset_id,name,position,created_at,updated_at FROM group_preset_groups WHERE preset_id=?1 ORDER BY position,id",
        )?;
        let rows = statement
            .query_map([preset_id], preset_group_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn list_preset_members(
        database: &Database,
        preset_id: &str,
    ) -> Result<Vec<PresetMember>, AppError> {
        let connection = database.connection()?;
        let mut statement = connection.prepare(
            "SELECT id,preset_id,group_id,student_id,created_at,updated_at FROM group_preset_members WHERE preset_id=?1 ORDER BY group_id,student_id",
        )?;
        let rows = statement
            .query_map([preset_id], preset_member_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn replace_preset_members(
        database: &Database,
        preset_id: &str,
        assignments: &[(String, String)],
    ) -> Result<Vec<PresetMember>, AppError> {
        let mut connection = database.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let classroom_id: Option<String> = transaction
            .query_row(
                "SELECT class_id FROM group_presets WHERE id=?1",
                [preset_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(classroom_id) = classroom_id else {
            return Err(AppError::GroupPresetNotFound);
        };
        transaction.execute(
            "DELETE FROM group_preset_members WHERE preset_id=?1",
            [preset_id],
        )?;
        let now = now_utc();
        for (group_id, student_id) in assignments {
            let group_exists = transaction
                .query_row(
                    "SELECT 1 FROM group_preset_groups WHERE id=?1 AND preset_id=?2",
                    params![group_id, preset_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !group_exists {
                return Err(AppError::GroupNotFound);
            }
            let student_class: Option<String> = transaction
                .query_row(
                    "SELECT class_id FROM students WHERE id=?1",
                    [student_id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(student_class) = student_class else {
                return Err(AppError::NotFound("student".to_owned()));
            };
            if student_class != classroom_id {
                return Err(AppError::StudentClassroomMismatch);
            }
            transaction
                .execute(
                    "INSERT INTO group_preset_members(id,preset_id,group_id,student_id,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
                    params![new_id(), preset_id, group_id, student_id, now],
                )
                .map_err(map_write_error)?;
        }
        transaction.commit()?;
        Self::list_preset_members(database, preset_id)
    }

    pub fn delete_preset(database: &Database, preset_id: &str) -> Result<(), AppError> {
        let connection = database.connection()?;
        if connection.execute("DELETE FROM group_presets WHERE id=?1", [preset_id])? == 0 {
            return Err(AppError::GroupPresetNotFound);
        }
        Ok(())
    }

    pub fn create_draft(
        database: &Database,
        session_id: &str,
        draft_id: &str,
        groups: &[NewDraftGroup],
    ) -> Result<SessionGroupingDraft, AppError> {
        validate_draft_group_inputs(groups)?;
        let mut connection = database.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_session_can_group(&transaction, session_id)?;
        let active = transaction
            .query_row(
                "SELECT 1 FROM session_grouping_drafts WHERE session_id=?1 AND state IN ('DRAFT','OPEN') LIMIT 1",
                [session_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if active {
            return Err(AppError::ActiveDraftExists);
        }
        let now = now_utc();
        transaction.execute(
            "INSERT INTO session_grouping_drafts(id,session_id,state,created_at,updated_at) VALUES (?1,?2,'DRAFT',?3,?3)",
            params![draft_id, session_id, now],
        ).map_err(map_write_error)?;
        insert_draft_groups(&transaction, draft_id, groups, &now)?;
        transaction.commit()?;
        Self::get_draft(database, draft_id)?.ok_or(AppError::Storage)
    }

    pub fn clone_current_to_draft(
        database: &Database,
        session_id: &str,
        draft_id: &str,
    ) -> Result<SessionGroupingDraft, AppError> {
        let mut connection = database.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_session_can_group(&transaction, session_id)?;
        let active = transaction
            .query_row(
                "SELECT 1 FROM session_grouping_drafts WHERE session_id=?1 AND state IN ('DRAFT','OPEN') LIMIT 1",
                [session_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if active {
            return Err(AppError::ActiveDraftExists);
        }
        let Some(group_set_id) = transaction
            .query_row(
                "SELECT id FROM session_group_sets WHERE session_id=?1 ORDER BY revision DESC LIMIT 1",
                [session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        else {
            return Err(AppError::NotFound("group set".to_owned()));
        };
        let now = now_utc();
        transaction.execute(
            "INSERT INTO session_grouping_drafts(id,session_id,state,created_at,updated_at) VALUES (?1,?2,'DRAFT',?3,?3)",
            params![draft_id, session_id, now],
        ).map_err(map_write_error)?;
        let mut groups = transaction.prepare(
            "SELECT id,name,position FROM session_groups WHERE group_set_id=?1 ORDER BY position,id",
        )?;
        let group_rows = groups
            .query_map([&group_set_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(groups);
        for (source_group_id, name, position) in group_rows {
            let new_group_id = new_id();
            transaction.execute(
                "INSERT INTO session_grouping_draft_groups(id,draft_id,name,position,capacity,created_at,updated_at) VALUES (?1,?2,?3,?4,NULL,?5,?5)",
                params![new_group_id, draft_id, name, position, now],
            ).map_err(map_write_error)?;
            let mut members = transaction.prepare(
                "SELECT participant_id FROM session_group_members WHERE group_set_id=?1 AND group_id=?2 ORDER BY participant_id",
            )?;
            let participant_ids = members
                .query_map(params![group_set_id, source_group_id], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(members);
            for participant_id in participant_ids {
                transaction.execute(
                    "INSERT INTO session_grouping_draft_members(id,draft_id,group_id,participant_id,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
                    params![new_id(), draft_id, new_group_id, participant_id, now],
                ).map_err(map_write_error)?;
            }
        }
        transaction.commit()?;
        Self::get_draft(database, draft_id)?.ok_or(AppError::Storage)
    }

    pub fn get_draft(
        database: &Database,
        draft_id: &str,
    ) -> Result<Option<SessionGroupingDraft>, AppError> {
        let connection = database.connection()?;
        load_draft(&connection, draft_id)
    }

    pub fn get_active_draft(
        database: &Database,
        session_id: &str,
    ) -> Result<Option<SessionGroupingDraft>, AppError> {
        let connection = database.connection()?;
        let draft_id = connection
            .query_row(
                "SELECT id FROM session_grouping_drafts WHERE session_id=?1 AND state IN ('DRAFT','OPEN') ORDER BY created_at DESC,id DESC LIMIT 1",
                [session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match draft_id {
            Some(id) => load_draft(&connection, &id),
            None => Ok(None),
        }
    }

    pub fn open_draft(
        database: &Database,
        draft_id: &str,
    ) -> Result<SessionGroupingDraft, AppError> {
        let mut connection = database.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(session_id) = transaction
            .query_row(
                "SELECT session_id FROM session_grouping_drafts WHERE id=?1",
                [draft_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        else {
            return Err(AppError::NotFound("grouping draft".to_owned()));
        };
        ensure_session_can_group(&transaction, &session_id)?;
        let state: String = transaction.query_row(
            "SELECT state FROM session_grouping_drafts WHERE id=?1",
            [draft_id],
            |row| row.get(0),
        )?;
        if state == DraftState::Open.as_str() {
            transaction.commit()?;
            return Self::get_draft(database, draft_id)?.ok_or(AppError::Storage);
        }
        if state != DraftState::Draft.as_str() {
            return Err(AppError::DraftNotOpen);
        }
        transaction.execute(
            "UPDATE session_grouping_drafts SET state='OPEN',updated_at=?1 WHERE id=?2",
            params![now_utc(), draft_id],
        )?;
        transaction.commit()?;
        Self::get_draft(database, draft_id)?.ok_or(AppError::Storage)
    }

    pub fn move_draft_member(
        database: &Database,
        draft_id: &str,
        participant_id: &str,
        target_group_id: Option<&str>,
    ) -> Result<SessionGroupingDraft, AppError> {
        let mut connection = database.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some((session_id, state)) = transaction
            .query_row(
                "SELECT session_id,state FROM session_grouping_drafts WHERE id=?1",
                [draft_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        else {
            return Err(AppError::NotFound("grouping draft".to_owned()));
        };
        ensure_session_can_group(&transaction, &session_id)?;
        if state != DraftState::Open.as_str() {
            return Err(AppError::DraftNotOpen);
        }
        let participant_session: Option<String> = transaction
            .query_row(
                "SELECT session_id FROM session_participants WHERE id=?1",
                [participant_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(participant_session) = participant_session else {
            return Err(AppError::ParticipantNotFound);
        };
        if participant_session != session_id {
            return Err(AppError::ParticipantSessionMismatch);
        }
        let current_group: Option<String> = transaction
            .query_row(
                "SELECT group_id FROM session_grouping_draft_members WHERE draft_id=?1 AND participant_id=?2",
                params![draft_id, participant_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(group_id) = target_group_id {
            let group_exists = transaction
                .query_row(
                    "SELECT 1 FROM session_grouping_draft_groups WHERE id=?1 AND draft_id=?2",
                    params![group_id, draft_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !group_exists {
                return Err(AppError::GroupNotFound);
            }
            if current_group.as_deref() != Some(group_id) {
                let capacity: Option<i64> = transaction.query_row(
                    "SELECT capacity FROM session_grouping_draft_groups WHERE id=?1 AND draft_id=?2",
                    params![group_id, draft_id],
                    |row| row.get(0),
                )?;
                let count: i64 = transaction.query_row(
                    "SELECT COUNT(*) FROM session_grouping_draft_members WHERE draft_id=?1 AND group_id=?2",
                    params![draft_id, group_id],
                    |row| row.get(0),
                )?;
                if capacity.is_some_and(|limit| count >= limit) {
                    return Err(AppError::GroupFull);
                }
                transaction.execute(
                    "DELETE FROM session_grouping_draft_members WHERE draft_id=?1 AND participant_id=?2",
                    params![draft_id, participant_id],
                )?;
                let now = now_utc();
                transaction.execute(
                    "INSERT INTO session_grouping_draft_members(id,draft_id,group_id,participant_id,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
                    params![new_id(), draft_id, group_id, participant_id, now],
                ).map_err(map_write_error)?;
            }
        } else {
            transaction.execute(
                "DELETE FROM session_grouping_draft_members WHERE draft_id=?1 AND participant_id=?2",
                params![draft_id, participant_id],
            )?;
        }
        transaction.execute(
            "UPDATE session_grouping_drafts SET updated_at=?1 WHERE id=?2",
            params![now_utc(), draft_id],
        )?;
        transaction.commit()?;
        Self::get_draft(database, draft_id)?.ok_or(AppError::Storage)
    }

    pub fn finalize_draft(
        database: &Database,
        draft_id: &str,
    ) -> Result<SessionGroupSet, AppError> {
        let mut connection = database.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some((session_id, state)) = transaction
            .query_row(
                "SELECT session_id,state FROM session_grouping_drafts WHERE id=?1",
                [draft_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        else {
            return Err(AppError::NotFound("grouping draft".to_owned()));
        };
        ensure_session_can_group(&transaction, &session_id)?;
        if !matches!(state.as_str(), "DRAFT" | "OPEN") {
            return Err(AppError::DraftNotOpen);
        }
        let revision: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(revision),0)+1 FROM session_group_sets WHERE session_id=?1",
            [&session_id],
            |row| row.get(0),
        )?;
        let group_set_id = new_id();
        let now = now_utc();
        transaction
            .execute(
                "INSERT INTO session_group_sets(id,session_id,revision,created_at) VALUES (?1,?2,?3,?4)",
                params![group_set_id, session_id, revision, now],
            )
            .map_err(|error| match error {
                rusqlite::Error::SqliteFailure(ref failure, _)
                    if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    AppError::RevisionConflict
                }
                _ => AppError::Storage,
            })?;
        let mut groups = transaction.prepare(
            "SELECT id,name,position FROM session_grouping_draft_groups WHERE draft_id=?1 ORDER BY position,id",
        )?;
        let group_rows = groups
            .query_map([draft_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(groups);
        for (draft_group_id, name, position) in group_rows {
            let group_id = new_id();
            transaction.execute(
                "INSERT INTO session_groups(id,group_set_id,name,position,created_at) VALUES (?1,?2,?3,?4,?5)",
                params![group_id, group_set_id, name, position, now],
            ).map_err(map_write_error)?;
            let mut members = transaction.prepare(
                "SELECT participant_id FROM session_grouping_draft_members WHERE draft_id=?1 AND group_id=?2 ORDER BY participant_id",
            )?;
            let participant_ids = members
                .query_map(params![draft_id, draft_group_id], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(members);
            for participant_id in participant_ids {
                transaction.execute(
                    "INSERT INTO session_group_members(id,group_set_id,group_id,participant_id,created_at) VALUES (?1,?2,?3,?4,?5)",
                    params![new_id(), group_set_id, group_id, participant_id, now],
                ).map_err(map_write_error)?;
            }
        }
        transaction.execute(
            "UPDATE session_grouping_drafts SET state='FINALIZED',updated_at=?1 WHERE id=?2",
            params![now, draft_id],
        )?;
        transaction.commit()?;
        Self::get_group_set(database, &group_set_id)?.ok_or(AppError::Storage)
    }

    pub fn get_current_group_set(
        database: &Database,
        session_id: &str,
    ) -> Result<Option<SessionGroupSet>, AppError> {
        let connection = database.connection()?;
        let group_set_id = connection
            .query_row(
                "SELECT id FROM session_group_sets WHERE session_id=?1 ORDER BY revision DESC LIMIT 1",
                [session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match group_set_id {
            Some(id) => load_group_set(&connection, &id),
            None => Ok(None),
        }
    }

    pub fn get_group_set(
        database: &Database,
        group_set_id: &str,
    ) -> Result<Option<SessionGroupSet>, AppError> {
        let connection = database.connection()?;
        load_group_set(&connection, group_set_id)
    }

    pub fn get_group_set_revision(
        database: &Database,
        session_id: &str,
        revision: i64,
    ) -> Result<Option<SessionGroupSet>, AppError> {
        let connection = database.connection()?;
        let group_set_id = connection
            .query_row(
                "SELECT id FROM session_group_sets WHERE session_id=?1 AND revision=?2",
                params![session_id, revision],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match group_set_id {
            Some(id) => load_group_set(&connection, &id),
            None => Ok(None),
        }
    }

    pub fn list_group_set_revisions(
        database: &Database,
        session_id: &str,
    ) -> Result<Vec<SessionGroupSet>, AppError> {
        let connection = database.connection()?;
        let mut statement = connection
            .prepare("SELECT id FROM session_group_sets WHERE session_id=?1 ORDER BY revision")?;
        let ids = statement
            .query_map([session_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.into_iter()
            .map(|id| load_group_set(&connection, &id)?.ok_or(AppError::Storage))
            .collect()
    }

    pub fn list_unassigned_participants(
        database: &Database,
        session_id: &str,
        group_set_id: Option<&str>,
    ) -> Result<Vec<UnassignedParticipant>, AppError> {
        let connection = database.connection()?;
        if let Some(group_set_id) = group_set_id {
            let belongs = connection
                .query_row(
                    "SELECT 1 FROM session_group_sets WHERE id=?1 AND session_id=?2",
                    params![group_set_id, session_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !belongs {
                return Err(AppError::NotFound("group set".to_owned()));
            }
        }
        let mut statement = connection.prepare(
            "SELECT p.id,p.session_id,p.seat_number,p.display_name
             FROM session_participants p
             WHERE p.session_id=?1
               AND (?2 IS NULL OR NOT EXISTS (
                   SELECT 1 FROM session_group_members m
                   WHERE m.group_set_id=?2 AND m.participant_id=p.id
               ))
             ORDER BY p.seat_number,p.id",
        )?;
        let rows = statement
            .query_map(params![session_id, group_set_id], |row| {
                Ok(UnassignedParticipant {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    seat_number: row.get(2)?,
                    display_name: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

fn validate_group_inputs(groups: &[NewPresetGroup]) -> Result<(), AppError> {
    let mut names = HashSet::new();
    for group in groups {
        validate_name(&group.name)?;
        if !names.insert(normalized_name(&group.name)) {
            return Err(AppError::Conflict("group names must be unique".to_owned()));
        }
        if group.position < 0 {
            return Err(AppError::Validation(
                "group position must not be negative".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_draft_group_inputs(groups: &[NewDraftGroup]) -> Result<(), AppError> {
    let mut names = HashSet::new();
    for group in groups {
        validate_name(&group.name)?;
        if !names.insert(normalized_name(&group.name)) {
            return Err(AppError::Conflict("group names must be unique".to_owned()));
        }
        if group.position < 0 {
            return Err(AppError::Validation(
                "group position must not be negative".to_owned(),
            ));
        }
        if group.capacity.is_some_and(|capacity| capacity < 1) {
            return Err(AppError::Validation(
                "group capacity must be positive".to_owned(),
            ));
        }
    }
    Ok(())
}

fn normalized_name(name: &str) -> String {
    name.trim().nfkc().collect::<String>()
}

fn insert_draft_groups(
    transaction: &Transaction<'_>,
    draft_id: &str,
    groups: &[NewDraftGroup],
    now: &str,
) -> Result<(), AppError> {
    for group in groups {
        transaction
            .execute(
                "INSERT INTO session_grouping_draft_groups(id,draft_id,name,position,capacity,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)",
                params![group.id, draft_id, group.name.trim(), group.position, group.capacity, now],
            )
            .map_err(map_write_error)?;
    }
    Ok(())
}

fn ensure_session_can_group(
    transaction: &Transaction<'_>,
    session_id: &str,
) -> Result<(), AppError> {
    let state: Option<String> = transaction
        .query_row(
            "SELECT state FROM local_sessions WHERE id=?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()?;
    match state.as_deref() {
        None => Err(AppError::SessionNotFound),
        Some("ENDED") => Err(AppError::SessionEnded),
        Some("LOBBY") | Some("ACTIVE") => Ok(()),
        Some(_) => Err(AppError::SessionNotOpen),
    }
}

fn preset_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GroupPreset> {
    Ok(GroupPreset {
        id: row.get(0)?,
        classroom_id: row.get(1)?,
        name: row.get(2)?,
        configuration: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn preset_group_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PresetGroup> {
    Ok(PresetGroup {
        id: row.get(0)?,
        preset_id: row.get(1)?,
        name: row.get(2)?,
        position: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn preset_member_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PresetMember> {
    Ok(PresetMember {
        id: row.get(0)?,
        preset_id: row.get(1)?,
        group_id: row.get(2)?,
        student_id: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn load_draft(
    connection: &rusqlite::Connection,
    draft_id: &str,
) -> Result<Option<SessionGroupingDraft>, AppError> {
    let Some((id, session_id, state, created_at, updated_at)) = connection
        .query_row(
            "SELECT id,session_id,state,created_at,updated_at FROM session_grouping_drafts WHERE id=?1",
            [draft_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(None);
    };
    let state = DraftState::from_storage(state)?;
    let mut groups_statement = connection.prepare(
        "SELECT id,draft_id,name,position,capacity,created_at,updated_at FROM session_grouping_draft_groups WHERE draft_id=?1 ORDER BY position,id",
    )?;
    let groups = groups_statement
        .query_map([draft_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(groups_statement);
    let groups = groups
        .into_iter()
        .map(|(id, draft_id, name, position, capacity, created_at, updated_at)| {
            let mut members_statement = connection.prepare(
                "SELECT id,draft_id,group_id,participant_id,created_at,updated_at FROM session_grouping_draft_members WHERE draft_id=?1 AND group_id=?2 ORDER BY participant_id",
            )?;
            let members = members_statement
                .query_map(params![draft_id, id], draft_member_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(DraftGroup {
                id,
                draft_id,
                name,
                position,
                capacity,
                created_at,
                updated_at,
                members,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    Ok(Some(SessionGroupingDraft {
        id,
        session_id,
        state,
        created_at,
        updated_at,
        groups,
    }))
}

fn draft_member_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DraftMember> {
    Ok(DraftMember {
        id: row.get(0)?,
        draft_id: row.get(1)?,
        group_id: row.get(2)?,
        participant_id: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn load_group_set(
    connection: &rusqlite::Connection,
    group_set_id: &str,
) -> Result<Option<SessionGroupSet>, AppError> {
    let Some((id, session_id, revision, created_at)) = connection
        .query_row(
            "SELECT id,session_id,revision,created_at FROM session_group_sets WHERE id=?1",
            [group_set_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(None);
    };
    let mut groups_statement = connection.prepare(
        "SELECT id,group_set_id,name,position,created_at FROM session_groups WHERE group_set_id=?1 ORDER BY position,id",
    )?;
    let groups = groups_statement
        .query_map([group_set_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(groups_statement);
    let groups = groups
        .into_iter()
        .map(|(id, group_set_id, name, position, created_at)| {
            let mut members_statement = connection.prepare(
                "SELECT id,group_set_id,group_id,participant_id,created_at FROM session_group_members WHERE group_set_id=?1 AND group_id=?2 ORDER BY participant_id",
            )?;
            let members = members_statement
                .query_map(params![group_set_id, id], session_group_member_from_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(SessionGroup {
                id,
                group_set_id,
                name,
                position,
                created_at,
                members,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    Ok(Some(SessionGroupSet {
        id,
        session_id,
        revision,
        created_at,
        groups,
    }))
}

fn session_group_member_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionGroupMember> {
    Ok(SessionGroupMember {
        id: row.get(0)?,
        group_set_id: row.get(1)?,
        group_id: row.get(2)?,
        participant_id: row.get(3)?,
        created_at: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::thread;

    use tempfile::tempdir;
    use uuid::Uuid;

    use super::*;
    use crate::application::{CreateClassroomRequest, CreateStudentRequest, PersistenceService};
    use crate::infrastructure::persistence::repositories::local_session::{
        LocalSessionRepository, NewLocalSession, NewParticipant,
    };

    struct Fixture {
        database: Database,
        classroom_id: String,
        session_id: String,
        participants: Vec<String>,
    }

    fn fixture() -> Fixture {
        let directory = tempdir().expect("temp directory");
        let directory = Arc::new(directory);
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database.initialize().expect("database");
        let service = PersistenceService::initialize(directory.path()).expect("service");
        let classroom = service
            .create_classroom(CreateClassroomRequest {
                name: "11A".to_owned(),
                academic_year: None,
            })
            .expect("classroom");
        let student_ids = (1..=4)
            .map(|seat| {
                service
                    .create_student(CreateStudentRequest {
                        class_id: classroom.id.clone(),
                        seat_number: seat,
                        name: format!("Student {seat}"),
                    })
                    .expect("student")
                    .id
            })
            .collect::<Vec<_>>();
        let session_id = Uuid::now_v7().to_string();
        LocalSessionRepository::create(
            &database,
            NewLocalSession {
                id: session_id.clone(),
                classroom_id: classroom.id.clone(),
                server_instance_id: "server".to_owned(),
                join_code: "ABCDEFGH".to_owned(),
            },
        )
        .expect("session");
        LocalSessionRepository::open_lobby(&database, &session_id, "server").expect("lobby");
        let participants = student_ids
            .into_iter()
            .enumerate()
            .map(|(index, student_id)| {
                let participant_id = Uuid::now_v7().to_string();
                LocalSessionRepository::create_participant(
                    &database,
                    NewParticipant {
                        id: participant_id.clone(),
                        session_id: session_id.clone(),
                        student_id,
                        seat_number: index as i64 + 1,
                        display_name: format!("Student {}", index + 1),
                        credential_hash: "hash".to_owned(),
                        server_instance_id: "server".to_owned(),
                    },
                )
                .expect("participant");
                participant_id
            })
            .collect();
        std::mem::forget(directory);
        Fixture {
            database,
            classroom_id: classroom.id,
            session_id,
            participants,
        }
    }

    fn group(id: &str, name: &str, position: i64, capacity: Option<i64>) -> NewDraftGroup {
        NewDraftGroup {
            id: id.to_owned(),
            name: name.to_owned(),
            position,
            capacity,
        }
    }

    #[test]
    fn preset_constraints_and_student_delete_are_safe() {
        let fixture = fixture();
        let student =
            LocalSessionRepository::list_participants(&fixture.database, &fixture.session_id)
                .expect("participants")[0]
                .student_id
                .clone()
                .expect("student");
        assert!(GroupingRepository::create_preset(
            &fixture.database,
            &fixture.classroom_id,
            "Blank group",
            &[NewPresetGroup {
                id: new_id(),
                name: "   ".to_owned(),
                position: 0,
            }],
        )
        .is_err());
        assert!(GroupingRepository::create_preset(
            &fixture.database,
            &fixture.classroom_id,
            "Duplicate position",
            &[
                NewPresetGroup {
                    id: new_id(),
                    name: "A".to_owned(),
                    position: 0,
                },
                NewPresetGroup {
                    id: new_id(),
                    name: "B".to_owned(),
                    position: 0,
                },
            ],
        )
        .is_err());
        let other_service =
            PersistenceService::initialize(fixture.database.path().parent().expect("parent"))
                .expect("other service");
        let other_classroom = other_service
            .create_classroom(CreateClassroomRequest {
                name: "11B".to_owned(),
                academic_year: None,
            })
            .expect("other classroom");
        let preset = GroupingRepository::create_preset(
            &fixture.database,
            &fixture.classroom_id,
            "Preset",
            &[
                NewPresetGroup {
                    id: new_id(),
                    name: "A".to_owned(),
                    position: 1,
                },
                NewPresetGroup {
                    id: new_id(),
                    name: "B".to_owned(),
                    position: 2,
                },
            ],
        )
        .expect("preset");
        let groups =
            GroupingRepository::list_preset_groups(&fixture.database, &preset.id).expect("groups");
        GroupingRepository::replace_preset_members(
            &fixture.database,
            &preset.id,
            &[(groups[0].id.clone(), student.clone())],
        )
        .expect("member");
        let second_preset = GroupingRepository::create_preset(
            &fixture.database,
            &fixture.classroom_id,
            "Second preset",
            &[NewPresetGroup {
                id: new_id(),
                name: "Other group".to_owned(),
                position: 0,
            }],
        )
        .expect("second preset");
        let second_group =
            GroupingRepository::list_preset_groups(&fixture.database, &second_preset.id)
                .expect("second groups")[0]
                .id
                .clone();
        assert!(GroupingRepository::replace_preset_members(
            &fixture.database,
            &second_preset.id,
            &[(second_group, student.clone())],
        )
        .is_ok());
        assert!(GroupingRepository::replace_preset_members(
            &fixture.database,
            &preset.id,
            &[
                (groups[0].id.clone(), student.clone()),
                (groups[1].id.clone(), student.clone()),
            ],
        )
        .is_err());
        assert!(GroupingRepository::replace_preset_members(
            &fixture.database,
            &preset.id,
            &[(groups[0].id.clone(), student.clone())],
        )
        .is_ok());
        let other_student = other_service
            .create_student(CreateStudentRequest {
                class_id: other_classroom.id,
                seat_number: 1,
                name: "Other".to_owned(),
            })
            .expect("other student");
        assert!(matches!(
            GroupingRepository::replace_preset_members(
                &fixture.database,
                &preset.id,
                &[(groups[0].id.clone(), other_student.id)],
            ),
            Err(AppError::StudentClassroomMismatch)
        ));
        crate::infrastructure::persistence::repositories::StudentRepository::delete(
            &fixture.database,
            &student,
        )
        .expect("delete student");
        assert!(
            GroupingRepository::list_preset_members(&fixture.database, &preset.id)
                .expect("members")
                .is_empty()
        );
        GroupingRepository::delete_preset(&fixture.database, &preset.id).expect("delete preset");
        let connection = fixture.database.connection().expect("connection");
        let group_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM group_preset_groups WHERE preset_id=?1",
                [&preset.id],
                |row| row.get(0),
            )
            .expect("groups");
        assert_eq!(group_count, 0);
    }

    #[test]
    fn draft_capacity_move_and_finalize_are_atomic_and_snapshot_revisions() {
        let fixture = fixture();
        let draft = GroupingRepository::create_draft(
            &fixture.database,
            &fixture.session_id,
            "draft-1",
            &[
                group("group-a", "A", 0, Some(1)),
                group("group-b", "B", 1, None),
            ],
        )
        .expect("draft");
        assert!(matches!(draft.state, DraftState::Draft));
        assert!(matches!(
            GroupingRepository::create_draft(
                &fixture.database,
                &fixture.session_id,
                "draft-duplicate",
                &[],
            ),
            Err(AppError::ActiveDraftExists)
        ));
        assert!(matches!(
            GroupingRepository::move_draft_member(
                &fixture.database,
                &draft.id,
                &fixture.participants[0],
                Some("group-a"),
            ),
            Err(AppError::DraftNotOpen)
        ));
        GroupingRepository::open_draft(&fixture.database, &draft.id).expect("open");
        let other_student_id =
            LocalSessionRepository::get_participant(&fixture.database, &fixture.participants[1])
                .expect("participant")
                .expect("participant exists")
                .student_id
                .expect("student");
        let other_participant_id = "other-session-participant";
        let connection = fixture.database.connection().expect("connection");
        connection
            .execute(
                "INSERT INTO local_sessions(id,classroom_id,server_instance_id,state,join_mode,join_code,created_at,ended_at,ended_reason,updated_at) VALUES ('other-session',?1,'other-server','ENDED','roster_match','IJKLMNOP','now','now','test','now')",
                [&fixture.classroom_id],
            )
            .expect("other session");
        connection
            .execute(
                "INSERT INTO session_participants(id,session_id,student_id,seat_number,display_name,credential_hash,joined_at,updated_at) VALUES (?1,'other-session',?2,1,'Other','hash','now','now')",
                params![other_participant_id, other_student_id],
            )
            .expect("other participant");
        assert!(matches!(
            GroupingRepository::move_draft_member(
                &fixture.database,
                &draft.id,
                other_participant_id,
                Some("group-a"),
            ),
            Err(AppError::ParticipantSessionMismatch)
        ));
        GroupingRepository::move_draft_member(
            &fixture.database,
            &draft.id,
            &fixture.participants[0],
            Some("group-a"),
        )
        .expect("assign");
        assert!(matches!(
            GroupingRepository::move_draft_member(
                &fixture.database,
                &draft.id,
                &fixture.participants[1],
                Some("group-a"),
            ),
            Err(AppError::GroupFull)
        ));
        let draft = GroupingRepository::get_draft(&fixture.database, &draft.id)
            .expect("draft")
            .expect("draft exists");
        assert_eq!(draft.groups[0].members.len(), 1);
        let first = GroupingRepository::finalize_draft(&fixture.database, &draft.id).expect("rev1");
        assert_eq!(first.revision, 1);
        assert_eq!(first.groups[0].members.len(), 1);
        assert!(matches!(
            GroupingRepository::move_draft_member(
                &fixture.database,
                &draft.id,
                &fixture.participants[0],
                None,
            ),
            Err(AppError::DraftNotOpen)
        ));
        let cloned = GroupingRepository::clone_current_to_draft(
            &fixture.database,
            &fixture.session_id,
            "draft-2",
        )
        .expect("clone");
        let cloned_target_group = cloned.groups[1].id.clone();
        GroupingRepository::open_draft(&fixture.database, &cloned.id).expect("open clone");
        GroupingRepository::move_draft_member(
            &fixture.database,
            &cloned.id,
            &fixture.participants[0],
            Some(&cloned_target_group),
        )
        .expect("move");
        let second =
            GroupingRepository::finalize_draft(&fixture.database, &cloned.id).expect("rev2");
        assert_eq!(second.revision, 2);
        assert_eq!(
            GroupingRepository::get_group_set_revision(&fixture.database, &fixture.session_id, 1)
                .expect("rev1 read")
                .expect("rev1")
                .groups[0]
                .members[0]
                .participant_id,
            fixture.participants[0]
        );
        assert_eq!(
            GroupingRepository::list_group_set_revisions(&fixture.database, &fixture.session_id)
                .expect("revisions")
                .len(),
            2
        );
        let reopened = Database::open(fixture.database.path());
        reopened.initialize().expect("reopen");
        assert_eq!(
            GroupingRepository::get_current_group_set(&reopened, &fixture.session_id)
                .expect("current")
                .expect("current set")
                .revision,
            2
        );
        assert!(GroupingRepository::list_unassigned_participants(
            &fixture.database,
            &fixture.session_id,
            Some(&second.id),
        )
        .expect("unassigned")
        .iter()
        .any(|participant| participant.id == fixture.participants[1]));
    }

    #[test]
    fn concurrent_capacity_attempts_have_one_winner() {
        let fixture = fixture();
        let draft = GroupingRepository::create_draft(
            &fixture.database,
            &fixture.session_id,
            "draft-concurrent",
            &[group("group-a", "A", 0, Some(1))],
        )
        .expect("draft");
        GroupingRepository::open_draft(&fixture.database, &draft.id).expect("open");
        let database = fixture.database.clone();
        let draft_id = draft.id.clone();
        let first_participant = fixture.participants[0].clone();
        let second_participant = fixture.participants[1].clone();
        let first = thread::spawn({
            let database = database.clone();
            let draft_id = draft_id.clone();
            move || {
                GroupingRepository::move_draft_member(
                    &database,
                    &draft_id,
                    &first_participant,
                    Some("group-a"),
                )
            }
        });
        let second_draft_id = draft_id.clone();
        let second = thread::spawn(move || {
            GroupingRepository::move_draft_member(
                &database,
                &second_draft_id,
                &second_participant,
                Some("group-a"),
            )
        });
        let first_result = first.join().expect("first join");
        let second_result = second.join().expect("second join");
        let full_count = [first_result, second_result]
            .iter()
            .filter(|result| matches!(result, Err(AppError::GroupFull)))
            .count();
        assert_eq!(full_count, 1);
        let draft = GroupingRepository::get_draft(&fixture.database, &draft_id)
            .expect("draft")
            .expect("draft exists");
        assert_eq!(draft.groups[0].members.len(), 1);
    }

    #[test]
    fn concurrent_finalize_allocates_one_revision_and_rejects_the_loser() {
        let fixture = fixture();
        let draft = GroupingRepository::create_draft(
            &fixture.database,
            &fixture.session_id,
            "draft-revision-race",
            &[group("group-a", "A", 0, None)],
        )
        .expect("draft");
        GroupingRepository::open_draft(&fixture.database, &draft.id).expect("open");
        let database = fixture.database.clone();
        let draft_id = draft.id.clone();
        let first = thread::spawn({
            let database = database.clone();
            let draft_id = draft_id.clone();
            move || GroupingRepository::finalize_draft(&database, &draft_id)
        });
        let second_draft_id = draft_id.clone();
        let second =
            thread::spawn(move || GroupingRepository::finalize_draft(&database, &second_draft_id));
        let results = [
            first.join().expect("first join"),
            second.join().expect("second join"),
        ];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(AppError::DraftNotOpen)))
                .count(),
            1
        );
        assert_eq!(
            GroupingRepository::list_group_set_revisions(&fixture.database, &fixture.session_id)
                .expect("revisions")
                .iter()
                .map(|set| set.revision)
                .collect::<Vec<_>>(),
            vec![1]
        );
    }

    #[test]
    fn ended_session_cannot_mutate_grouping() {
        let fixture = fixture();
        let draft = GroupingRepository::create_draft(
            &fixture.database,
            &fixture.session_id,
            "draft-ended",
            &[group("group-a", "A", 0, None)],
        )
        .expect("draft");
        GroupingRepository::open_draft(&fixture.database, &draft.id).expect("open");
        LocalSessionRepository::end(&fixture.database, &fixture.session_id, "test").expect("end");
        let draft = GroupingRepository::get_draft(&fixture.database, &draft.id)
            .expect("draft")
            .expect("draft exists");
        assert!(matches!(draft.state, DraftState::Cancelled));
        assert!(matches!(
            GroupingRepository::finalize_draft(&fixture.database, &draft.id),
            Err(AppError::SessionEnded)
        ));
    }

    #[test]
    fn stale_recovery_cancels_only_sessions_marked_stale_in_this_transaction() {
        let fixture = fixture();
        let draft = GroupingRepository::create_draft(
            &fixture.database,
            &fixture.session_id,
            "stale-draft",
            &[],
        )
        .expect("draft");
        let connection = fixture.database.connection().expect("connection");
        connection
            .execute(
                "INSERT INTO local_sessions(id,classroom_id,server_instance_id,state,join_mode,join_code,created_at,ended_at,ended_reason,updated_at) VALUES ('already-ended',?1,'old-server','ENDED','roster_match','QRSTUVWX','now','now','server_restart','now')",
                [&fixture.classroom_id],
            )
            .expect("ended session");
        connection
            .execute(
                "INSERT INTO session_grouping_drafts(id,session_id,state,created_at,updated_at) VALUES ('already-ended-draft','already-ended','OPEN','now','now')",
                [],
            )
            .expect("ended draft");
        LocalSessionRepository::end_stale_sessions(&fixture.database).expect("stale recovery");
        let stale_state: String = fixture
            .database
            .connection()
            .expect("connection")
            .query_row(
                "SELECT state FROM session_grouping_drafts WHERE id=?1",
                [&draft.id],
                |row| row.get(0),
            )
            .expect("stale draft state");
        assert_eq!(stale_state, "CANCELLED");
        let existing_state: String = fixture
            .database
            .connection()
            .expect("connection")
            .query_row(
                "SELECT state FROM session_grouping_drafts WHERE id='already-ended-draft'",
                [],
                |row| row.get(0),
            )
            .expect("existing draft state");
        assert_eq!(existing_state, "OPEN");
    }
}
