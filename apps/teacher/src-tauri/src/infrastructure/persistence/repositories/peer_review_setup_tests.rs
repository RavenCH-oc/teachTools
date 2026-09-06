use super::*;
use crate::application::peer_review_setup::{PeerReviewSetupService, SavePeerReviewDraft};

fn request(f: &Fixture, mode: PeerReviewMode) -> SavePeerReviewDraft {
    SavePeerReviewDraft {
        session_id: f.session.clone(),
        session_question_id: f.question.clone(),
        mode,
        max_reviews_per_target: None,
        session_group_set_id: None,
    }
}
#[test]
fn context_projects_snapshot_counts_revisions_without_private_records() {
    let f = Fixture::new(4);
    f.essay(0, "PRIVATE_ESSAY_SENTINEL");
    f.essay(0, "latest");
    f.essay(1, "answer");
    f.groups(1, &[vec![0, 1], vec![2, 3]]);
    let (latest, _) = f.groups(2, &[vec![0], vec![1], vec![2, 3], vec![]]);
    let service = PeerReviewSetupService::initialize(f.db.clone());
    let context = service.context(&f.session).expect("context");
    assert_eq!(context.questions.len(), 1);
    assert_eq!(context.questions[0].eligible_participant_count, 2);
    assert_eq!(context.group_sets[0].id, latest);
    assert_eq!(context.group_sets[0].questions[0].eligible_group_count, 2);
    assert_eq!(context.group_sets[1].questions[0].eligible_group_count, 1);
    assert_eq!(
        context.group_sets[0].questions[0]
            .groups
            .iter()
            .filter(|g| g.essay_count == 0)
            .count(),
        2
    );
    let json = serde_json::to_string(&context).expect("json");
    for forbidden in [
        "PRIVATE_ESSAY_SENTINEL",
        "answer_json",
        "credential",
        "participant_id",
        "connectionId",
        "score",
    ] {
        assert!(!json.contains(forbidden));
    }
    let c = f.db.connection().expect("connection");
    c.execute(
        "UPDATE session_questions SET question_type='true_false'",
        [],
    )
    .expect("kind");
    assert!(service
        .context(&f.session)
        .expect("context")
        .questions
        .is_empty());
    assert_eq!(
        service
            .save(None, request(&f, PeerReviewMode::RandomOneToOne))
            .expect_err("essay required"),
        PeerReviewError::PeerReviewEssayRequired
    );
}

#[test]
fn draft_configuration_limits_ownership_and_durable_reload() {
    let f = Fixture::new(2);
    f.ready();
    let service = PeerReviewSetupService::initialize(f.db.clone());
    let mut r = request(&f, PeerReviewMode::StudentSelect);
    for limit in [Some(1), Some(3), None] {
        r.max_reviews_per_target = limit;
        let draft = service.save(None, r.clone()).expect("create");
        let mut edit = r.clone();
        edit.max_reviews_per_target = Some(4);
        let saved = service.save(Some(&draft.id), edit).expect("update");
        assert_eq!(saved.max_reviews_per_target, Some(4));
        let reloaded = PeerReviewSetupService::initialize(f.db.clone())
            .context(&f.session)
            .expect("reopen");
        assert_eq!(reloaded.activities[0].state, PeerReviewActivityState::Draft);
        assert_eq!(reloaded.activities[0].max_reviews_per_target, Some(4));
        assert_eq!(
            service.open("foreign", &draft.id).expect_err("ownership"),
            PeerReviewError::PeerReviewActivityNotFound
        );
        service.cancel(&f.session, &draft.id).expect("cancel");
    }
    for limit in [0, -1, 9_007_199_254_740_992, i64::MAX] {
        r.max_reviews_per_target = Some(limit);
        assert_eq!(
            service.save(None, r.clone()).expect_err("invalid capacity"),
            PeerReviewError::InvalidInput
        );
    }
    r.max_reviews_per_target = None;
    r.session_question_id = new_id();
    assert_eq!(
        service.save(None, r).expect_err("question ownership"),
        PeerReviewError::QuestionSessionMismatch
    );
}

#[test]
fn teacher_policy_serializes_duplicate_creates_and_blocks_duplicate_edits() {
    let f = Fixture::new(2);
    f.ready();
    let barrier = Arc::new(Barrier::new(2));
    let handles = (0..2)
        .map(|_| {
            let db = f.db.clone();
            let r = request(&f, PeerReviewMode::RandomOneToOne);
            let b = barrier.clone();
            std::thread::spawn(move || {
                b.wait();
                PeerReviewSetupService::initialize(db).save(None, r)
            })
        })
        .collect::<Vec<_>>();
    let results = handles
        .into_iter()
        .map(|h| h.join().expect("join"))
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(PeerReviewError::PeerReviewAlreadyOpen)))
            .count(),
        1
    );
    let service = PeerReviewSetupService::initialize(f.db.clone());
    let legacy = f.draft(PeerReviewMode::StudentSelect, None, None);
    assert_eq!(
        service
            .save(
                Some(&legacy.id),
                request(&f, PeerReviewMode::RandomOneToOne)
            )
            .expect_err("duplicate edit"),
        PeerReviewError::PeerReviewAlreadyOpen
    );
    assert_eq!(
        service
            .open(&f.session, &legacy.id)
            .expect_err("legacy duplicate"),
        PeerReviewError::PeerReviewAlreadyOpen
    );
}

#[test]
fn open_locks_config_freezes_counts_and_close_retains_history() {
    let f = Fixture::new(3);
    let service = PeerReviewSetupService::initialize(f.db.clone());
    let r = request(&f, PeerReviewMode::RandomOneToOne);
    let draft = service.save(None, r.clone()).expect("draft");
    assert_eq!(
        service
            .open(&f.session, &draft.id)
            .expect_err("question open"),
        PeerReviewError::QuestionNotReady
    );
    for n in 0..2 {
        if n == 1 {
            f.state("OPEN");
            f.essay(0, "one");
        }
        f.state("LOCKED");
        assert_eq!(
            service.context(&f.session).expect("context").questions[0].eligible_participant_count,
            n
        );
        assert_eq!(
            service
                .open(&f.session, &draft.id)
                .expect_err("insufficient"),
            PeerReviewError::InsufficientReviewParticipants
        );
    }
    f.state("OPEN");
    f.essay(1, "two");
    f.state("LOCKED");
    let opened = service.open(&f.session, &draft.id).expect("open");
    assert_eq!(opened.frozen_target_count, 2);
    assert_eq!(
        service
            .save(Some(&draft.id), r.clone())
            .expect_err("immutable"),
        PeerReviewError::PeerReviewClosed
    );
    f.state("OPEN");
    f.essay(2, "new participant answer");
    f.essay(0, "new revision");
    let context = service.context(&f.session).expect("context");
    assert_eq!(context.questions[0].eligible_participant_count, 3);
    assert_eq!(context.activities[0].frozen_target_count, 2);
    assert_eq!(
        service
            .cancel(&f.session, &draft.id)
            .expect_err("no open cancel"),
        PeerReviewError::PeerReviewNotOpen
    );
    assert_eq!(
        service.close(&f.session, &draft.id).expect("close").state,
        PeerReviewActivityState::Closed
    );
    let next = service.save(None, r).expect("history allows new activity");
    LocalSessionRepository::end(&f.db, &f.session, "teacher_ended").expect("end");
    let ended = service.context(&f.session).expect("ended read");
    assert_eq!(ended.session_state, "ENDED");
    assert_eq!(
        ended
            .activities
            .iter()
            .find(|a| a.id == next.id)
            .expect("next")
            .state,
        PeerReviewActivityState::Cancelled
    );
    assert_eq!(
        service
            .save(None, request(&f, PeerReviewMode::RandomOneToOne))
            .expect_err("ended"),
        PeerReviewError::SessionEnded
    );
}

#[test]
fn cross_group_selection_is_explicit_and_frozen() {
    let f = Fixture::new(3);
    f.essay(0, "A");
    f.essay(1, "B");
    f.state("REVEALED");
    let service = PeerReviewSetupService::initialize(f.db.clone());
    let mut r = request(&f, PeerReviewMode::CrossGroup);
    assert_eq!(
        service.save(None, r.clone()).expect_err("set required"),
        PeerReviewError::GroupSetRequired
    );
    r.session_group_set_id = Some(new_id());
    assert_eq!(
        service.save(None, r.clone()).expect_err("foreign"),
        PeerReviewError::GroupSetSessionMismatch
    );
    let (older, _) = f.groups(1, &[vec![0], vec![1], vec![2]]);
    let (latest, _) = f.groups(2, &[vec![0, 1, 2]]);
    r.session_group_set_id = Some(latest);
    let draft = service.save(None, r.clone()).expect("draft");
    assert_eq!(
        service
            .open(&f.session, &draft.id)
            .expect_err("one eligible group"),
        PeerReviewError::InsufficientReviewGroups
    );
    r.session_group_set_id = Some(older.clone());
    service
        .save(Some(&draft.id), r)
        .expect("historical selection");
    let open = service.open(&f.session, &draft.id).expect("open");
    assert_eq!(open.session_group_set_id, Some(older));
    assert_eq!(open.frozen_target_count, 2);
}
