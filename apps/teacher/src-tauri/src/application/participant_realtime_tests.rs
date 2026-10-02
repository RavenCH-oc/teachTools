use super::super::grouping::{CreateDraftGroupRequest, CreateGroupingDraftRequest};
use super::super::local_session::JoinSuccess;
use super::super::peer_review_student::PageRequest;
use super::*;
use crate::infrastructure::persistence::{
    database::Database,
    repositories::{
        peer_review::PeerReviewRepository, NewQuestion, NewQuestionSet, QuestionRepository,
        QuestionSetRepository,
    },
};
use crate::peer_review_domain::{CreatePeerReviewActivity, PeerReviewMode};

struct Fixture {
    _directory: tempfile::TempDir,
    database: Database,
    realtime: ParticipantRealtimeService,
    server_instance_id: String,
    session_id: String,
    first: JoinSuccess,
    second: JoinSuccess,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().expect("fixture");
        let database = Database::open(directory.path().join("classroom.sqlite3"));
        database.initialize().expect("schema");
        let classroom_id = Uuid::now_v7().to_string();
        let connection = database.connection().expect("connection");
        connection
            .execute(
                "INSERT INTO classes(id,name,created_at,updated_at) VALUES(?1,'Test','now','now')",
                [&classroom_id],
            )
            .expect("classroom");
        for seat in 1..=2 {
            connection.execute(
                "INSERT INTO students(id,class_id,seat_number,name,created_at,updated_at) VALUES(?1,?2,?3,'Student','now','now')",
                rusqlite::params![Uuid::now_v7().to_string(), classroom_id, seat],
            ).expect("student");
        }
        drop(connection);
        let session = LocalSessionService::initialize(database.clone()).expect("sessions");
        let quiz = LiveQuizService::initialize(database.clone(), directory.path()).expect("quiz");
        let grouping = GroupingService::initialize(database.clone());
        let realtime = ParticipantRealtimeService::new(
            session.clone(),
            quiz,
            grouping,
            PresenceRegistry::default(),
        );
        let server_instance_id = format!("remote:{}", Uuid::now_v7());
        let created = session
            .create(classroom_id, server_instance_id.clone())
            .expect("session");
        let lobby = session
            .open_lobby(created.id, server_instance_id.clone())
            .expect("lobby");
        let first = session
            .join(&lobby.join_code, 1, "Student", &server_instance_id)
            .expect("first");
        let second = session
            .join(&lobby.join_code, 2, "Student", &server_instance_id)
            .expect("second");
        session
            .start(lobby.id.clone(), server_instance_id.clone())
            .expect("active");
        Self {
            _directory: directory,
            database,
            realtime,
            server_instance_id,
            session_id: lobby.id,
            first,
            second,
        }
    }

    fn auth_text(&self, joined: &JoinSuccess) -> serde_json::Value {
        serde_json::json!({
            "protocolVersion": 1, "type": "participant_auth", "requestId": "auth",
            "sessionId": self.session_id, "participantId": joined.participant_id,
            "credential": joined.credential,
        })
    }

    async fn authenticate(&self, joined: &JoinSuccess) -> ParticipantConnection {
        let result = self
            .realtime
            .authenticate(
                &self.server_instance_id,
                &self.auth_text(joined).to_string(),
                Uuid::now_v7(),
            )
            .await;
        let (participant, messages) =
            result.unwrap_or_else(|code| panic!("authentication: {code}"));
        assert!(matches!(
            messages.as_slice(),
            [ServerMessage::ParticipantAuthenticated { .. }]
        ));
        participant
    }

    fn question(&self, question_type: &str) -> String {
        let set = QuestionSetRepository::create(
            &self.database,
            NewQuestionSet {
                lesson_id: None,
                title: "Test".to_owned(),
                description: None,
            },
        )
        .expect("set");
        let source = QuestionRepository::create(
            &self.database,
            NewQuestion {
                question_set_id: set.id,
                question_type: question_type.to_owned(),
                prompt: "Question".to_owned(),
                points: 5,
                position: 0,
                answer_config: if question_type == "true_false" {
                    serde_json::json!({"correctAnswer":true})
                } else {
                    serde_json::json!({})
                },
                grading_config: serde_json::json!({}),
                metadata: serde_json::json!({}),
            },
        )
        .expect("source question");
        let snapshot = self
            .realtime
            .quiz
            .publish(self.session_id.clone(), source.id)
            .expect("publish");
        self.realtime.quiz.open(snapshot.id).expect("open").id
    }
}

fn json_messages(messages: Vec<ServerMessage>) -> Vec<serde_json::Value> {
    messages
        .into_iter()
        .map(|message| serde_json::to_value(message).expect("message JSON"))
        .collect()
}

async fn handle(
    fixture: &Fixture,
    participant: &ParticipantConnection,
    message: &serde_json::Value,
) -> serde_json::Value {
    json_messages(
        fixture
            .realtime
            .handle(participant, &message.to_string())
            .await
            .expect("valid message"),
    )
    .remove(0)
}

#[tokio::test]
async fn shared_remote_auth_requires_exact_participant_session_credential_and_version() {
    let fixture = Fixture::new();
    let mut invalid = fixture.auth_text(&fixture.first);
    invalid["participantId"] = serde_json::json!(fixture.second.participant_id);
    assert!(matches!(
        fixture
            .realtime
            .authenticate(
                &fixture.server_instance_id,
                &invalid.to_string(),
                Uuid::now_v7(),
            )
            .await,
        Err("AUTH_FAILED")
    ));
    invalid = fixture.auth_text(&fixture.first);
    invalid["sessionId"] = serde_json::json!(Uuid::now_v7().to_string());
    assert!(matches!(
        fixture
            .realtime
            .authenticate(
                &fixture.server_instance_id,
                &invalid.to_string(),
                Uuid::now_v7(),
            )
            .await,
        Err("AUTH_FAILED")
    ));
    invalid = fixture.auth_text(&fixture.first);
    invalid["protocolVersion"] = serde_json::json!(2);
    assert!(matches!(
        fixture
            .realtime
            .authenticate(
                &fixture.server_instance_id,
                &invalid.to_string(),
                Uuid::now_v7(),
            )
            .await,
        Err("PROTOCOL_ERROR")
    ));
    assert!(matches!(
        fixture
            .realtime
            .authenticate(&fixture.server_instance_id, "{invalid", Uuid::now_v7(),)
            .await,
        Err("PROTOCOL_ERROR")
    ));
    assert!(matches!(
        fixture
            .realtime
            .authenticate(
                &fixture.server_instance_id,
                &" ".repeat(MAX_PARTICIPANT_MESSAGE_BYTES + 1),
                Uuid::now_v7(),
            )
            .await,
        Err("PROTOCOL_ERROR")
    ));
    let participant = fixture.authenticate(&fixture.first).await;
    let sync = json_messages(
        fixture
            .realtime
            .sync_messages(&participant)
            .await
            .expect("sync"),
    );
    assert_eq!(sync[0]["sync"]["sessionState"], "ACTIVE");
    let serialized = sync[0].to_string();
    assert!(!serialized.contains(&fixture.first.credential));
    assert!(!serialized.contains(&fixture.second.participant_id));
    assert!(fixture
        .realtime
        .presence
        .is_online(&fixture.first.participant_id));
    fixture.realtime.disconnect(&participant);
    assert!(!fixture
        .realtime
        .presence
        .is_online(&fixture.first.participant_id));
}

#[tokio::test]
async fn shared_remote_quiz_keeps_ack_idempotency_write_guards_and_reveal_privacy() {
    let fixture = Fixture::new();
    let participant = fixture.authenticate(&fixture.first).await;
    let question = fixture.question("true_false");
    let open = json_messages(
        fixture
            .realtime
            .quiz_sync_messages(&participant)
            .await
            .expect("open sync"),
    );
    assert_eq!(open[0]["sync"]["currentQuestion"]["state"], "OPEN");
    let submit = serde_json::json!({
        "protocolVersion": 1, "type":"submit_answer", "requestId":"answer",
        "submissionId":Uuid::now_v7().to_string(), "sessionQuestionId":question,
        "answer":{"type":"true_false","value":true},
    });
    let ack = handle(&fixture, &participant, &submit).await;
    assert_eq!(ack["type"], "submission_acknowledged");
    assert_eq!(ack["acknowledgement"]["accepted"], true);
    assert_eq!(handle(&fixture, &participant, &submit).await, ack);
    assert_eq!(
        fixture
            .realtime
            .quiz
            .teacher_progress(question.clone(), 2)
            .expect("progress")
            .answered_count,
        1
    );

    let before = json_messages(
        fixture
            .realtime
            .quiz_sync_messages(&participant)
            .await
            .expect("private sync"),
    );
    assert!(before
        .iter()
        .all(|message| message["type"] != "submission_result"
            && message["type"] != "question_revealed"));
    assert!(before[0]["sync"]["ownLatestSubmission"]["isCorrect"].is_null());
    assert!(before[0]["sync"]["ownLatestSubmission"]["score"].is_null());
    fixture.realtime.disconnect(&participant);
    let restored = fixture.authenticate(&fixture.first).await;
    let sync = fixture
        .realtime
        .sync(&restored)
        .await
        .expect("reconnect state");
    assert_eq!(
        sync.own_latest_submission
            .expect("own answer")
            .submission_id,
        submit["submissionId"].as_str().expect("id")
    );

    fixture.realtime.quiz.lock(question.clone()).expect("lock");
    let mut fresh = submit.clone();
    fresh["submissionId"] = serde_json::json!(Uuid::now_v7().to_string());
    assert_eq!(
        handle(&fixture, &restored, &fresh).await["code"],
        "QUESTION_LOCKED"
    );
    fixture
        .realtime
        .quiz
        .reopen(question.clone())
        .expect("reopen");
    fixture
        .realtime
        .quiz
        .lock(question.clone())
        .expect("lock before reveal");
    fixture
        .realtime
        .quiz
        .reveal(question.clone())
        .expect("reveal");
    let after = json_messages(
        fixture
            .realtime
            .quiz_sync_messages(&restored)
            .await
            .expect("reveal sync"),
    );
    assert!(after
        .iter()
        .any(|message| message["type"] == "question_revealed"));
    let result = after
        .iter()
        .find(|message| message["type"] == "submission_result")
        .expect("revealed result");
    assert_eq!(result["result"]["isCorrect"], true);
    assert_eq!(result["result"]["score"], 5);
    fixture
        .realtime
        .session
        .end(fixture.session_id.clone(), "teacher_ended")
        .expect("end");
    // The repository's Phase 15 guard rejects even exact retry after ENDED.
    assert_ne!(
        handle(&fixture, &restored, &submit).await["type"],
        "submission_acknowledged"
    );
    assert_ne!(
        handle(&fixture, &restored, &fresh).await["type"],
        "submission_acknowledged"
    );
}

#[tokio::test]
async fn shared_remote_grouping_capacity_failed_move_and_reconnect_remain_authoritative() {
    let fixture = Fixture::new();
    let first = fixture.authenticate(&fixture.first).await;
    let second = fixture.authenticate(&fixture.second).await;
    let draft = fixture
        .realtime
        .grouping
        .create_draft(CreateGroupingDraftRequest {
            session_id: fixture.session_id.clone(),
            groups: vec![
                CreateDraftGroupRequest {
                    name: "A".to_owned(),
                    position: 0,
                    capacity: Some(1),
                },
                CreateDraftGroupRequest {
                    name: "B".to_owned(),
                    position: 1,
                    capacity: Some(1),
                },
            ],
        })
        .expect("draft");
    let mut subscriptions = fixture.realtime.subscribe();
    fixture
        .realtime
        .grouping
        .open_draft(&draft.id)
        .expect("open");
    assert_eq!(
        subscriptions
            .grouping
            .recv()
            .await
            .expect("invalidation")
            .session_id,
        fixture.session_id
    );
    let select = |group: &str| {
        serde_json::json!({
            "protocolVersion":1,"type":"select_group","requestId":"select",
            "draftId":draft.id,"groupId":group,
        })
    };
    let initial = fixture.realtime.sync(&first).await.expect("initial");
    assert!(initial.grouping.expect("grouping").selection_open);
    assert_eq!(
        handle(&fixture, &first, &select(&draft.groups[0].id)).await["type"],
        "group_selection_acknowledged"
    );
    assert_eq!(
        handle(&fixture, &second, &select(&draft.groups[1].id)).await["type"],
        "group_selection_acknowledged"
    );
    assert_eq!(
        handle(&fixture, &second, &select(&draft.groups[0].id)).await["code"],
        "GROUP_FULL"
    );
    assert_eq!(
        handle(&fixture, &first, &select(&Uuid::now_v7().to_string())).await["code"],
        "GROUP_NOT_FOUND"
    );
    let unchanged = fixture.realtime.sync(&second).await.expect("unchanged");
    assert_eq!(
        unchanged
            .grouping
            .expect("grouping")
            .current_group
            .expect("group")
            .name,
        "B"
    );
    fixture.realtime.disconnect(&first);
    let restored = fixture.authenticate(&fixture.first).await;
    assert_eq!(
        fixture
            .realtime
            .sync(&restored)
            .await
            .expect("reconnect")
            .grouping
            .expect("grouping")
            .current_group
            .expect("group")
            .name,
        "A"
    );
    fixture
        .realtime
        .grouping
        .move_participant(&draft.id, &fixture.first.participant_id, None)
        .expect("Teacher override");
    fixture
        .realtime
        .grouping
        .finalize_draft(&draft.id)
        .expect("freeze revision");
    assert!(fixture
        .realtime
        .sync(&restored)
        .await
        .expect("override")
        .grouping
        .expect("grouping")
        .current_group
        .is_none());
    assert_eq!(
        fixture
            .realtime
            .grouping
            .current_group_set(&fixture.session_id)
            .expect("set")
            .expect("revision")
            .revision,
        1
    );
}

#[tokio::test]
async fn shared_remote_peer_review_ack_retry_revision_conflict_and_reauth_keep_state() {
    let fixture = Fixture::new();
    let first = fixture.authenticate(&fixture.first).await;
    let second = fixture.authenticate(&fixture.second).await;
    let question = fixture.question("essay");
    for (participant, text) in [
        (&first, "First participant essay"),
        (&second, "Second participant essay"),
    ] {
        fixture
            .realtime
            .quiz
            .submit(
                participant.participant_id.clone(),
                fixture.session_id.clone(),
                question.clone(),
                Uuid::now_v7().to_string(),
                StudentAnswer::Essay {
                    text: text.to_owned(),
                },
            )
            .expect("essay");
    }
    fixture.realtime.quiz.lock(question.clone()).expect("lock");
    let activity = PeerReviewRepository::create(
        &fixture.database,
        CreatePeerReviewActivity {
            session_id: fixture.session_id.clone(),
            session_question_id: question,
            mode: PeerReviewMode::StudentSelect,
            session_group_set_id: None,
            max_reviews_per_target: Some(3),
        },
    )
    .expect("activity");
    let mut subscriptions = fixture.realtime.subscribe();
    PeerReviewRepository::open_for_teacher(&fixture.database, &activity.id).expect("open");
    fixture
        .realtime
        .session
        .peer_review
        .invalidate(&fixture.session_id);
    assert_eq!(
        subscriptions
            .peer_review
            .recv()
            .await
            .expect("invalidation"),
        fixture.session_id
    );
    let projection = fixture
        .realtime
        .sync(&first)
        .await
        .expect("sync")
        .peer_review
        .expect("projection");
    assert_eq!(projection.visible_activity_count, 1);
    let candidates = fixture
        .realtime
        .session
        .peer_review
        .candidates(
            &fixture.session_id,
            &fixture.first.participant_id,
            &activity.id,
            &PageRequest::default(),
        )
        .expect("fixture candidate");
    let target = &candidates.items[0].peer_review_target_id;
    let claim = handle(
        &fixture,
        &first,
        &serde_json::json!({
            "protocolVersion":1,"type":"claim_peer_review","requestId":"claim",
            "activityId":activity.id,"targetId":target,
        }),
    )
    .await;
    assert_eq!(claim["type"], "peer_review_acknowledged");
    let assignment = claim["acknowledgement"]["assignmentId"]
        .as_str()
        .expect("assignment");
    let submit = serde_json::json!({
        "protocolVersion":1,"type":"submit_peer_review","requestId":"submit",
        "reviewSubmissionId":Uuid::now_v7().to_string(),"assignmentId":assignment,
        "expectedBaseRevision":0,"body":"Bounded feedback",
    });
    let ack = handle(&fixture, &first, &submit).await;
    assert_eq!(ack["type"], "peer_review_acknowledged");
    assert_eq!(ack["acknowledgement"]["revision"], 1);
    assert_eq!(handle(&fixture, &first, &submit).await, ack);
    let mut stale = submit.clone();
    stale["reviewSubmissionId"] = serde_json::json!(Uuid::now_v7().to_string());
    let conflict = handle(&fixture, &first, &stale).await;
    assert_eq!(conflict["type"], "peer_review_rejected");
    assert_eq!(conflict["code"], "REVIEW_REVISION_CONFLICT");
    fixture.realtime.disconnect(&first);
    let reauthenticated = fixture.authenticate(&fixture.first).await;
    assert_eq!(handle(&fixture, &reauthenticated, &submit).await, ack);
    assert_eq!(
        PeerReviewRepository::responses(&fixture.database, assignment)
            .expect("reviews")
            .len(),
        1
    );
    assert_eq!(
        fixture
            .realtime
            .sync(&second)
            .await
            .expect("recipient sync")
            .peer_review
            .expect("summary")
            .received_feedback_count,
        1
    );
    let personalized = json_messages(
        fixture
            .realtime
            .sync_messages(&second)
            .await
            .expect("summary"),
    );
    assert!(!personalized[0].to_string().contains("Bounded feedback"));
    assert!(!personalized[0]
        .to_string()
        .contains("First participant essay"));
}
