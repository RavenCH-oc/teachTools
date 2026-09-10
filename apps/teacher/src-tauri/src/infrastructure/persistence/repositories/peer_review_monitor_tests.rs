use super::super::monitor;
use super::*;
fn query() -> monitor::Query {
    monitor::Query::default()
}
#[test]
fn random_summary_history_and_grading_independence() {
    let f = Fixture::new(5);
    f.ready();
    let a = f.draft(PeerReviewMode::RandomOneToOne, None, None);
    f.service.open_activity(&a.id).expect("open");
    let assignments = f.service.list_assignments(&a.id).expect("assignments");
    for x in assignments.iter().take(3) {
        let p = f
            .participants
            .iter()
            .position(|p| Some(p) == x.reviewer_participant_id.as_ref())
            .expect("reviewer");
        for revision in 0..3 {
            f.service
                .submit_review_revision(f.request(&x.id, p, revision, &format!("body {revision}")))
                .expect("submit");
        }
    }
    let before = serde_json::to_value(
        StatisticsService::initialize(f.db.clone())
            .session_statistics(&f.session)
            .expect("snapshot"),
    )
    .expect("json");
    let s = monitor::get_summary(&f.db, &f.session, &a.id).expect("summary");
    assert_eq!(
        (s.eligible_reviewers, s.assignment_count, s.submitted_count),
        (5, 5, 3)
    );
    let statuses =
        monitor::statuses(&f.db, &f.session, &a.id, "reviewers", &query()).expect("statuses");
    assert_eq!(
        statuses
            .items
            .iter()
            .filter(|r| r.latest_revision == 3)
            .count(),
        3
    );
    let reviews =
        monitor::statuses(&f.db, &f.session, &a.id, "reviews", &query()).expect("reviews");
    assert_eq!(reviews.total, 3);
    let id = reviews.items[0].assignment_id.as_ref().expect("id");
    let latest = monitor::revisions(&f.db, &f.session, &a.id, id, &query(), true).expect("detail");
    assert_eq!(latest.items[0].revision, 3);
    let history =
        monitor::revisions(&f.db, &f.session, &a.id, id, &query(), false).expect("history");
    assert_eq!(
        history.items.iter().map(|r| r.revision).collect::<Vec<_>>(),
        vec![3, 2, 1]
    );
    assert!(history.items[0].submitted_by.contains("Student"));
    let after = serde_json::to_value(
        StatisticsService::initialize(f.db.clone())
            .session_statistics(&f.session)
            .expect("snapshot"),
    )
    .expect("json");
    assert_eq!(before, after);
    assert!(monitor::get_summary(&f.db, &new_id(), &a.id).is_err());
    assert!(monitor::revisions(&f.db, &f.session, &a.id, &new_id(), &query(), true).is_err());
    LocalSessionRepository::end(&f.db, &f.session, "teacher_ended").expect("end");
    let reopened = Database::open(f.dir.path().join("classroom.sqlite3"));
    reopened.initialize().expect("reopen");
    assert_eq!(
        monitor::get_summary(&reopened, &f.session, &a.id)
            .expect("historical")
            .submitted_count,
        3
    );
    assert_eq!(
        monitor::revisions(&reopened, &f.session, &a.id, id, &query(), false)
            .expect("history")
            .total,
        3
    );
}
#[test]
fn select_coverage_and_unselected_are_logical() {
    let f = Fixture::new(5);
    f.ready();
    let a = f.draft(PeerReviewMode::StudentSelect, Some(3), None);
    f.service.open_activity(&a.id).expect("open");
    for (i, target) in [4, 4, 0, 1].into_iter().enumerate() {
        let x = f
            .service
            .claim_target(&a.id, &f.participants[i], &f.target(&a.id, target).id)
            .expect("claim");
        if i != 1 {
            f.service
                .submit_review_revision(f.request(&x.id, i, 0, "first"))
                .expect("submit");
            f.service
                .submit_review_revision(f.request(&x.id, i, 1, "second"))
                .expect("submit");
        }
    }
    let s = monitor::get_summary(&f.db, &f.session, &a.id).expect("summary");
    assert_eq!(
        (
            s.eligible_reviewers,
            s.assignment_count,
            s.submitted_count,
            s.covered_count
        ),
        (5, 4, 3, 3)
    );
    let page = monitor::statuses(&f.db, &f.session, &a.id, "targets", &query()).expect("coverage");
    let t = page
        .items
        .iter()
        .find(|r| r.id == f.participants[4])
        .expect("target");
    assert_eq!(
        (
            t.claimed_count,
            t.submitted_count,
            t.capacity,
            t.remaining_capacity
        ),
        (2, 1, Some(3), Some(1))
    );
    assert_eq!(
        monitor::statuses(&f.db, &f.session, &a.id, "uncovered", &query())
            .expect("zero")
            .total,
        2
    );
    let rs = monitor::statuses(&f.db, &f.session, &a.id, "reviewers", &query()).expect("reviewers");
    assert_eq!(
        rs.items
            .iter()
            .filter(|r| r.assignment_id.is_none())
            .count(),
        1
    );
    assert_eq!(
        rs.items
            .iter()
            .filter(|r| r.assignment_id.is_some() && r.latest_revision == 0)
            .count(),
        1
    );
    let unlimited = f.draft(PeerReviewMode::StudentSelect, None, None);
    f.service.open_activity(&unlimited.id).expect("open");
    assert!(
        monitor::statuses(&f.db, &f.session, &unlimited.id, "targets", &query())
            .expect("unlimited")
            .items
            .iter()
            .all(|r| r.capacity.is_none() && r.remaining_capacity.is_none())
    );
}
#[test]
fn cross_group_uses_frozen_principals_not_essay_count() {
    let f = Fixture::new(6);
    f.ready();
    let (set, _) = f.groups(1, &[vec![0, 1], vec![2, 3], vec![4, 5]]);
    let a = f.draft(PeerReviewMode::CrossGroup, None, Some(set));
    f.service.open_activity(&a.id).expect("open");
    let rows = monitor::statuses(&f.db, &f.session, &a.id, "reviewers", &query()).expect("groups");
    for r in rows.items.iter().take(2) {
        let p:i64=f.db.connection().expect("db").query_row("SELECT p.seat_number FROM session_group_members m JOIN session_participants p ON p.id=m.participant_id WHERE m.group_id=?1 ORDER BY p.seat_number LIMIT 1",[&r.id],|r|r.get(0)).expect("member");
        f.service
            .submit_review_revision(f.request(
                r.assignment_id.as_ref().expect("id"),
                p as usize - 1,
                0,
                "shared",
            ))
            .expect("submit");
    }
    let s = monitor::get_summary(&f.db, &f.session, &a.id).expect("summary");
    assert_eq!(
        (
            s.eligible_reviewers,
            s.assignment_count,
            s.submitted_count,
            s.target_count
        ),
        (3, 3, 2, 3)
    );
    let (new_set, _) = f.groups(2, &[vec![0, 2, 4], vec![1, 3, 5]]);
    f.db.connection()
        .expect("db")
        .execute(
            "UPDATE session_groups SET name='New '||name WHERE group_set_id=?1",
            [new_set],
        )
        .expect("rename");
    assert!(
        monitor::statuses(&f.db, &f.session, &a.id, "reviewers", &query())
            .expect("frozen")
            .items
            .iter()
            .all(|r| r.label.starts_with("Group "))
    );
}
#[test]
fn all_monitor_collections_use_scoped_bounded_pages() {
    let f = Fixture::new(105);
    f.ready();
    let a = f.draft(PeerReviewMode::RandomOneToOne, None, None);
    f.service.open_activity(&a.id).expect("open");
    for x in f.service.list_assignments(&a.id).expect("assignments") {
        let p = f
            .participants
            .iter()
            .position(|p| Some(p) == x.reviewer_participant_id.as_ref())
            .expect("p");
        f.service
            .submit_review_revision(f.request(&x.id, p, 0, "review"))
            .expect("submit");
    }
    for kind in ["reviewers", "targets", "reviews"] {
        let mut q = monitor::Query {
            limit: Some(37),
            cursor: None,
        };
        let mut ids = std::collections::HashSet::new();
        loop {
            let page = monitor::statuses(&f.db, &f.session, &a.id, kind, &q).expect("page");
            assert!(page.items.len() <= 37);
            for row in page.items {
                assert!(ids.insert(row.id));
            }
            let Some(cursor) = page.next_cursor else {
                break;
            };
            q.cursor = Some(cursor);
        }
        assert_eq!(ids.len(), 105);
    }
    let first = monitor::statuses(
        &f.db,
        &f.session,
        &a.id,
        "reviewers",
        &monitor::Query {
            limit: Some(1),
            cursor: None,
        },
    )
    .expect("cursor");
    let q = monitor::Query {
        limit: Some(1),
        cursor: first.next_cursor,
    };
    assert!(monitor::statuses(&f.db, &f.session, &a.id, "targets", &q).is_err());
    let other = f.draft(PeerReviewMode::RandomOneToOne, None, None);
    f.service.open_activity(&other.id).expect("other");
    assert!(monitor::statuses(&f.db, &f.session, &other.id, "reviewers", &q).is_err());
    for q in [
        monitor::Query {
            limit: Some(101),
            cursor: None,
        },
        monitor::Query {
            limit: None,
            cursor: Some("zz".into()),
        },
    ] {
        assert!(monitor::statuses(&f.db, &f.session, &a.id, "reviewers", &q).is_err());
    }
}
