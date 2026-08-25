#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;
use crate::infrastructure::persistence::repositories::{
    DraftGroup, GroupPreset, GroupPresetSummary, GroupingRepository, NewDraftGroup, PresetGroup,
    PresetMember, SessionGroupSet, SessionGroupingDraft, UnassignedParticipant, UpdatePresetGroup,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGroupPresetRequest {
    pub classroom_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetMemberAssignment {
    pub group_id: String,
    pub student_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePresetGroupRequest {
    pub key: String,
    pub id: Option<String>,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGroupPresetRequest {
    pub classroom_id: String,
    pub preset_id: String,
    pub name: String,
    pub groups: Vec<UpdatePresetGroupRequest>,
    pub assignments: Vec<PresetMemberAssignment>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupPresetDto {
    pub id: String,
    pub classroom_id: String,
    pub name: String,
    pub group_count: i64,
    pub assigned_student_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupPresetGroupDto {
    pub id: String,
    pub preset_id: String,
    pub name: String,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupPresetMemberDto {
    pub id: String,
    pub preset_id: String,
    pub group_id: String,
    pub student_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupPresetDetailDto {
    pub preset: GroupPresetDto,
    pub groups: Vec<GroupPresetGroupDto>,
    pub members: Vec<GroupPresetMemberDto>,
}

#[derive(Clone)]
pub struct GroupingService {
    database: Database,
}

impl GroupPresetDto {
    fn from_parts(preset: &GroupPreset, group_count: i64, assigned_student_count: i64) -> Self {
        Self {
            id: preset.id.clone(),
            classroom_id: preset.classroom_id.clone(),
            name: preset.name.clone(),
            group_count,
            assigned_student_count,
            created_at: preset.created_at.clone(),
            updated_at: preset.updated_at.clone(),
        }
    }
}

impl From<GroupPresetSummary> for GroupPresetDto {
    fn from(summary: GroupPresetSummary) -> Self {
        Self {
            id: summary.id,
            classroom_id: summary.classroom_id,
            name: summary.name,
            group_count: summary.group_count,
            assigned_student_count: summary.assigned_student_count,
            created_at: summary.created_at,
            updated_at: summary.updated_at,
        }
    }
}

impl From<PresetGroup> for GroupPresetGroupDto {
    fn from(group: PresetGroup) -> Self {
        Self {
            id: group.id,
            preset_id: group.preset_id,
            name: group.name,
            position: group.position,
            created_at: group.created_at,
            updated_at: group.updated_at,
        }
    }
}

impl From<PresetMember> for GroupPresetMemberDto {
    fn from(member: PresetMember) -> Self {
        Self {
            id: member.id,
            preset_id: member.preset_id,
            group_id: member.group_id,
            student_id: member.student_id,
            created_at: member.created_at,
            updated_at: member.updated_at,
        }
    }
}

impl GroupingService {
    pub fn initialize(database: Database) -> Self {
        Self { database }
    }

    pub fn create_preset(
        &self,
        request: CreateGroupPresetRequest,
    ) -> Result<GroupPresetDetailDto, AppError> {
        let preset = GroupingRepository::create_preset(
            &self.database,
            &request.classroom_id,
            &request.name,
            &[],
        )?;
        self.get_preset_detail(&request.classroom_id, &preset.id)
    }

    pub fn list_presets(&self, classroom_id: &str) -> Result<Vec<GroupPresetDto>, AppError> {
        Ok(
            GroupingRepository::list_preset_summaries(&self.database, classroom_id)?
                .into_iter()
                .map(Into::into)
                .collect(),
        )
    }

    pub fn get_preset_detail(
        &self,
        classroom_id: &str,
        preset_id: &str,
    ) -> Result<GroupPresetDetailDto, AppError> {
        let preset =
            GroupingRepository::get_preset_for_classroom(&self.database, classroom_id, preset_id)?
                .ok_or(AppError::GroupPresetNotFound)?;
        let groups = GroupingRepository::list_preset_groups(&self.database, preset_id)?;
        let members = GroupingRepository::list_preset_members(&self.database, preset_id)?;
        Ok(GroupPresetDetailDto {
            preset: GroupPresetDto::from_parts(&preset, groups.len() as i64, members.len() as i64),
            groups: groups.into_iter().map(Into::into).collect(),
            members: members.into_iter().map(Into::into).collect(),
        })
    }

    pub fn update_preset(
        &self,
        request: UpdateGroupPresetRequest,
    ) -> Result<GroupPresetDetailDto, AppError> {
        let groups = request
            .groups
            .into_iter()
            .map(|group| UpdatePresetGroup {
                key: group.key,
                id: group.id,
                name: group.name,
                position: group.position,
            })
            .collect::<Vec<_>>();
        let assignments = request
            .assignments
            .into_iter()
            .map(|assignment| (assignment.group_id, assignment.student_id))
            .collect::<Vec<_>>();
        GroupingRepository::update_preset(
            &self.database,
            &request.classroom_id,
            &request.preset_id,
            &request.name,
            &groups,
            &assignments,
        )?;
        self.get_preset_detail(&request.classroom_id, &request.preset_id)
    }

    pub fn delete_preset(&self, classroom_id: &str, preset_id: &str) -> Result<(), AppError> {
        GroupingRepository::delete_preset_for_classroom(&self.database, classroom_id, preset_id)
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
