#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;
use crate::infrastructure::persistence::repositories::{
    DraftGroup, GroupPreset, GroupPresetSummary, GroupingRepository, NewDraftGroup, PresetGroup,
    PresetMember, SessionGroupSet, SessionGroupingDraft, SessionGroupingParticipant,
    UnassignedParticipant, UpdateDraftGroup, UpdatePresetGroup,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionGroupingDraftFromPresetRequest {
    pub session_id: String,
    pub preset_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRandomGroupingDraftRequest {
    pub session_id: String,
    pub group_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateManualGroupingDraftRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionGroupingDraftGroupRequest {
    pub key: String,
    pub id: Option<String>,
    pub name: String,
    pub position: i64,
    pub capacity: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroupingAssignmentRequest {
    pub group_key: String,
    pub participant_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionGroupingDraftRequest {
    pub draft_id: String,
    pub groups: Vec<UpdateSessionGroupingDraftGroupRequest>,
    pub assignments: Vec<SessionGroupingAssignmentRequest>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroupingParticipantDto {
    pub participant_id: String,
    pub student_id: Option<String>,
    pub seat_number: i64,
    pub display_name: String,
    pub joined_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroupingDraftGroupDto {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub capacity: Option<i64>,
    pub participant_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroupingDraftDto {
    pub id: String,
    pub session_id: String,
    pub state: String,
    pub created_at: String,
    pub updated_at: String,
    pub groups: Vec<SessionGroupingDraftGroupDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroupingGroupSetDto {
    pub revision: i64,
    pub created_at: String,
    pub groups: Vec<SessionGroupingDraftGroupDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroupingOverviewDto {
    pub session_id: String,
    pub classroom_id: String,
    pub session_state: String,
    pub participants: Vec<SessionGroupingParticipantDto>,
    pub current_group_set: Option<SessionGroupingGroupSetDto>,
    pub active_draft: Option<SessionGroupingDraftDto>,
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

impl From<SessionGroupingParticipant> for SessionGroupingParticipantDto {
    fn from(participant: SessionGroupingParticipant) -> Self {
        Self {
            participant_id: participant.id,
            student_id: participant.student_id,
            seat_number: participant.seat_number,
            display_name: participant.display_name,
            joined_at: participant.joined_at,
        }
    }
}

fn draft_group_dto(group: DraftGroup) -> SessionGroupingDraftGroupDto {
    SessionGroupingDraftGroupDto {
        id: group.id,
        name: group.name,
        position: group.position,
        capacity: group.capacity,
        participant_ids: group
            .members
            .into_iter()
            .map(|member| member.participant_id)
            .collect(),
    }
}

fn draft_dto(draft: SessionGroupingDraft) -> SessionGroupingDraftDto {
    SessionGroupingDraftDto {
        id: draft.id,
        session_id: draft.session_id,
        state: draft.state.as_str().to_owned(),
        created_at: draft.created_at,
        updated_at: draft.updated_at,
        groups: draft.groups.into_iter().map(draft_group_dto).collect(),
    }
}

fn group_set_dto(group_set: SessionGroupSet) -> SessionGroupingGroupSetDto {
    SessionGroupingGroupSetDto {
        revision: group_set.revision,
        created_at: group_set.created_at,
        groups: group_set
            .groups
            .into_iter()
            .map(|group| SessionGroupingDraftGroupDto {
                id: group.id,
                name: group.name,
                position: group.position,
                capacity: None,
                participant_ids: group
                    .members
                    .into_iter()
                    .map(|member| member.participant_id)
                    .collect(),
            })
            .collect(),
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

    pub fn session_grouping_overview(
        &self,
        session_id: &str,
    ) -> Result<SessionGroupingOverviewDto, AppError> {
        let session_state = GroupingRepository::get_session_state(&self.database, session_id)?;
        let classroom_id =
            GroupingRepository::get_session_classroom_id(&self.database, session_id)?;
        let participants =
            GroupingRepository::list_grouping_participants(&self.database, session_id)?
                .into_iter()
                .map(Into::into)
                .collect();
        let current_group_set =
            GroupingRepository::get_current_group_set(&self.database, session_id)?
                .map(group_set_dto);
        let active_draft =
            GroupingRepository::get_active_draft(&self.database, session_id)?.map(draft_dto);
        Ok(SessionGroupingOverviewDto {
            session_id: session_id.to_owned(),
            classroom_id,
            session_state,
            participants,
            current_group_set,
            active_draft,
        })
    }

    pub fn create_draft_from_preset(
        &self,
        request: CreateSessionGroupingDraftFromPresetRequest,
    ) -> Result<SessionGroupingOverviewDto, AppError> {
        GroupingRepository::create_draft_from_preset(
            &self.database,
            &request.session_id,
            &request.preset_id,
            &Uuid::now_v7().to_string(),
        )?;
        self.session_grouping_overview(&request.session_id)
    }

    pub fn create_random_draft(
        &self,
        request: CreateRandomGroupingDraftRequest,
    ) -> Result<SessionGroupingOverviewDto, AppError> {
        GroupingRepository::create_random_draft(
            &self.database,
            &request.session_id,
            &Uuid::now_v7().to_string(),
            request.group_count,
        )?;
        self.session_grouping_overview(&request.session_id)
    }

    pub fn create_manual_draft(
        &self,
        request: CreateManualGroupingDraftRequest,
    ) -> Result<SessionGroupingOverviewDto, AppError> {
        GroupingRepository::create_draft(
            &self.database,
            &request.session_id,
            &Uuid::now_v7().to_string(),
            &[],
        )?;
        self.session_grouping_overview(&request.session_id)
    }

    pub fn clone_current_grouping_draft(
        &self,
        session_id: &str,
    ) -> Result<SessionGroupingOverviewDto, AppError> {
        GroupingRepository::clone_current_to_draft(
            &self.database,
            session_id,
            &Uuid::now_v7().to_string(),
        )?;
        self.session_grouping_overview(session_id)
    }

    pub fn update_session_grouping_draft(
        &self,
        request: UpdateSessionGroupingDraftRequest,
    ) -> Result<SessionGroupingOverviewDto, AppError> {
        let groups = request
            .groups
            .into_iter()
            .map(|group| UpdateDraftGroup {
                key: group.key,
                id: group.id,
                name: group.name,
                position: group.position,
                capacity: group.capacity,
            })
            .collect::<Vec<_>>();
        let assignments = request
            .assignments
            .into_iter()
            .map(|assignment| (assignment.group_key, assignment.participant_id))
            .collect::<Vec<_>>();
        let draft = GroupingRepository::get_draft(&self.database, &request.draft_id)?
            .ok_or(AppError::NotFound("grouping draft".to_owned()))?;
        GroupingRepository::update_draft(&self.database, &request.draft_id, &groups, &assignments)?;
        self.session_grouping_overview(&draft.session_id)
    }

    pub fn cancel_session_grouping_draft(
        &self,
        draft_id: &str,
    ) -> Result<SessionGroupingOverviewDto, AppError> {
        let draft = GroupingRepository::get_draft(&self.database, draft_id)?
            .ok_or(AppError::NotFound("grouping draft".to_owned()))?;
        GroupingRepository::cancel_draft(&self.database, draft_id)?;
        self.session_grouping_overview(&draft.session_id)
    }

    pub fn finalize_session_grouping_draft(
        &self,
        draft_id: &str,
    ) -> Result<SessionGroupingOverviewDto, AppError> {
        let draft = GroupingRepository::get_draft(&self.database, draft_id)?
            .ok_or(AppError::NotFound("grouping draft".to_owned()))?;
        GroupingRepository::finalize_draft(&self.database, draft_id)?;
        self.session_grouping_overview(&draft.session_id)
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
