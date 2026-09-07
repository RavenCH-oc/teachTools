use super::*;
use crate::application::peer_review_student::StudentPeerReviewService;
use crate::infrastructure::persistence::repositories::peer_review::student::*;

#[test]
fn activity_presentation_counts_and_scoped_cursors_share_authorization() {
    let f = Fixture::new(5);
    f.ready();
    let prompt = "題😀".repeat(150);
    f.db.connection()
        .expect("connection")
        .execute(
            "UPDATE session_questions SET prompt=?1 WHERE id=?2",
            params![prompt, f.question],
        )
        .expect("snapshot prompt");
    let a = f.draft(PeerReviewMode::StudentSelect, None, None);
    let b = f.draft(PeerReviewMode::StudentSelect, None, None);
    f.service.open_activity(&a.id).expect("open A");
    f.service.open_activity(&b.id).expect("open B");
    let mut assignment_a = String::new();
    for (activity, reviewers) in [(&a, vec![1, 2]), (&b, vec![1])] {
        let target = f.target(&activity.id, 0);
        for reviewer in reviewers {
            let assigned = f
                .service
                .claim_target(&activity.id, &f.participants[reviewer], &target.id)
                .expect("claim");
            f.service
                .submit_review_revision(f.request(&assigned.id, reviewer, 0, "feedback"))
                .expect("submit");
            if activity.id == a.id && reviewer == 1 {
                assignment_a = assigned.id;
            }
        }
    }
    for revision in [1, 2] {
        f.service
            .submit_review_revision(f.request(&assignment_a, 1, revision, "edited"))
            .expect("revision");
    }
    f.service
        .claim_target(&a.id, &f.participants[3], &f.target(&a.id, 0).id)
        .expect("unsubmitted claim");
    let cards = activities(
        &f.db,
        &f.session,
        &f.participants[0],
        &PageRequest::default(),
    )
    .expect("cards");
    for (id, count) in [(&a.id, 2), (&b.id, 1)] {
        let card = cards
            .items
            .iter()
            .find(|x| &x.activity_id == id)
            .expect("card");
        assert_eq!(card.received_feedback_count, count);
        assert_eq!(card.question_summary.chars().count(), 200);
        assert!(card.question_summary.ends_with('…'));
        assert!(!card.question_summary.contains("Essay"));
        assert!(card.reviewer_group_label.is_none());
    }
    assert_eq!(
        activities(
            &f.db,
            &f.session,
            &f.participants[4],
            &PageRequest::default()
        )
        .expect("other recipient")
        .items[0]
            .received_feedback_count,
        0
    );
    let assigned = f
        .service
        .claim_target(&b.id, &f.participants[2], &f.target(&b.id, 0).id)
        .expect("second B");
    f.service
        .submit_review_revision(f.request(&assigned.id, 2, 0, "B second"))
        .expect("submit");
    let mut saved_cursor = None;
    for activity in [&a, &b] {
        let mut cursor = None;
        let mut ids = std::collections::HashSet::new();
        loop {
            let result = feedback_scoped(
                &f.db,
                &f.session,
                &f.participants[0],
                &PageRequest {
                    limit: Some(1),
                    cursor,
                },
                Some(&activity.id),
            )
            .expect("scoped SQL page");
            for item in result.items {
                assert_eq!(item.activity_id, activity.id);
                assert!(ids.insert(item.assignment_id));
            }
            cursor = result.next_cursor;
            if activity.id == a.id && cursor.is_some() {
                saved_cursor = cursor.clone();
            }
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(ids.len(), 2);
    }
    let request = PageRequest {
        limit: Some(1),
        cursor: saved_cursor,
    };
    assert!(feedback_scoped(&f.db, &f.session, &f.participants[0], &request, Some(&b.id)).is_err());
    assert!(feedback(&f.db, &f.session, &f.participants[0], &request).is_err());
    let wide = feedback(
        &f.db,
        &f.session,
        &f.participants[0],
        &PageRequest {
            limit: Some(1),
            cursor: None,
        },
    )
    .expect("wide");
    assert!(feedback_scoped(
        &f.db,
        &f.session,
        &f.participants[0],
        &PageRequest {
            limit: Some(1),
            cursor: wide.next_cursor
        },
        Some(&a.id)
    )
    .is_err());
    assert_eq!(
        feedback(
            &f.db,
            &f.session,
            &f.participants[0],
            &PageRequest::default()
        )
        .expect("all")
        .items
        .len(),
        4
    );
    for invalid in ["invalid".to_owned(), new_id()] {
        assert!(feedback_scoped(
            &f.db,
            &f.session,
            &f.participants[0],
            &PageRequest::default(),
            Some(&invalid)
        )
        .is_err());
    }
    let plan=f.db.connection().expect("connection").prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM peer_review_assignments x WHERE x.activity_id=?1 AND EXISTS(SELECT 1 FROM peer_review_responses r WHERE r.assignment_id=x.id)").expect("plan").query_map([&a.id],|r|r.get::<_,String>(3)).expect("rows").collect::<std::result::Result<Vec<_>,_>>().expect("plan rows");
    assert!(plan.iter().any(|line| line.contains("INDEX")), "{plan:?}");
}

#[test]
fn student_service_serializes_last_slot_and_preserves_failed_move() {
    let f = Fixture::new(4);
    f.ready();
    let a = f.draft(PeerReviewMode::StudentSelect, Some(1), None);
    f.service.open_activity(&a.id).expect("open");
    let target = f.target(&a.id, 3).id;
    let service = StudentPeerReviewService::new(f.db.clone());
    let barrier = Arc::new(Barrier::new(2));
    let workers = (0..2)
        .map(|i| {
            let service = service.clone();
            let barrier = barrier.clone();
            let session = f.session.clone();
            let p = f.participants[i].clone();
            let a = a.id.clone();
            let target = target.clone();
            std::thread::spawn(move || {
                barrier.wait();
                service.claim(&session, &p, &a, &target)
            })
        })
        .collect::<Vec<_>>();
    let results = workers
        .into_iter()
        .map(|w| w.join().expect("worker"))
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(PeerReviewError::TargetReviewCapacityFull)))
            .count(),
        1
    );
    let own = service
        .claim(
            &f.session,
            &f.participants[2],
            &a.id,
            &f.target(&a.id, 0).id,
        )
        .expect("other target");
    assert!(matches!(
        service.claim(&f.session, &f.participants[2], &a.id, &target),
        Err(PeerReviewError::TargetReviewCapacityFull)
    ));
    let detail = essays(
        &f.db,
        &f.session,
        &f.participants[2],
        &own.assignment_id,
        &PageRequest::default(),
    )
    .expect("preserved");
    assert_eq!(detail.items[0].peer_review_target_id, f.target(&a.id, 0).id);
    let request = f.request(&own.assignment_id, 2, 0, "first");
    service
        .submit(&f.session, &f.participants[2], request)
        .expect("submitted");
    assert!(matches!(
        service.claim(
            &f.session,
            &f.participants[2],
            &a.id,
            &f.target(&a.id, 1).id
        ),
        Err(PeerReviewError::ReviewTargetLockedAfterSubmission)
    ));
    let metadata = candidates(
        &f.db,
        &f.session,
        &f.participants[2],
        &a.id,
        &PageRequest::default(),
    )
    .expect("metadata");
    let received = metadata
        .items
        .iter()
        .find(|t| t.peer_review_target_id == f.target(&a.id, 0).id)
        .expect("received");
    assert_eq!(received.submitted_review_count, 1);
    assert!(received.current_claim);
    let claimed = metadata
        .items
        .iter()
        .find(|t| t.peer_review_target_id == target)
        .expect("claimed only");
    assert_eq!(claimed.submitted_review_count, 0);
    assert!(!claimed.has_received_any_review);
    assert!(claimed.full);
}

#[test]
fn sql_candidate_pages_are_complete_bounded_and_projection_is_constant_size() {
    let f = Fixture::new(401);
    f.ready();
    let a = f.draft(PeerReviewMode::StudentSelect, Some(3), None);
    f.service.open_activity(&a.id).expect("open");
    let p = &f.participants[0];
    let mut request = PageRequest {
        limit: Some(37),
        cursor: None,
    };
    let mut all = Vec::new();
    loop {
        let result = candidates(&f.db, &f.session, p, &a.id, &request).expect("SQL page");
        assert!(result.items.len() <= 37);
        all.extend(result.items);
        request.cursor = result.next_cursor;
        if request.cursor.is_none() {
            break;
        }
    }
    assert_eq!(all.len(), 400);
    assert_eq!(
        all.iter()
            .map(|i| &i.peer_review_target_id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        400
    );
    assert!(serde_json::to_vec(&all).expect("json").len() > 65536);
    let compact =
        serde_json::to_string(&projection(&f.db, &f.session, p).expect("summary")).expect("json");
    assert!(compact.len() < 150);
    assert!(!compact.contains("candidates"));
    for limit in [0, 101, 100000] {
        assert!(candidates(
            &f.db,
            &f.session,
            p,
            &a.id,
            &PageRequest {
                limit: Some(limit),
                cursor: None
            }
        )
        .is_err());
    }
    assert!(activities(
        &f.db,
        &f.session,
        p,
        &PageRequest {
            limit: None,
            cursor: Some("malformed".into())
        }
    )
    .is_err());
    assert!(candidates(&f.db, &f.session, &new_id(), &a.id, &PageRequest::default()).is_err());
}

#[test]
fn random_authorized_frozen_detail_latest_anonymous_feedback_and_closed_visibility() {
    let f = Fixture::new(3);
    f.ready();
    let a = f.draft(PeerReviewMode::RandomOneToOne, None, None);
    let query = PageRequest::default();
    assert!(activities(&f.db, &f.session, &f.participants[0], &query)
        .expect("draft hidden")
        .items
        .is_empty());
    f.service.open_activity(&a.id).expect("open");
    let assignments = f.service.list_assignments(&a.id).expect("assignments");
    for assigned in assignments {
        let reviewer = assigned.reviewer_participant_id.as_ref().expect("reviewer");
        let detail = essays(&f.db, &f.session, reviewer, &assigned.id, &query).expect("own detail");
        assert_eq!(detail.items.len(), 1);
        let target = f
            .service
            .get_assignment(&assigned.id)
            .expect("internal detail")
            .target
            .expect("target");
        assert_eq!(detail.items[0].essay, target.essay_text);
        assert!(essays(
            &f.db,
            &f.session,
            &target.participant_id,
            &assigned.id,
            &query
        )
        .is_err());
        let service = StudentPeerReviewService::new(f.db.clone());
        let request = SubmitPeerReview {
            review_submission_id: new_id(),
            assignment_id: assigned.id.clone(),
            submitted_by_participant_id: reviewer.clone(),
            expected_base_revision: 0,
            body: "one".into(),
        };
        service
            .submit(&f.session, reviewer, request.clone())
            .expect("rev1");
        let mut second = request;
        second.review_submission_id = new_id();
        second.expected_base_revision = 1;
        second.body = "two".into();
        service.submit(&f.session, reviewer, second).expect("rev2");
        let received =
            feedback(&f.db, &f.session, &target.participant_id, &query).expect("received");
        assert_eq!(received.items.len(), 1);
        assert_eq!(received.items[0].revision, 2);
        let json = serde_json::to_string(&received).expect("json");
        assert!(!json.contains(reviewer));
        assert!(!json.contains("body"));
        assert_eq!(
            feedback_detail(&f.db, &f.session, &target.participant_id, &assigned.id)
                .expect("detail")
                .body,
            "two"
        );
        assert!(feedback_detail(&f.db, &f.session, reviewer, &assigned.id).is_err());
    }
    f.service.close_activity(&a.id).expect("close");
    assert_eq!(
        activities(&f.db, &f.session, &f.participants[0], &query)
            .expect("closed own relationship")
            .items
            .len(),
        1
    );
}

#[test]
fn cross_group_large_detail_pages_use_frozen_membership_and_shared_revision() {
    let f = Fixture::new(6);
    for i in 0..6 {
        f.essay(i, &"文".repeat(15000));
    }
    f.state("LOCKED");
    let (set, groups) = f.groups(1, &[vec![0, 1, 2], vec![3, 4, 5]]);
    let a = f.draft(PeerReviewMode::CrossGroup, None, Some(set));
    f.service.open_activity(&a.id).expect("open");
    let assigned = f
        .service
        .list_assignments(&a.id)
        .expect("assignments")
        .into_iter()
        .find(|a| a.reviewer_session_group_id.as_ref() == Some(&groups[0]))
        .expect("own");
    f.groups(2, &[vec![0, 3, 4], vec![1, 2, 5]]);
    let query = PageRequest {
        limit: Some(1),
        cursor: None,
    };
    let first = essays(&f.db, &f.session, &f.participants[1], &assigned.id, &query)
        .expect("old member still authorized");
    let mut next = first.next_cursor;
    let mut bytes = first.items[0].essay.len();
    let mut count = 1;
    while next.is_some() {
        let page = essays(
            &f.db,
            &f.session,
            &f.participants[1],
            &assigned.id,
            &PageRequest {
                limit: Some(1),
                cursor: next,
            },
        )
        .expect("page");
        bytes += page.items.iter().map(|i| i.essay.len()).sum::<usize>();
        count += page.items.len();
        next = page.next_cursor;
    }
    assert_eq!(count, 3);
    assert!(bytes > 65536);
    let cards = activities(
        &f.db,
        &f.session,
        &f.participants[1],
        &PageRequest::default(),
    )
    .expect("frozen metadata");
    let card = cards
        .items
        .iter()
        .find(|item| item.activity_id == a.id)
        .expect("own card");
    assert_eq!(card.reviewer_group_label.as_deref(), Some("Group 0"));
    assert_eq!(card.target_group_label.as_deref(), Some("Group 1"));
    assert!(essays(&f.db, &f.session, &f.participants[3], &assigned.id, &query).is_err());
    let service = StudentPeerReviewService::new(f.db.clone());
    service
        .submit(
            &f.session,
            &f.participants[0],
            f.request(&assigned.id, 0, 0, "one"),
        )
        .expect("rev1");
    assert!(matches!(
        service.submit(
            &f.session,
            &f.participants[1],
            f.request(&assigned.id, 1, 0, "stale")
        ),
        Err(PeerReviewError::ReviewRevisionConflict)
    ));
    service
        .submit(
            &f.session,
            &f.participants[1],
            f.request(&assigned.id, 1, 1, "two"),
        )
        .expect("shared rev2");
    assert_eq!(
        feedback_detail(&f.db, &f.session, &f.participants[3], &assigned.id)
            .expect("frozen recipient")
            .revision,
        2
    );
    let recipient = activity_metadata(&f.db, &f.session, &f.participants[3], &a.id)
        .expect("target group count");
    assert_eq!(recipient.items[0].received_feedback_count, 1);
    let serialized = serde_json::to_string(
        &feedback_scoped(
            &f.db,
            &f.session,
            &f.participants[3],
            &PageRequest::default(),
            Some(&a.id),
        )
        .expect("feedback page"),
    )
    .expect("json");
    assert!(!serialized.contains("Group"));
    assert!(!serialized.contains("reviewer"));
}

#[test]
fn activity_keysets_return_every_visible_activity_not_drafts() {
    let f = Fixture::new(2);
    f.ready();
    for _ in 0..57 {
        let a = f.draft(PeerReviewMode::RandomOneToOne, None, None);
        f.service.open_activity(&a.id).expect("open");
    }
    f.draft(PeerReviewMode::RandomOneToOne, None, None);
    let mut cursor = None;
    let mut ids = std::collections::HashSet::new();
    loop {
        let result = activities(
            &f.db,
            &f.session,
            &f.participants[0],
            &PageRequest {
                limit: Some(7),
                cursor,
            },
        )
        .expect("page");
        assert!(result.items.len() <= 7);
        for item in result.items {
            assert!(ids.insert(item.activity_id));
        }
        cursor = result.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(ids.len(), 57);
    assert_eq!(
        projection(&f.db, &f.session, &f.participants[0])
            .expect("projection")
            .visible_activity_count,
        57
    );
}
