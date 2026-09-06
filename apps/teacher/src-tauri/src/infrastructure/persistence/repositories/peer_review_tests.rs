use super::*;
use crate::application::{peer_review::PeerReviewService, StatisticsService};
use crate::infrastructure::persistence::repositories::{
    live_quiz::{LiveQuizRepository, NewSubmission},
    local_session::LocalSessionRepository,
};
use std::sync::{Arc, Barrier};
#[path = "peer_review_setup_tests.rs"]
mod teacher_setup_tests;

#[test]
fn ownership_slots_and_response_constraints_reject_invalid_records() {
    let f = Fixture::new(3);
    f.ready();
    let a = f.draft(PeerReviewMode::StudentSelect, Some(2), None);
    let other = f.draft(PeerReviewMode::StudentSelect, None, None);
    f.service.open_activity(&a.id).expect("open");
    f.service.open_activity(&other.id).expect("other open");
    assert_eq!(
        f.service
            .claim_target(&a.id, &f.participants[0], &f.target(&other.id, 1).id),
        Err(PeerReviewError::TargetNotFound)
    );
    let claimed = f
        .service
        .claim_target(&a.id, &f.participants[0], &f.target(&a.id, 1).id)
        .expect("claim");
    assert_eq!(
        f.service
            .submit_review_revision(f.request(&claimed.id, 1, 0, "Unauthorized")),
        Err(PeerReviewError::ReviewerNotAuthorized)
    );
    let c = f.db.connection().expect("connection");
    assert!(c
        .execute(
            "UPDATE peer_review_assignments SET slot_index=0 WHERE id=?1",
            [&claimed.id]
        )
        .is_err());
    assert!(c
        .execute(
            "UPDATE peer_review_assignments SET target_id=?1 WHERE id=?2",
            params![f.target(&other.id, 1).id, claimed.id]
        )
        .is_err());
    assert!(c
        .execute(
            "UPDATE peer_review_assignments SET reviewer_participant_id=NULL WHERE id=?1",
            [&claimed.id]
        )
        .is_err());
    assert!(c.execute("INSERT INTO peer_review_assignments SELECT ?1,activity_id,mode,reviewer_participant_id,reviewer_session_group_id,session_group_set_id,target_id,target_group_id,slot_index,created_at,updated_at FROM peer_review_assignments WHERE id=?2", params![new_id(), claimed.id]).is_err());
    drop(c);
    let boundary = f.request(&claimed.id, 0, 0, &"字".repeat(10_000));
    let accepted = f
        .service
        .submit_review_revision(boundary)
        .expect("exact body limit");
    let c = f.db.connection().expect("connection");
    assert!(c.execute("INSERT INTO peer_review_responses SELECT ?1,assignment_id,submitted_by_participant_id,revision,expected_base_revision,body,submitted_at FROM peer_review_responses WHERE id=?2", params![new_id(), accepted.id]).is_err());
    assert!(c
        .execute(
            "UPDATE peer_review_responses SET revision=3 WHERE id=?1",
            [&accepted.id]
        )
        .is_err());
    assert!(c
        .execute(
            "UPDATE peer_review_responses SET body='' WHERE id=?1",
            [&accepted.id]
        )
        .is_err());
    assert_eq!(
        f.service
            .list_review_revisions(&claimed.id)
            .expect("unchanged"),
        vec![accepted]
    );
}

struct Fixture {
    dir: tempfile::TempDir,
    db: Database,
    service: PeerReviewService,
    session: String,
    question: String,
    participants: Vec<String>,
}
impl Fixture {
    fn new(n: usize) -> Self {
        let dir = tempfile::tempdir().expect("fixture");
        let db = Database::open(dir.path().join("classroom.sqlite3"));
        db.initialize().expect("schema");
        let c = db.connection().expect("c");
        let session = new_id();
        let question = new_id();
        let class = new_id();
        c.execute("INSERT INTO classes(id,name,created_at,updated_at) VALUES(?1,'Review class','now','now')",[&class]).expect("class");
        c.execute("INSERT INTO local_sessions(id,classroom_id,server_instance_id,state,join_mode,join_code,created_at,updated_at) VALUES(?1,?2,'test-server','ACTIVE','roster_match','ABCDEFGH','now','now')",params![session,class]).expect("session");
        c.execute("INSERT INTO session_questions(id,session_id,question_type,prompt,points,position,answer_config,grading_config,metadata,config_version,state,created_at,updated_at) VALUES(?1,?2,'essay','Explain',5,0,'{}','{}','{}',1,'OPEN','now','now')",params![question,session]).expect("question");
        let participants=(0..n).map(|i| {let p=new_id();let student=new_id();
            c.execute("INSERT INTO students(id,class_id,seat_number,name,created_at,updated_at) VALUES(?1,?2,?3,'Student','now','now')",params![student,class,i as i64+1]).expect("student");
            c.execute("INSERT INTO session_participants(id,session_id,student_id,seat_number,display_name,credential_hash,joined_at,updated_at) VALUES(?1,?2,?3,?4,'Student','test-hash','now','now')",params![p,session,student,i as i64+1]).expect("participant");p}).collect();
        drop(c);
        let service = PeerReviewService::initialize(dir.path()).expect("service");
        Self {
            dir,
            db,
            service,
            session,
            question,
            participants,
        }
    }
    fn essay(&self, i: usize, text: &str) -> String {
        let id = new_id();
        LiveQuizRepository::submit(
            &self.db,
            NewSubmission {
                id: id.clone(),
                session_question_id: self.question.clone(),
                participant_id: self.participants[i].clone(),
                answer_json: serde_json::json!({"type":"essay","text":text}),
                grading_status: "pending".into(),
                is_correct: None,
                score: None,
                max_score: 5,
            },
        )
        .expect("accepted");
        id
    }
    fn state(&self, state: &str) {
        self.db
            .connection()
            .expect("c")
            .execute(
                "UPDATE session_questions SET state=?1 WHERE id=?2",
                params![state, self.question],
            )
            .expect("state");
    }
    fn ready(&self) {
        for i in 0..self.participants.len() {
            self.essay(i, &format!("Essay {i}"));
        }
        self.state("LOCKED");
    }
    fn draft(
        &self,
        mode: PeerReviewMode,
        capacity: Option<i64>,
        set: Option<String>,
    ) -> PeerReviewActivity {
        self.service
            .create_activity_draft(CreatePeerReviewActivity {
                session_id: self.session.clone(),
                session_question_id: self.question.clone(),
                mode,
                session_group_set_id: set,
                max_reviews_per_target: capacity,
            })
            .expect("draft")
    }
    fn target(&self, id: &str, i: usize) -> PeerReviewTarget {
        self.service
            .list_target_statuses(id)
            .expect("targets")
            .into_iter()
            .find(|s| s.target.participant_id == self.participants[i])
            .expect("target")
            .target
    }
    fn request(&self, id: &str, i: usize, base: i64, body: &str) -> SubmitPeerReview {
        SubmitPeerReview {
            review_submission_id: new_id(),
            assignment_id: id.into(),
            submitted_by_participant_id: self.participants[i].clone(),
            expected_base_revision: base,
            body: body.into(),
        }
    }
    fn groups(&self, revision: i64, members: &[Vec<usize>]) -> (String, Vec<String>) {
        let c = self.db.connection().expect("c");
        let set = new_id();
        c.execute("INSERT INTO session_group_sets(id,session_id,revision,created_at) VALUES(?1,?2,?3,'now')",params![set,self.session,revision]).expect("set");
        let groups=members.iter().enumerate().map(|(i,ps)|{let g=new_id();c.execute("INSERT INTO session_groups(id,group_set_id,name,position,created_at) VALUES(?1,?2,?3,?4,'now')",params![g,set,format!("Group {i}"),i as i64]).expect("group");for p in ps{c.execute("INSERT INTO session_group_members(id,group_set_id,group_id,participant_id,created_at) VALUES(?1,?2,?3,?4,'now')",params![new_id(),set,g,self.participants[*p]]).expect("member");}g}).collect();
        (set, groups)
    }
}

#[test]
fn random_two_and_five_are_persisted_cycles_and_freeze_latest_essay() {
    for n in [2, 5] {
        let f = Fixture::new(n);
        f.ready();
        f.state("OPEN");
        let rev2 = f.essay(0, "revision two");
        f.state("REVEALED");
        let a = f.draft(PeerReviewMode::RandomOneToOne, None, None);
        f.service.open_activity(&a.id).expect("open");
        let assignments = f.service.list_assignments(&a.id).expect("assignments");
        assert_eq!(assignments.len(), n);
        let mut reviewers = std::collections::HashSet::new();
        let mut targets = std::collections::HashSet::new();
        for item in &assignments {
            let t = f
                .service
                .get_assignment(&item.id)
                .expect("detail")
                .target
                .expect("target");
            assert_ne!(
                item.reviewer_participant_id.as_deref(),
                Some(t.participant_id.as_str())
            );
            assert!(reviewers.insert(item.reviewer_participant_id.clone()));
            assert!(targets.insert(t.id));
        }
        let frozen = f.target(&a.id, 0);
        assert_eq!(frozen.submission_id, rev2);
        assert_eq!(frozen.source_revision, 2);
        f.state("OPEN");
        f.essay(0, "revision three");
        assert_eq!(f.target(&a.id, 0), frozen);
        let reopened = PeerReviewService::initialize(f.dir.path()).expect("reopen");
        assert_eq!(
            reopened.list_assignments(&a.id).expect("durable"),
            assignments
        );
        assert_eq!(
            reopened.open_activity(&a.id),
            Err(PeerReviewError::PeerReviewAlreadyOpen)
        );
    }
}

#[test]
fn source_validation_and_insufficient_participants_fail_closed() {
    let f = Fixture::new(2);
    let mut req = CreatePeerReviewActivity {
        session_id: f.session.clone(),
        session_question_id: f.question.clone(),
        mode: PeerReviewMode::StudentSelect,
        session_group_set_id: None,
        max_reviews_per_target: Some(2),
    };
    let c = f.db.connection().expect("c");
    for kind in [
        "true_false",
        "single_choice",
        "multiple_choice",
        "fill_blank",
    ] {
        c.execute(
            "UPDATE session_questions SET question_type=?1 WHERE id=?2",
            params![kind, f.question],
        )
        .expect("kind");
        assert_eq!(
            f.service.create_activity_draft(req.clone()),
            Err(PeerReviewError::PeerReviewEssayRequired)
        );
    }
    c.execute(
        "UPDATE session_questions SET question_type='essay' WHERE id=?1",
        [&f.question],
    )
    .expect("essay");
    c.execute(
        "UPDATE local_sessions SET state='LOBBY' WHERE id=?1",
        [&f.session],
    )
    .expect("lobby");
    assert_eq!(
        f.service.create_activity_draft(req.clone()),
        Err(PeerReviewError::SessionNotActive)
    );
    c.execute(
        "UPDATE local_sessions SET state='ACTIVE' WHERE id=?1",
        [&f.session],
    )
    .expect("active");
    req.max_reviews_per_target = Some(0);
    assert_eq!(
        f.service.create_activity_draft(req.clone()),
        Err(PeerReviewError::InvalidInput)
    );
    req.max_reviews_per_target = None;
    req.session_question_id = new_id();
    assert_eq!(
        f.service.create_activity_draft(req),
        Err(PeerReviewError::QuestionSessionMismatch)
    );
    let a = f.draft(PeerReviewMode::RandomOneToOne, None, None);
    assert_eq!(
        f.service.open_activity(&a.id),
        Err(PeerReviewError::QuestionNotReady)
    );
    f.essay(0, "only one");
    f.state("LOCKED");
    assert_eq!(
        f.service.open_activity(&a.id),
        Err(PeerReviewError::InsufficientReviewParticipants)
    );
    assert_eq!(
        f.service.get_activity(&a.id).expect("a").state,
        PeerReviewActivityState::Draft
    );
    assert!(f
        .service
        .list_target_statuses(&a.id)
        .expect("targets")
        .is_empty());
    f.service.cancel_draft(&a.id).expect("cancel");
    assert_eq!(
        f.service.open_activity(&a.id),
        Err(PeerReviewError::PeerReviewClosed)
    );
}

#[test]
fn open_rolls_back_targets_and_partial_assignments() {
    let f = Fixture::new(3);
    f.ready();
    let a = f.draft(PeerReviewMode::RandomOneToOne, None, None);
    let c = f.db.connection().expect("c");
    c.execute_batch("CREATE TRIGGER injected_review_failure BEFORE INSERT ON peer_review_assignments WHEN (SELECT COUNT(*) FROM peer_review_assignments)>=1 BEGIN SELECT RAISE(ABORT,'injected'); END;").expect("inject");
    assert_eq!(
        f.service.open_activity(&a.id),
        Err(PeerReviewError::Storage)
    );
    assert_eq!(
        f.service.get_activity(&a.id).expect("a").state,
        PeerReviewActivityState::Draft
    );
    assert!(f
        .service
        .list_target_statuses(&a.id)
        .expect("targets")
        .is_empty());
    assert!(f
        .service
        .list_assignments(&a.id)
        .expect("assignments")
        .is_empty());
    c.execute_batch("DROP TRIGGER injected_review_failure")
        .expect("remove");
    f.service.open_activity(&a.id).expect("retry");
}

#[test]
fn claims_capacity_moves_revisions_counts_and_idempotency() {
    let f = Fixture::new(5);
    f.ready();
    let a = f.draft(PeerReviewMode::StudentSelect, Some(2), None);
    f.service.open_activity(&a.id).expect("open");
    assert!(f.service.list_assignments(&a.id).expect("empty").is_empty());
    let ta = f.target(&a.id, 0);
    let tb = f.target(&a.id, 1);
    let tc = f.target(&a.id, 2);
    assert_eq!(
        f.service.claim_target(&a.id, &f.participants[0], &ta.id),
        Err(PeerReviewError::SelfReviewNotAllowed)
    );
    let first = f
        .service
        .claim_target(&a.id, &f.participants[2], &ta.id)
        .expect("first");
    let second = f
        .service
        .claim_target(&a.id, &f.participants[3], &ta.id)
        .expect("second");
    assert_eq!(
        f.service
            .claim_target(&a.id, &f.participants[2], &ta.id)
            .expect("replay"),
        first
    );
    assert_eq!(
        f.service.claim_target(&a.id, &f.participants[4], &ta.id),
        Err(PeerReviewError::TargetReviewCapacityFull)
    );
    let old = f
        .service
        .claim_target(&a.id, &f.participants[4], &tb.id)
        .expect("old");
    assert_eq!(
        f.service.claim_target(&a.id, &f.participants[4], &ta.id),
        Err(PeerReviewError::TargetReviewCapacityFull)
    );
    assert_eq!(
        f.service
            .get_assignment(&old.id)
            .expect("retained")
            .assignment
            .target_id,
        Some(tb.id.clone())
    );
    let moved = f
        .service
        .claim_target(&a.id, &f.participants[4], &tc.id)
        .expect("move");
    assert_eq!(moved.id, old.id);
    let statuses = f.service.list_target_statuses(&a.id).expect("status");
    let s = statuses.iter().find(|s| s.target.id == ta.id).expect("s");
    assert_eq!(
        (
            s.claimed_review_count,
            s.submitted_review_count,
            s.remaining_capacity,
            s.has_received_any_review
        ),
        (2, 0, Some(0), false)
    );
    let req = f.request(&first.id, 2, 0, "  feedback 一  ");
    let r1 = f.service.submit_review_revision(req.clone()).expect("r1");
    assert_eq!(r1.body, "feedback 一");
    assert_eq!(
        f.service
            .submit_review_revision(req.clone())
            .expect("replay"),
        r1
    );
    let mut conflict = req;
    conflict.body = "different".into();
    assert_eq!(
        f.service.submit_review_revision(conflict),
        Err(PeerReviewError::ReviewSubmissionConflict)
    );
    for base in [1, 2] {
        f.service
            .submit_review_revision(f.request(
                &first.id,
                2,
                base,
                &format!("revision {}", base + 1),
            ))
            .expect("revision");
    }
    assert_eq!(
        f.service.list_review_revisions(&first.id).expect("history")[0],
        r1
    );
    assert_eq!(
        f.service
            .get_assignment(&first.id)
            .expect("latest")
            .assignment
            .latest_review_revision
            .expect("rev")
            .revision,
        3
    );
    assert_eq!(
        f.service.claim_target(&a.id, &f.participants[2], &tb.id),
        Err(PeerReviewError::ReviewTargetLockedAfterSubmission)
    );
    assert_eq!(
        f.service
            .list_target_statuses(&a.id)
            .expect("status")
            .iter()
            .find(|s| s.target.id == ta.id)
            .expect("s")
            .submitted_review_count,
        1
    );
    f.service
        .submit_review_revision(f.request(&second.id, 3, 0, "second review"))
        .expect("r");
    f.service
        .submit_review_revision(f.request(&moved.id, 4, 0, "C review"))
        .expect("r");
    let statuses = f.service.list_target_statuses(&a.id).expect("status");
    for (id, count) in [(&ta.id, 2), (&tb.id, 0), (&tc.id, 1)] {
        let s = statuses.iter().find(|s| s.target.id == *id).expect("s");
        assert_eq!(s.submitted_review_count, count);
        assert_eq!(s.has_received_any_review, count > 0);
    }
    for bad in [
        " \t\n".to_owned(),
        "字".repeat(10001),
        "has\0null".to_owned(),
    ] {
        assert_eq!(
            f.service
                .submit_review_revision(f.request(&first.id, 2, 3, &bad)),
            Err(PeerReviewError::InvalidInput)
        );
    }
    f.service.close_activity(&a.id).expect("close");
    assert_eq!(
        f.service
            .submit_review_revision(f.request(&first.id, 2, 3, "late")),
        Err(PeerReviewError::PeerReviewClosed)
    );
    assert_eq!(
        f.service.claim_target(&a.id, &f.participants[4], &tb.id),
        Err(PeerReviewError::PeerReviewClosed)
    );
    assert_eq!(
        f.service
            .list_review_revisions(&first.id)
            .expect("retained")
            .len(),
        3
    );
}

#[test]
fn simultaneous_last_capacity_slot_has_one_winner() {
    let f = Fixture::new(4);
    f.ready();
    let a = f.draft(PeerReviewMode::StudentSelect, Some(2), None);
    f.service.open_activity(&a.id).expect("open");
    let t = f.target(&a.id, 0);
    f.service
        .claim_target(&a.id, &f.participants[1], &t.id)
        .expect("occupied");
    let barrier = Arc::new(Barrier::new(2));
    let handles = [2, 3]
        .into_iter()
        .map(|i| {
            let s = f.service.clone();
            let aid = a.id.clone();
            let tid = t.id.clone();
            let p = f.participants[i].clone();
            let b = barrier.clone();
            std::thread::spawn(move || {
                b.wait();
                s.claim_target(&aid, &p, &tid)
            })
        })
        .collect::<Vec<_>>();
    let results = handles
        .into_iter()
        .map(|h| h.join().expect("thread"))
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(PeerReviewError::TargetReviewCapacityFull)))
            .count(),
        1
    );
    assert_eq!(f.service.list_assignments(&a.id).expect("claims").len(), 2);
}

#[test]
fn reviewer_requires_frozen_submission_and_capacity_can_be_unlimited() {
    let f = Fixture::new(4);
    for i in 0..3 {
        f.essay(i, "essay");
    }
    f.state("LOCKED");
    let a = f.draft(PeerReviewMode::StudentSelect, None, None);
    f.service.open_activity(&a.id).expect("open");
    let t = f.target(&a.id, 0);
    assert_eq!(
        f.service.claim_target(&a.id, &f.participants[3], &t.id),
        Err(PeerReviewError::ReviewerNotEligible)
    );
    for i in 1..3 {
        f.service
            .claim_target(&a.id, &f.participants[i], &t.id)
            .expect("unlimited");
    }
    assert!(f
        .service
        .list_target_statuses(&a.id)
        .expect("status")
        .iter()
        .all(|s| s.remaining_capacity.is_none()));
}

#[test]
fn cross_group_frozen_bundles_shared_authorization_and_revision_race() {
    let f = Fixture::new(7);
    for i in [0, 1, 2, 3, 5] {
        f.essay(i, "captured");
    }
    f.state("LOCKED");
    f.groups(1, &[vec![0, 2], vec![1, 3, 4, 5, 6]]);
    let (rev2, groups) = f.groups(2, &[vec![0, 1], vec![2, 3, 4], vec![5], vec![6], vec![]]);
    let a = f.draft(PeerReviewMode::CrossGroup, None, Some(rev2.clone()));
    f.service.open_activity(&a.id).expect("open");
    let bundles = f.service.list_group_targets(&a.id).expect("bundles");
    assert_eq!(bundles.len(), 3);
    assert_eq!(
        bundles
            .iter()
            .find(|b| b.session_group_id == groups[1])
            .expect("B")
            .captured_submission_items
            .len(),
        2
    );
    let assignments = f.service.list_assignments(&a.id).expect("a");
    assert_eq!(assignments.len(), 3);
    let mut incoming = std::collections::HashSet::new();
    let mut outgoing = std::collections::HashSet::new();
    for item in &assignments {
        let bundle = f
            .service
            .get_assignment(&item.id)
            .expect("detail")
            .group_target
            .expect("bundle");
        assert_ne!(
            item.reviewer_session_group_id.as_deref(),
            Some(bundle.session_group_id.as_str())
        );
        assert!(incoming.insert(bundle.id));
        assert!(outgoing.insert(item.reviewer_session_group_id.clone()));
        assert!(item.reviewer_participant_id.is_none());
    }
    let own = assignments
        .iter()
        .find(|a| a.reviewer_session_group_id.as_deref() == Some(groups[0].as_str()))
        .expect("group A");
    let req = f.request(&own.id, 0, 0, "group feedback");
    let first = f.service.submit_review_revision(req.clone()).expect("P1");
    assert_eq!(
        f.service
            .submit_review_revision(f.request(&own.id, 2, 1, "foreign")),
        Err(PeerReviewError::ReviewerNotAuthorized)
    );
    let barrier = Arc::new(Barrier::new(2));
    let handles = [0, 1]
        .into_iter()
        .map(|i| {
            let s = f.service.clone();
            let r = f.request(&own.id, i, 1, &format!("edit {i}"));
            let b = barrier.clone();
            std::thread::spawn(move || {
                b.wait();
                s.submit_review_revision(r)
            })
        })
        .collect::<Vec<_>>();
    let results = handles
        .into_iter()
        .map(|h| h.join().expect("thread"))
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(PeerReviewError::ReviewRevisionConflict)))
            .count(),
        1
    );
    f.service
        .submit_review_revision(f.request(&own.id, 1, 2, "P2 shared edit"))
        .expect("P2");
    assert_eq!(
        f.service.list_review_revisions(&own.id).expect("history")[0],
        first
    );
    assert_eq!(
        f.service
            .list_assignments(&a.id)
            .expect("logical reviews")
            .len(),
        3
    );
    f.groups(3, &[vec![0, 2, 3], vec![1, 4, 5, 6]]);
    assert_eq!(
        f.service
            .get_activity(&a.id)
            .expect("frozen")
            .session_group_set_id,
        Some(rev2)
    );
    assert_eq!(
        f.service.list_group_targets(&a.id).expect("frozen bundles"),
        bundles
    );
    assert_eq!(
        f.service.submit_review_revision(req).expect("replay"),
        first
    );
}

#[test]
fn cross_group_missing_or_insufficient_groups_fail_closed() {
    let f = Fixture::new(3);
    f.ready();
    let req = CreatePeerReviewActivity {
        session_id: f.session.clone(),
        session_question_id: f.question.clone(),
        mode: PeerReviewMode::CrossGroup,
        session_group_set_id: None,
        max_reviews_per_target: None,
    };
    assert_eq!(
        f.service.create_activity_draft(req.clone()),
        Err(PeerReviewError::GroupSetRequired)
    );
    let mut foreign = req;
    foreign.session_group_set_id = Some(new_id());
    assert_eq!(
        f.service.create_activity_draft(foreign),
        Err(PeerReviewError::GroupSetSessionMismatch)
    );
    let (set, _) = f.groups(1, &[vec![0, 1, 2]]);
    let a = f.draft(PeerReviewMode::CrossGroup, None, Some(set));
    assert_eq!(
        f.service.open_activity(&a.id),
        Err(PeerReviewError::InsufficientReviewGroups)
    );
    assert!(f
        .service
        .list_target_statuses(&a.id)
        .expect("targets")
        .is_empty());
    assert!(f
        .service
        .list_group_targets(&a.id)
        .expect("groups")
        .is_empty());
    assert_eq!(
        f.service.get_activity(&a.id).expect("a").state,
        PeerReviewActivityState::Draft
    );
}

#[test]
fn records_do_not_change_statistics_and_survive_end_roster_delete_reopen() {
    let f = Fixture::new(3);
    f.ready();
    let stats = StatisticsService::initialize(f.db.clone());
    let before =
        serde_json::to_value(stats.session_statistics(&f.session).expect("stats")).expect("json");
    let participant_before = f
        .participants
        .iter()
        .map(|p| {
            serde_json::to_value(stats.participant_statistics(&f.session, p).expect("stats"))
                .expect("json")
        })
        .collect::<Vec<_>>();
    let question_before = serde_json::to_value(
        stats
            .question_statistics(&f.session, &f.question)
            .expect("stats"),
    )
    .expect("json");
    let a = f.draft(PeerReviewMode::StudentSelect, Some(3), None);
    let draft = f.draft(PeerReviewMode::RandomOneToOne, None, None);
    f.service.open_activity(&a.id).expect("open");
    let target = f.target(&a.id, 1);
    let assignment = f
        .service
        .claim_target(&a.id, &f.participants[0], &target.id)
        .expect("claim");
    let req = f.request(&assignment.id, 0, 0, "record only");
    let response = f
        .service
        .submit_review_revision(req.clone())
        .expect("review");
    assert_eq!(
        serde_json::to_value(stats.session_statistics(&f.session).expect("after")).expect("json"),
        before
    );
    assert_eq!(
        serde_json::to_value(
            stats
                .question_statistics(&f.session, &f.question)
                .expect("after")
        )
        .expect("json"),
        question_before
    );
    for (p, before) in f.participants.iter().zip(participant_before) {
        assert_eq!(
            serde_json::to_value(stats.participant_statistics(&f.session, p).expect("after"))
                .expect("json"),
            before
        );
    }
    let source = LiveQuizRepository::get_submission(&f.db, &target.submission_id)
        .expect("s")
        .expect("source");
    assert_eq!(source.grading_status, "pending");
    assert!(source.score.is_none());
    assert!(source.is_correct.is_none());
    LocalSessionRepository::end(&f.db, &f.session, "teacher_ended").expect("end");
    assert_eq!(
        f.service.get_activity(&a.id).expect("a").state,
        PeerReviewActivityState::Closed
    );
    assert_eq!(
        f.service.get_activity(&draft.id).expect("d").state,
        PeerReviewActivityState::Cancelled
    );
    assert_eq!(
        f.service
            .submit_review_revision(f.request(&assignment.id, 0, 1, "late")),
        Err(PeerReviewError::SessionEnded)
    );
    assert_eq!(
        f.service
            .submit_review_revision(req)
            .expect("accepted replay"),
        response
    );
    f.db.connection()
        .expect("c")
        .execute("DELETE FROM students", [])
        .expect("roster deletion");
    let reopened = PeerReviewService::initialize(f.dir.path()).expect("reopen");
    assert_eq!(
        reopened
            .list_review_revisions(&assignment.id)
            .expect("history"),
        vec![response]
    );
    assert_eq!(
        reopened
            .get_assignment(&assignment.id)
            .expect("target")
            .target,
        Some(target)
    );
    assert_eq!(
        reopened
            .list_session_activities(&f.session)
            .expect("activities")
            .len(),
        2
    );
    let c = f.db.connection().expect("c");
    for table in [
        "submissions",
        "peer_review_targets",
        "peer_review_assignments",
        "peer_review_activities",
    ] {
        assert!(c.execute(&format!("DELETE FROM {table}"), []).is_err());
    }
    assert!(!c
        .prepare("PRAGMA foreign_key_check")
        .expect("fk")
        .exists([])
        .expect("no orphan"));
}

#[test]
fn restart_closes_open_cancels_draft_and_retains_reviews() {
    let f = Fixture::new(2);
    f.ready();
    let a = f.draft(PeerReviewMode::RandomOneToOne, None, None);
    let d = f.draft(PeerReviewMode::StudentSelect, None, None);
    f.service.open_activity(&a.id).expect("open");
    let assigned = f.service.list_assignments(&a.id).expect("a")[0].clone();
    let reviewer = f
        .participants
        .iter()
        .position(|p| Some(p) == assigned.reviewer_participant_id.as_ref())
        .expect("reviewer");
    let r = f
        .service
        .submit_review_revision(f.request(&assigned.id, reviewer, 0, "retained"))
        .expect("review");
    LocalSessionRepository::end_stale_sessions(&f.db).expect("recovery");
    assert_eq!(
        f.service.get_activity(&a.id).expect("a").state,
        PeerReviewActivityState::Closed
    );
    assert_eq!(
        f.service.get_activity(&d.id).expect("d").state,
        PeerReviewActivityState::Cancelled
    );
    assert_eq!(
        f.service
            .list_review_revisions(&assigned.id)
            .expect("retained"),
        vec![r]
    );
}
