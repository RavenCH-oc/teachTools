#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::error::AppError;
use crate::infrastructure::persistence::database::Database;
use crate::infrastructure::persistence::repositories::grouping::DraftState;
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveSessionGroupingParticipantRequest {
    pub draft_id: String,
    pub participant_id: String,
    pub target_group_id: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentGroupingMemberDto {
    pub display_name: String,
    pub seat_number: i64,
    pub is_self: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentGroupingGroupDto {
    pub group_id: String,
    pub name: String,
    pub position: i64,
    pub member_count: i64,
    pub capacity: Option<i64>,
    pub is_full: bool,
    pub members: Vec<StudentGroupingMemberDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudentGroupingViewDto {
    pub grouping_mode: String,
    pub draft_id: Option<String>,
    pub draft_state: Option<String>,
    pub selection_open: bool,
    pub current_group: Option<StudentGroupingGroupDto>,
    pub available_groups: Vec<StudentGroupingGroupDto>,
}

#[derive(Debug, Clone)]
pub struct GroupSelectionResult {
    pub selected_group_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GroupingEvent {
    pub session_id: String,
}

#[derive(Clone)]
pub struct GroupingService {
    database: Database,
    events: broadcast::Sender<GroupingEvent>,
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
        let (events, _) = broadcast::channel(64);
        Self { database, events }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<GroupingEvent> {
        self.events.subscribe()
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
        if !matches!(draft.state, DraftState::Draft) {
            return Err(AppError::DraftNotOpen);
        }
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
        self.notify(&draft.session_id);
        self.session_grouping_overview(&draft.session_id)
    }

    pub fn finalize_session_grouping_draft(
        &self,
        draft_id: &str,
    ) -> Result<SessionGroupingOverviewDto, AppError> {
        let draft = GroupingRepository::get_draft(&self.database, draft_id)?
            .ok_or(AppError::NotFound("grouping draft".to_owned()))?;
        GroupingRepository::finalize_draft(&self.database, draft_id)?;
        self.notify(&draft.session_id);
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
        let existing = GroupingRepository::get_draft(&self.database, draft_id)?
            .ok_or(AppError::NotFound("grouping draft".to_owned()))?;
        if existing.groups.is_empty() {
            return Err(AppError::Validation(
                "a self-selection draft must contain at least one group".to_owned(),
            ));
        }
        let draft = GroupingRepository::open_draft(&self.database, draft_id)?;
        self.notify(&draft.session_id);
        Ok(draft)
    }

    pub fn open_session_grouping_draft(
        &self,
        draft_id: &str,
    ) -> Result<SessionGroupingOverviewDto, AppError> {
        let draft = self.open_draft(draft_id)?;
        self.session_grouping_overview(&draft.session_id)
    }

    pub fn move_session_grouping_participant(
        &self,
        request: MoveSessionGroupingParticipantRequest,
    ) -> Result<SessionGroupingOverviewDto, AppError> {
        let draft = self.move_participant(
            &request.draft_id,
            &request.participant_id,
            request.target_group_id.as_deref(),
        )?;
        self.session_grouping_overview(&draft.session_id)
    }

    pub fn move_participant(
        &self,
        draft_id: &str,
        participant_id: &str,
        target_group_id: Option<&str>,
    ) -> Result<SessionGroupingDraft, AppError> {
        let draft = GroupingRepository::move_draft_member(
            &self.database,
            draft_id,
            participant_id,
            target_group_id,
        )?;
        self.notify(&draft.session_id);
        Ok(draft)
    }

    pub fn finalize_draft(&self, draft_id: &str) -> Result<SessionGroupSet, AppError> {
        let group_set = GroupingRepository::finalize_draft(&self.database, draft_id)?;
        self.notify(&group_set.session_id);
        Ok(group_set)
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

    pub fn select_group(
        &self,
        draft_id: &str,
        participant_id: &str,
        session_id: &str,
        target_group_id: Option<&str>,
    ) -> Result<GroupSelectionResult, AppError> {
        let draft = GroupingRepository::get_draft(&self.database, draft_id)?
            .ok_or(AppError::StaleGroupingDraft)?;
        if draft.session_id != session_id {
            return Err(AppError::StaleGroupingDraft);
        }
        if !matches!(draft.state, DraftState::Open) {
            return Err(AppError::DraftNotOpen);
        }
        let updated = GroupingRepository::move_draft_member(
            &self.database,
            draft_id,
            participant_id,
            target_group_id,
        )?;
        let selected_group_id = updated
            .groups
            .iter()
            .find(|group| {
                group
                    .members
                    .iter()
                    .any(|member| member.participant_id == participant_id)
            })
            .map(|group| group.id.clone());
        self.notify(&updated.session_id);
        Ok(GroupSelectionResult { selected_group_id })
    }

    pub fn student_grouping_view(
        &self,
        participant_id: &str,
        session_id: &str,
    ) -> Result<StudentGroupingViewDto, AppError> {
        let participants =
            GroupingRepository::list_grouping_participants(&self.database, session_id)?;
        let labels = participants
            .into_iter()
            .map(|participant| (participant.id.clone(), participant))
            .collect::<std::collections::HashMap<_, _>>();
        if !labels.contains_key(participant_id) {
            return Err(AppError::ParticipantSessionMismatch);
        }
        if let Some(draft) = GroupingRepository::get_active_draft(&self.database, session_id)? {
            if matches!(draft.state, DraftState::Open) {
                let available_groups = draft
                    .groups
                    .iter()
                    .map(|group| {
                        student_group_from_members(
                            &group.id,
                            &group.name,
                            group.position,
                            group.capacity,
                            group
                                .members
                                .iter()
                                .map(|member| member.participant_id.as_str()),
                            &labels,
                            participant_id,
                        )
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let current_group = available_groups
                    .iter()
                    .find(|group| group.members.iter().any(|member| member.is_self))
                    .cloned();
                return Ok(StudentGroupingViewDto {
                    grouping_mode: "self_selection".to_owned(),
                    draft_id: Some(draft.id),
                    draft_state: Some("OPEN".to_owned()),
                    selection_open: true,
                    current_group,
                    available_groups,
                });
            }
        }
        if let Some(group_set) =
            GroupingRepository::get_current_group_set(&self.database, session_id)?
        {
            let current_group = group_set
                .groups
                .iter()
                .find(|group| {
                    group
                        .members
                        .iter()
                        .any(|member| member.participant_id == participant_id)
                })
                .map(|group| {
                    student_group_from_members(
                        &group.id,
                        &group.name,
                        group.position,
                        None,
                        group
                            .members
                            .iter()
                            .map(|member| member.participant_id.as_str()),
                        &labels,
                        participant_id,
                    )
                })
                .transpose()?;
            return Ok(StudentGroupingViewDto {
                grouping_mode: "finalized".to_owned(),
                draft_id: None,
                draft_state: None,
                selection_open: false,
                current_group,
                available_groups: Vec::new(),
            });
        }
        Ok(StudentGroupingViewDto {
            grouping_mode: "none".to_owned(),
            draft_id: None,
            draft_state: None,
            selection_open: false,
            current_group: None,
            available_groups: Vec::new(),
        })
    }

    fn notify(&self, session_id: &str) {
        let _ = self.events.send(GroupingEvent {
            session_id: session_id.to_owned(),
        });
    }
}

fn student_group_from_members<'a>(
    group_id: &str,
    name: &str,
    position: i64,
    capacity: Option<i64>,
    participant_ids: impl Iterator<Item = &'a str>,
    labels: &std::collections::HashMap<String, SessionGroupingParticipant>,
    self_participant_id: &str,
) -> Result<StudentGroupingGroupDto, AppError> {
    let mut members = participant_ids
        .map(|participant_id| {
            let participant = labels.get(participant_id).ok_or(AppError::Storage)?;
            Ok(StudentGroupingMemberDto {
                display_name: participant.display_name.clone(),
                seat_number: participant.seat_number,
                is_self: participant.id == self_participant_id,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    members.sort_by(|left, right| {
        left.seat_number
            .cmp(&right.seat_number)
            .then_with(|| left.display_name.cmp(&right.display_name))
    });
    let member_count = i64::try_from(members.len()).map_err(|_| AppError::Storage)?;
    Ok(StudentGroupingGroupDto {
        group_id: group_id.to_owned(),
        name: name.to_owned(),
        position,
        member_count,
        capacity,
        is_full: capacity.is_some_and(|limit| member_count >= limit),
        members,
    })
}
