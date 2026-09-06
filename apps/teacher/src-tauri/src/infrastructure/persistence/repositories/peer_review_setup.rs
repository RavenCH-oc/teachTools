use super::*;
use crate::application::peer_review_setup::*;

fn projected(c: &Connection, session: &str, id: &str) -> Result<SetupActivity> {
    let a = activity(c, id)?;
    if a.session_id != session {
        return Err(PeerReviewError::PeerReviewActivityNotFound);
    }
    let count = c.query_row(
        "SELECT COUNT(*) FROM peer_review_targets WHERE activity_id=?1",
        [id],
        |r| r.get(0),
    )?;
    Ok(SetupActivity::from_activity(a, count))
}
pub(crate) fn owned(database: &Database, session: &str, id: &str) -> Result<SetupActivity> {
    let mut c = database.connection()?;
    let tx = c.transaction()?;
    let result = projected(&tx, session, id)?;
    tx.commit()?;
    Ok(result)
}

pub(crate) fn save(
    database: &Database,
    id: Option<&str>,
    request: SavePeerReviewDraft,
) -> Result<SetupActivity> {
    // JS-safe positive integer transport boundary; None, not zero, is unlimited.
    if request
        .max_reviews_per_target
        .is_some_and(|n| !(1..=9_007_199_254_740_991).contains(&n))
        || (request.mode != PeerReviewMode::StudentSelect
            && request.max_reviews_per_target.is_some())
        || (request.mode != PeerReviewMode::CrossGroup && request.session_group_set_id.is_some())
    {
        return Err(PeerReviewError::InvalidInput);
    }
    let mut c = database.connection()?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    validate_source(
        &tx,
        &request.session_id,
        &request.session_question_id,
        false,
    )?;
    if let Some(id) = id {
        let existing = projected(&tx, &request.session_id, id)?;
        if existing.state != PeerReviewActivityState::Draft {
            return Err(PeerReviewError::PeerReviewClosed);
        }
    }
    if request.mode == PeerReviewMode::CrossGroup {
        let set = request
            .session_group_set_id
            .as_deref()
            .ok_or(PeerReviewError::GroupSetRequired)?;
        if !tx
            .prepare("SELECT 1 FROM session_group_sets WHERE id=?1 AND session_id=?2")?
            .exists(params![set, request.session_id])?
        {
            return Err(PeerReviewError::GroupSetSessionMismatch);
        }
    }
    // All Teacher create/edit paths take this write lock before checking. The
    // 12A internal API stays unchanged and is not exposed to IPC.
    if tx.prepare("SELECT 1 FROM peer_review_activities WHERE session_id=?1 AND session_question_id=?2 AND state IN ('DRAFT','OPEN') AND (?3 IS NULL OR id<>?3)")?
        .exists(params![request.session_id,request.session_question_id,id])? { return Err(PeerReviewError::PeerReviewAlreadyOpen); }
    let key = id.map(str::to_owned).unwrap_or_else(new_id);
    if id.is_some() {
        tx.execute("UPDATE peer_review_activities SET session_question_id=?1,mode=?2,max_reviews_per_target=?3,session_group_set_id=?4 WHERE id=?5",params![request.session_question_id,request.mode.as_str(),request.max_reviews_per_target,request.session_group_set_id,key])?;
    } else {
        tx.execute("INSERT INTO peer_review_activities(id,session_id,session_question_id,mode,state,max_reviews_per_target,session_group_set_id,created_at) VALUES(?1,?2,?3,?4,'DRAFT',?5,?6,?7)",params![key,request.session_id,request.session_question_id,request.mode.as_str(),request.max_reviews_per_target,request.session_group_set_id,now_utc()])?;
    }
    let result = projected(&tx, &request.session_id, &key)?;
    tx.commit()?;
    Ok(result)
}

pub(crate) fn context(database: &Database, session: &str) -> Result<PeerReviewSetupContext> {
    let mut c = database.connection()?;
    let tx = c.transaction()?;
    let (state,name):(String,String)=tx.query_row("SELECT s.state,c.name FROM local_sessions s JOIN classes c ON c.id=s.classroom_id WHERE s.id=?1",[session],|r|Ok((r.get(0)?,r.get(1)?)))
        .optional()?.ok_or(PeerReviewError::SessionNotActive)?;
    // Counts inspect identity only, never materialize answer_json or credentials.
    let questions=tx.prepare("SELECT q.id,q.position,q.prompt,q.state,(SELECT COUNT(DISTINCT s.participant_id) FROM submissions s JOIN session_participants p ON p.id=s.participant_id AND p.session_id=q.session_id WHERE s.session_question_id=q.id) FROM session_questions q WHERE q.session_id=?1 AND q.question_type='essay' ORDER BY q.position,q.id")?
        .query_map([session],|r|Ok(SetupQuestion{id:r.get(0)?,position:r.get(1)?,prompt_summary:r.get::<_,String>(2)?.chars().take(160).collect(),state:r.get(3)?,eligible_participant_count:r.get(4)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let ids=tx.prepare("SELECT id FROM peer_review_activities WHERE session_id=?1 ORDER BY created_at DESC,id DESC")?.query_map([session],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let activities = ids
        .iter()
        .map(|id| projected(&tx, session, id))
        .collect::<Result<Vec<_>>>()?;
    let mut group_sets=tx.prepare("SELECT id,revision,created_at FROM session_group_sets WHERE session_id=?1 ORDER BY revision DESC")?
        .query_map([session],|r|Ok(SetupGroupSet{id:r.get(0)?,revision:r.get(1)?,created_at:r.get(2)?,questions:vec![]}))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for set in &mut group_sets {
        for q in &questions {
            let groups=tx.prepare("SELECT g.name,(SELECT COUNT(*) FROM session_group_members m WHERE m.group_id=g.id AND m.group_set_id=g.group_set_id AND EXISTS(SELECT 1 FROM submissions s WHERE s.participant_id=m.participant_id AND s.session_question_id=?2)) FROM session_groups g WHERE g.group_set_id=?1 ORDER BY g.position,g.id")?
                .query_map(params![set.id,q.id],|r|Ok(SetupGroup{name:r.get(0)?,essay_count:r.get(1)?}))?.collect::<std::result::Result<Vec<_>,_>>()?;
            set.questions.push(GroupPreflight {
                session_question_id: q.id.clone(),
                eligible_group_count: groups.iter().filter(|g| g.essay_count > 0).count() as i64,
                groups,
            });
        }
    }
    tx.commit()?;
    Ok(PeerReviewSetupContext {
        session_id: session.to_owned(),
        session_state: state,
        classroom_name: name,
        questions,
        activities,
        group_sets,
    })
}
