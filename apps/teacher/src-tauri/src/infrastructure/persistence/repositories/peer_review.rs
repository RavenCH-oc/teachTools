use super::{new_id, now_utc};
use crate::infrastructure::persistence::database::Database;
use crate::peer_review_domain::*;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
type Result<T> = std::result::Result<T, PeerReviewError>;
#[path = "peer_review_monitor.rs"]
pub(crate) mod monitor;
#[path = "peer_review_setup.rs"]
pub(crate) mod setup;
#[path = "peer_review_student.rs"]
pub(crate) mod student;

pub(crate) struct PeerReviewRepository;

impl PeerReviewRepository {
    pub fn create(
        database: &Database,
        request: CreatePeerReviewActivity,
    ) -> Result<PeerReviewActivity> {
        if request.max_reviews_per_target.is_some_and(|n| n < 1)
            || (request.mode != PeerReviewMode::StudentSelect
                && request.max_reviews_per_target.is_some())
            || (request.mode != PeerReviewMode::CrossGroup
                && request.session_group_set_id.is_some())
        {
            return Err(PeerReviewError::InvalidInput);
        }
        let mut connection = database.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        validate_source(
            &tx,
            &request.session_id,
            &request.session_question_id,
            false,
        )?;
        if request.mode == PeerReviewMode::CrossGroup {
            let group_set = request
                .session_group_set_id
                .as_deref()
                .ok_or(PeerReviewError::GroupSetRequired)?;
            let owner: Option<String> = tx
                .query_row(
                    "SELECT session_id FROM session_group_sets WHERE id=?1",
                    [group_set],
                    |r| r.get(0),
                )
                .optional()?;
            if owner.as_deref() != Some(&request.session_id) {
                return Err(PeerReviewError::GroupSetSessionMismatch);
            }
        }
        let id = new_id();
        tx.execute("INSERT INTO peer_review_activities(id,session_id,session_question_id,mode,state,session_group_set_id,max_reviews_per_target,created_at) VALUES(?1,?2,?3,?4,'DRAFT',?5,?6,?7)",
            params![id,request.session_id,request.session_question_id,request.mode.as_str(),request.session_group_set_id,request.max_reviews_per_target,now_utc()])?;
        let result = activity(&tx, &id)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn get(database: &Database, id: &str) -> Result<PeerReviewActivity> {
        activity(&database.connection()?, id)
    }

    pub fn list(database: &Database, session_id: &str) -> Result<Vec<PeerReviewActivity>> {
        let c = database.connection()?;
        let ids = c
            .prepare(
                "SELECT id FROM peer_review_activities WHERE session_id=?1 ORDER BY created_at,id",
            )?
            .query_map([session_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids.iter().map(|id| activity(&c, id)).collect()
    }

    pub fn open(database: &Database, id: &str) -> Result<PeerReviewActivity> {
        Self::open_with_policy(database, id, false)
    }

    pub(crate) fn open_for_teacher(database: &Database, id: &str) -> Result<PeerReviewActivity> {
        Self::open_with_policy(database, id, true)
    }

    fn open_with_policy(
        database: &Database,
        id: &str,
        teacher_policy: bool,
    ) -> Result<PeerReviewActivity> {
        let mut c = database.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let a = activity(&tx, id)?;
        if teacher_policy && tx.prepare("SELECT 1 FROM peer_review_activities WHERE session_id=?1 AND session_question_id=?2 AND id<>?3 AND state IN ('DRAFT','OPEN')")?.exists(params![a.session_id,a.session_question_id,id])? {
            return Err(PeerReviewError::PeerReviewAlreadyOpen);
        }
        match a.state {
            PeerReviewActivityState::Draft => {}
            PeerReviewActivityState::Open => return Err(PeerReviewError::PeerReviewAlreadyOpen),
            _ => return Err(PeerReviewError::PeerReviewClosed),
        }
        validate_source(&tx, &a.session_id, &a.session_question_id, true)?;
        // Accepted submission rows are append-only; bind their stable PK, never a latest view.
        let rows = tx.prepare("SELECT s.id,s.participant_id,s.answer_json FROM submissions s JOIN session_participants p ON p.id=s.participant_id WHERE s.session_question_id=?1 AND p.session_id=?2 AND NOT EXISTS(SELECT 1 FROM submissions newer WHERE newer.session_question_id=s.session_question_id AND newer.participant_id=s.participant_id AND newer.revision>s.revision) ORDER BY s.participant_id")?
            .query_map(params![a.session_question_id,a.session_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for (submission_id, participant_id, json) in rows {
            essay_text(&json)?;
            tx.execute("INSERT INTO peer_review_targets(id,activity_id,submission_id,participant_id) VALUES(?1,?2,?3,?4)", params![new_id(),id,submission_id,participant_id])?;
        }
        match a.mode {
            PeerReviewMode::RandomOneToOne => {
                let targets = targets(&tx, id)?;
                let pool = targets
                    .iter()
                    .map(|t| t.participant_id.clone())
                    .collect::<Vec<_>>();
                for (reviewer, target_participant) in shuffled_cycle(&pool)? {
                    let target = targets
                        .iter()
                        .find(|t| t.participant_id == target_participant)
                        .ok_or(PeerReviewError::Storage)?;
                    insert_assignment(&tx, &a, Some(&reviewer), None, Some(&target.id), None)?;
                }
            }
            PeerReviewMode::StudentSelect => {
                if targets(&tx, id)?.len() < 2 {
                    return Err(PeerReviewError::InsufficientReviewParticipants);
                }
            }
            PeerReviewMode::CrossGroup => {
                let group_set = a
                    .session_group_set_id
                    .as_deref()
                    .ok_or(PeerReviewError::GroupSetRequired)?;
                let groups = tx.prepare("SELECT g.id FROM session_groups g WHERE g.group_set_id=?1 AND EXISTS(SELECT 1 FROM session_group_members m JOIN peer_review_targets t ON t.participant_id=m.participant_id AND t.activity_id=?2 WHERE m.group_id=g.id AND m.group_set_id=?1) ORDER BY g.position,g.id")?
                    .query_map(params![group_set,id], |r| r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
                if groups.len() < 2 {
                    return Err(PeerReviewError::InsufficientReviewGroups);
                }
                for group in &groups {
                    let target_id = new_id();
                    tx.execute("INSERT INTO peer_review_group_targets(id,activity_id,session_group_set_id,session_group_id) VALUES(?1,?2,?3,?4)",params![target_id,id,group_set,group])?;
                    tx.execute("INSERT INTO peer_review_group_target_items(activity_id,group_target_id,target_id) SELECT ?1,?2,t.id FROM peer_review_targets t JOIN session_group_members m ON m.participant_id=t.participant_id WHERE t.activity_id=?1 AND m.group_set_id=?3 AND m.group_id=?4",params![id,target_id,group_set,group])?;
                }
                for (reviewer, target_group) in shuffled_cycle(&groups)? {
                    if reviewer == target_group {
                        return Err(PeerReviewError::SameGroupReviewNotAllowed);
                    }
                    let target_id: String = tx.query_row("SELECT id FROM peer_review_group_targets WHERE activity_id=?1 AND session_group_id=?2", params![id,target_group], |r| r.get(0))?;
                    insert_assignment(&tx, &a, None, Some(&reviewer), None, Some(&target_id))?;
                }
            }
        }
        tx.execute(
            "UPDATE peer_review_activities SET state='OPEN',opened_at=?1 WHERE id=?2",
            params![now_utc(), id],
        )?;
        let result = activity(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn finish(database: &Database, id: &str, cancel: bool) -> Result<PeerReviewActivity> {
        let mut c = database.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let a = activity(&tx, id)?;
        require_active(&tx, &a.session_id)?;
        if (cancel && a.state != PeerReviewActivityState::Draft)
            || (!cancel && a.state != PeerReviewActivityState::Open)
        {
            return Err(PeerReviewError::PeerReviewNotOpen);
        }
        tx.execute(
            "UPDATE peer_review_activities SET state=?1,closed_at=?2 WHERE id=?3",
            params![if cancel { "CANCELLED" } else { "CLOSED" }, now_utc(), id],
        )?;
        let result = activity(&tx, id)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn claim(
        database: &Database,
        activity_id: &str,
        reviewer_id: &str,
        target_id: &str,
    ) -> Result<PeerReviewAssignment> {
        let mut c = database.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let a = activity(&tx, activity_id)?;
        require_open(&tx, &a)?;
        if a.mode != PeerReviewMode::StudentSelect {
            return Err(PeerReviewError::InvalidInput);
        }
        if !tx
            .prepare(
                "SELECT 1 FROM peer_review_targets WHERE activity_id=?1 AND participant_id=?2",
            )?
            .exists(params![activity_id, reviewer_id])?
        {
            return Err(PeerReviewError::ReviewerNotEligible);
        }
        let owner: Option<String> = tx
            .query_row(
                "SELECT participant_id FROM peer_review_targets WHERE activity_id=?1 AND id=?2",
                params![activity_id, target_id],
                |r| r.get(0),
            )
            .optional()?;
        let owner = owner.ok_or(PeerReviewError::TargetNotFound)?;
        if owner == reviewer_id {
            return Err(PeerReviewError::SelfReviewNotAllowed);
        }
        let existing: Option<(String,String)> = tx.query_row("SELECT id,target_id FROM peer_review_assignments WHERE activity_id=?1 AND reviewer_participant_id=?2 AND slot_index=1",params![activity_id,reviewer_id],|r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((id, previous_target)) = &existing {
            if previous_target == target_id {
                return assignment(&tx, id);
            }
            if latest_response(&tx, id)?.is_some() {
                return Err(PeerReviewError::ReviewTargetLockedAfterSubmission);
            }
        }
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM peer_review_assignments WHERE activity_id=?1 AND target_id=?2",
            params![activity_id, target_id],
            |r| r.get(0),
        )?;
        if a.max_reviews_per_target.is_some_and(|limit| count >= limit) {
            return Err(PeerReviewError::TargetReviewCapacityFull);
        }
        let id = if let Some((id, _)) = existing {
            tx.execute(
                "UPDATE peer_review_assignments SET target_id=?1,updated_at=?2 WHERE id=?3",
                params![target_id, now_utc(), id],
            )?;
            id
        } else {
            insert_assignment(&tx, &a, Some(reviewer_id), None, Some(target_id), None)?
        };
        let result = assignment(&tx, &id)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn submit(database: &Database, request: SubmitPeerReview) -> Result<PeerReviewResponse> {
        let body = review_text(&request.body)?;
        if request.expected_base_revision < 0
            || request.expected_base_revision == i64::MAX
            || uuid::Uuid::parse_str(&request.review_submission_id).map_or(true, |id| {
                id.get_variant() != uuid::Variant::RFC4122 || !matches!(id.get_version_num(), 4 | 7)
            })
        {
            return Err(PeerReviewError::InvalidInput);
        }
        let mut c = database.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let assigned = assignment(&tx, &request.assignment_id)?;
        let a = activity(&tx, &assigned.activity_id)?;
        authorize_contributor(&tx, &a, &assigned, &request.submitted_by_participant_id)?;
        if let Some(previous) = response_by_id(&tx, &request.review_submission_id)? {
            return if previous.assignment_id == request.assignment_id
                && previous.submitted_by_participant_id == request.submitted_by_participant_id
                && previous.body == body
                && previous.expected_base_revision == request.expected_base_revision
            {
                Ok(previous)
            } else {
                Err(PeerReviewError::ReviewSubmissionConflict)
            };
        }
        require_open(&tx, &a)?;
        let current = assigned
            .latest_review_revision
            .as_ref()
            .map_or(0, |r| r.revision);
        if request.expected_base_revision != current {
            return Err(PeerReviewError::ReviewRevisionConflict);
        }
        tx.execute("INSERT INTO peer_review_responses(id,assignment_id,submitted_by_participant_id,revision,expected_base_revision,body,submitted_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![request.review_submission_id,request.assignment_id,request.submitted_by_participant_id,current+1,current,body,now_utc()])?;
        let result =
            response_by_id(&tx, &request.review_submission_id)?.ok_or(PeerReviewError::Storage)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn target_statuses(database: &Database, id: &str) -> Result<Vec<PeerReviewTargetStatus>> {
        let mut c = database.connection()?;
        let tx = c.transaction()?;
        let a = activity(&tx, id)?;
        let result = targets(&tx, id)?.into_iter().map(|target| {
            let (claimed, submitted): (i64,i64) = tx.query_row("SELECT COUNT(*),COALESCE(SUM(EXISTS(SELECT 1 FROM peer_review_responses r WHERE r.assignment_id=a.id)),0) FROM peer_review_assignments a WHERE a.activity_id=?1 AND a.target_id=?2", params![id,target.id], |r| Ok((r.get(0)?,r.get(1)?)))?;
            Ok(PeerReviewTargetStatus { target, claimed_review_count:claimed, submitted_review_count:submitted, max_reviews_per_target:a.max_reviews_per_target,
                remaining_capacity:a.max_reviews_per_target.map(|n| (n-claimed).max(0)), has_received_any_review:submitted>0 })
        }).collect::<Result<Vec<_>>>()?;
        tx.commit()?;
        Ok(result)
    }

    pub fn assignments(database: &Database, id: &str) -> Result<Vec<PeerReviewAssignment>> {
        let mut c = database.connection()?;
        let tx = c.transaction()?;
        activity(&tx, id)?;
        let ids = tx.prepare("SELECT id FROM peer_review_assignments WHERE activity_id=?1 ORDER BY created_at,id")?.query_map([id], |r| r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
        let result = ids
            .iter()
            .map(|id| assignment(&tx, id))
            .collect::<Result<Vec<_>>>()?;
        tx.commit()?;
        Ok(result)
    }

    pub fn assignment_detail(database: &Database, id: &str) -> Result<PeerReviewAssignmentDetail> {
        let mut c = database.connection()?;
        let tx = c.transaction()?;
        let assigned = assignment(&tx, id)?;
        let target = assigned
            .target_id
            .as_ref()
            .map(|target_id| {
                targets(&tx, &assigned.activity_id)?
                    .into_iter()
                    .find(|t| t.id == *target_id)
                    .ok_or(PeerReviewError::Storage)
            })
            .transpose()?;
        let group_target = assigned
            .target_group_id
            .as_ref()
            .map(|target_id| group_target(&tx, target_id))
            .transpose()?;
        tx.commit()?;
        Ok(PeerReviewAssignmentDetail {
            assignment: assigned,
            target,
            group_target,
        })
    }

    pub fn group_targets(database: &Database, id: &str) -> Result<Vec<PeerReviewGroupTarget>> {
        let mut c = database.connection()?;
        let tx = c.transaction()?;
        activity(&tx, id)?;
        let ids = tx
            .prepare("SELECT id FROM peer_review_group_targets WHERE activity_id=?1 ORDER BY id")?
            .query_map([id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let result = ids
            .iter()
            .map(|id| group_target(&tx, id))
            .collect::<Result<Vec<_>>>()?;
        tx.commit()?;
        Ok(result)
    }

    pub fn responses(database: &Database, id: &str) -> Result<Vec<PeerReviewResponse>> {
        let c = database.connection()?;
        assignment(&c, id)?;
        let result = c.prepare("SELECT id,assignment_id,submitted_by_participant_id,revision,expected_base_revision,body,submitted_at FROM peer_review_responses WHERE assignment_id=?1 ORDER BY revision")?
            .query_map([id],response_row)?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(result)
    }
}

fn require_active(c: &Connection, session_id: &str) -> Result<()> {
    let state: Option<String> = c
        .query_row(
            "SELECT state FROM local_sessions WHERE id=?1",
            [session_id],
            |r| r.get(0),
        )
        .optional()?;
    match state.as_deref() {
        Some("ACTIVE") => Ok(()),
        Some("ENDED") => Err(PeerReviewError::SessionEnded),
        _ => Err(PeerReviewError::SessionNotActive),
    }
}
fn validate_source(
    c: &Connection,
    session_id: &str,
    question_id: &str,
    opening: bool,
) -> Result<()> {
    require_active(c, session_id)?;
    let row: Option<(String, String, String)> = c
        .query_row(
            "SELECT session_id,question_type,state FROM session_questions WHERE id=?1",
            [question_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (owner, kind, state) = row.ok_or(PeerReviewError::QuestionSessionMismatch)?;
    if owner != session_id {
        return Err(PeerReviewError::QuestionSessionMismatch);
    }
    if kind != "essay" {
        return Err(PeerReviewError::PeerReviewEssayRequired);
    }
    if opening && !matches!(state.as_str(), "LOCKED" | "REVEALED") {
        return Err(PeerReviewError::QuestionNotReady);
    }
    Ok(())
}
fn require_open(c: &Connection, a: &PeerReviewActivity) -> Result<()> {
    require_active(c, &a.session_id)?;
    match a.state {
        PeerReviewActivityState::Open => Ok(()),
        PeerReviewActivityState::Draft => Err(PeerReviewError::PeerReviewNotOpen),
        _ => Err(PeerReviewError::PeerReviewClosed),
    }
}
fn activity(c: &Connection, id: &str) -> Result<PeerReviewActivity> {
    let row = c.query_row("SELECT id,session_id,session_question_id,mode,state,session_group_set_id,max_reviews_per_target,created_at,opened_at,closed_at FROM peer_review_activities WHERE id=?1",[id],|r| {
        Ok((r.get::<_,String>(3)?,r.get::<_,String>(4)?,PeerReviewActivity { id:r.get(0)?,session_id:r.get(1)?,session_question_id:r.get(2)?,mode:PeerReviewMode::StudentSelect,state:PeerReviewActivityState::Draft,session_group_set_id:r.get(5)?,max_reviews_per_target:r.get(6)?,created_at:r.get(7)?,opened_at:r.get(8)?,closed_at:r.get(9)? }))
    }).optional()?.ok_or(PeerReviewError::PeerReviewActivityNotFound)?;
    let (mode, state, mut result) = row;
    result.mode = PeerReviewMode::from_storage(&mode)?;
    result.state = PeerReviewActivityState::from_storage(&state)?;
    Ok(result)
}
fn essay_text(json: &str) -> Result<String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| PeerReviewError::Storage)?;
    if value.get("type").and_then(|v| v.as_str()) != Some("essay") {
        return Err(PeerReviewError::Storage);
    }
    value
        .get("text")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .ok_or(PeerReviewError::Storage)
}
fn targets(c: &Connection, id: &str) -> Result<Vec<PeerReviewTarget>> {
    let rows = c.prepare("SELECT t.id,t.activity_id,t.submission_id,t.participant_id,s.revision,s.answer_json FROM peer_review_targets t JOIN submissions s ON s.id=t.submission_id WHERE t.activity_id=?1 ORDER BY t.participant_id")?
        .query_map([id], |r| Ok((PeerReviewTarget { id:r.get(0)?,activity_id:r.get(1)?,submission_id:r.get(2)?,participant_id:r.get(3)?,source_revision:r.get(4)?,essay_text:String::new() }, r.get::<_,String>(5)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(mut target, json)| {
            target.essay_text = essay_text(&json)?;
            Ok(target)
        })
        .collect()
}
fn insert_assignment(
    tx: &Transaction<'_>,
    a: &PeerReviewActivity,
    reviewer: Option<&str>,
    reviewer_group: Option<&str>,
    target: Option<&str>,
    target_group: Option<&str>,
) -> Result<String> {
    let id = new_id();
    tx.execute("INSERT INTO peer_review_assignments(id,activity_id,mode,reviewer_participant_id,reviewer_session_group_id,session_group_set_id,target_id,target_group_id,slot_index,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,?9,?9)",params![id,a.id,a.mode.as_str(),reviewer,reviewer_group,a.session_group_set_id,target,target_group,now_utc()])?;
    Ok(id)
}
fn response_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<PeerReviewResponse> {
    Ok(PeerReviewResponse {
        id: r.get(0)?,
        assignment_id: r.get(1)?,
        submitted_by_participant_id: r.get(2)?,
        revision: r.get(3)?,
        expected_base_revision: r.get(4)?,
        body: r.get(5)?,
        submitted_at: r.get(6)?,
    })
}
fn response_by_id(c: &Connection, id: &str) -> Result<Option<PeerReviewResponse>> {
    Ok(c.query_row("SELECT id,assignment_id,submitted_by_participant_id,revision,expected_base_revision,body,submitted_at FROM peer_review_responses WHERE id=?1",[id],response_row).optional()?)
}
fn latest_response(c: &Connection, id: &str) -> Result<Option<PeerReviewResponse>> {
    Ok(c.query_row("SELECT id,assignment_id,submitted_by_participant_id,revision,expected_base_revision,body,submitted_at FROM peer_review_responses WHERE assignment_id=?1 ORDER BY revision DESC LIMIT 1",[id],response_row).optional()?)
}
fn assignment(c: &Connection, id: &str) -> Result<PeerReviewAssignment> {
    let mut result = c.query_row("SELECT id,activity_id,reviewer_participant_id,reviewer_session_group_id,target_id,target_group_id,slot_index FROM peer_review_assignments WHERE id=?1",[id],|r| Ok(PeerReviewAssignment { id:r.get(0)?,activity_id:r.get(1)?,reviewer_participant_id:r.get(2)?,reviewer_session_group_id:r.get(3)?,target_id:r.get(4)?,target_group_id:r.get(5)?,slot_index:r.get(6)?,state:PeerReviewAssignmentState::Assigned,latest_review_revision:None })).optional()?.ok_or(PeerReviewError::AssignmentNotFound)?;
    result.latest_review_revision = latest_response(c, id)?;
    if result.latest_review_revision.is_some() {
        result.state = PeerReviewAssignmentState::Submitted;
    }
    Ok(result)
}
fn group_target(c: &Connection, id: &str) -> Result<PeerReviewGroupTarget> {
    let (activity_id,group_id,name): (String,String,String) = c.query_row("SELECT t.activity_id,t.session_group_id,g.name FROM peer_review_group_targets t JOIN session_groups g ON g.id=t.session_group_id WHERE t.id=?1",[id],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    let item_ids = c
        .prepare("SELECT target_id FROM peer_review_group_target_items WHERE group_target_id=?1")?
        .query_map([id], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<std::collections::HashSet<_>, _>>()?;
    Ok(PeerReviewGroupTarget {
        id: id.to_owned(),
        session_group_id: group_id,
        name,
        captured_submission_items: targets(c, &activity_id)?
            .into_iter()
            .filter(|t| item_ids.contains(&t.id))
            .collect(),
    })
}
fn authorize_contributor(
    c: &Connection,
    a: &PeerReviewActivity,
    assigned: &PeerReviewAssignment,
    participant: &str,
) -> Result<()> {
    let allowed = if a.mode == PeerReviewMode::CrossGroup {
        c.prepare("SELECT 1 FROM session_group_members m JOIN session_participants p ON p.id=m.participant_id WHERE m.group_set_id=?1 AND m.group_id=?2 AND m.participant_id=?3 AND p.session_id=?4")?
            .exists(params![a.session_group_set_id,assigned.reviewer_session_group_id,participant,a.session_id])?
    } else {
        assigned.reviewer_participant_id.as_deref() == Some(participant)
    };
    if allowed {
        Ok(())
    } else {
        Err(PeerReviewError::ReviewerNotAuthorized)
    }
}

#[cfg(test)]
#[path = "peer_review_tests.rs"]
mod tests;
