#![allow(dead_code)]

use uuid::Uuid;

use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;
use crate::infrastructure::persistence::repositories::{
    DraftGroup, GroupPreset, GroupingRepository, NewDraftGroup, NewPresetGroup, PresetGroup,
    PresetMember, SessionGroupSet, SessionGroupingDraft, UnassignedParticipant,
};

#[derive(Debug, Clone)]
pub struct CreatePresetGroupRequest {
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone)]
pub struct CreateGroupPresetRequest {
    pub classroom_id: String,
    pub name: String,
    pub groups: Vec<CreatePresetGroupRequest>,
}

#[derive(Debug, Clone)]
pub struct PresetMemberAssignment {
    pub group_id: String,
    pub student_id: String,
}

#[derive(Debug, Clone)]
pub struct CreateDraftGroupRequest {
    pub name: String,
    pub position: i64,
    pub capacity: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct CreateGroupingDraftRequest {
    pub session_id: String,
    pub groups: Vec<CreateDraftGroupRequest>,
}

#[derive(Debug, Clone)]
pub struct GroupPresetDetail {
    pub preset: GroupPreset,
    pub groups: Vec<PresetGroup>,
    pub members: Vec<PresetMember>,
}

#[derive(Clone)]
pub struct GroupingService {
    database: Database,
}

impl GroupingService {
    pub fn initialize(database: Database) -> Self {
        Self { database }
    }

    pub fn create_preset(
        &self,
        request: CreateGroupPresetRequest,
    ) -> Result<GroupPresetDetail, AppError> {
        let groups = request
            .groups
            .into_iter()
            .map(|group| NewPresetGroup {
                id: Uuid::now_v7().to_string(),
                name: group.name,
                position: group.position,
            })
            .collect::<Vec<_>>();
        let preset = GroupingRepository::create_preset(
            &self.database,
            &request.classroom_id,
            &request.name,
            &groups,
        )?;
        self.get_preset_detail(&preset.id)
    }

    pub fn list_presets(&self, classroom_id: &str) -> Result<Vec<GroupPreset>, AppError> {
        GroupingRepository::list_presets(&self.database, classroom_id)
    }

    pub fn get_preset_detail(&self, preset_id: &str) -> Result<GroupPresetDetail, AppError> {
        let preset = GroupingRepository::get_preset(&self.database, preset_id)?
            .ok_or(AppError::GroupPresetNotFound)?;
        Ok(GroupPresetDetail {
            groups: GroupingRepository::list_preset_groups(&self.database, preset_id)?,
            members: GroupingRepository::list_preset_members(&self.database, preset_id)?,
            preset,
        })
    }

    pub fn replace_preset_members(
        &self,
        preset_id: &str,
        assignments: Vec<PresetMemberAssignment>,
    ) -> Result<Vec<PresetMember>, AppError> {
        GroupingRepository::replace_preset_members(
            &self.database,
            preset_id,
            &assignments
                .into_iter()
                .map(|assignment| (assignment.group_id, assignment.student_id))
                .collect::<Vec<_>>(),
        )
    }

    pub fn delete_preset(&self, preset_id: &str) -> Result<(), AppError> {
        GroupingRepository::delete_preset(&self.database, preset_id)
    }

    pub fn create_draft(
        &self,
        request: CreateGroupingDraftRequest,
    ) -> Result<SessionGroupingDraft, AppError> {
        let groups = request
            .groups
            .into_iter()
            .map(|group| NewDraftGroup {
                id: Uuid::now_v7().to_string(),
                name: group.name,
                position: group.position,
                capacity: group.capacity,
            })
            .collect::<Vec<_>>();
        GroupingRepository::create_draft(
            &self.database,
            &request.session_id,
            &Uuid::now_v7().to_string(),
            &groups,
        )
    }

    pub fn clone_current_to_draft(
        &self,
        session_id: &str,
    ) -> Result<SessionGroupingDraft, AppError> {
        GroupingRepository::clone_current_to_draft(
            &self.database,
            session_id,
            &Uuid::now_v7().to_string(),
        )
    }

    pub fn get_active_draft(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionGroupingDraft>, AppError> {
        GroupingRepository::get_active_draft(&self.database, session_id)
    }

    pub fn open_draft(&self, draft_id: &str) -> Result<SessionGroupingDraft, AppError> {
        GroupingRepository::open_draft(&self.database, draft_id)
    }

    pub fn move_participant(
        &self,
        draft_id: &str,
        participant_id: &str,
        target_group_id: Option<&str>,
    ) -> Result<SessionGroupingDraft, AppError> {
        GroupingRepository::move_draft_member(
            &self.database,
            draft_id,
            participant_id,
            target_group_id,
        )
    }

    pub fn finalize_draft(&self, draft_id: &str) -> Result<SessionGroupSet, AppError> {
        GroupingRepository::finalize_draft(&self.database, draft_id)
    }

    pub fn current_group_set(&self, session_id: &str) -> Result<Option<SessionGroupSet>, AppError> {
        GroupingRepository::get_current_group_set(&self.database, session_id)
    }

    pub fn group_set_revision(
        &self,
        session_id: &str,
        revision: i64,
    ) -> Result<Option<SessionGroupSet>, AppError> {
        GroupingRepository::get_group_set_revision(&self.database, session_id, revision)
    }

    pub fn group_set_revisions(&self, session_id: &str) -> Result<Vec<SessionGroupSet>, AppError> {
        GroupingRepository::list_group_set_revisions(&self.database, session_id)
    }

    pub fn unassigned_participants(
        &self,
        session_id: &str,
        group_set_id: Option<&str>,
    ) -> Result<Vec<UnassignedParticipant>, AppError> {
        GroupingRepository::list_unassigned_participants(&self.database, session_id, group_set_id)
    }

    pub fn draft_groups(&self, draft_id: &str) -> Result<Vec<DraftGroup>, AppError> {
        Ok(GroupingRepository::get_draft(&self.database, draft_id)?
            .ok_or(AppError::NotFound("grouping draft".to_owned()))?
            .groups)
    }
}
