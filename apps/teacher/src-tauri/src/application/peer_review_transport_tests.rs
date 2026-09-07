use super::*;
use crate::infrastructure::persistence::{
    database::Database, repositories::peer_review::PeerReviewRepository,
};
use crate::peer_review_domain::{CreatePeerReviewActivity, PeerReviewMode};

#[tokio::test]
async fn peer_review_authenticated_http_and_lost_ack_closed_replay() {
    for review_id in [
        "c51a6f25-69d6-4e48-907a-12cce665913d".to_owned(),
        Uuid::now_v7().to_string(),
    ] {
        let dir = tempfile::tempdir().expect("fixture");
        std::fs::create_dir(dir.path().join("student")).expect("assets");
        std::fs::write(dir.path().join("student/index.html"), "student").expect("index");
        let db = Database::open(dir.path().join("classroom.sqlite3"));
        db.initialize().expect("schema");
        let class = Uuid::now_v7().to_string();
        let c = db.connection().expect("connection");
        c.execute(
            "INSERT INTO classes(id,name,created_at,updated_at) VALUES(?1,'Class','now','now')",
            [&class],
        )
        .expect("class");
        for seat in 1..=2 {
            c.execute("INSERT INTO students(id,class_id,seat_number,name,created_at,updated_at) VALUES(?1,?2,?3,'Student','now','now')",rusqlite::params![Uuid::now_v7().to_string(),class,seat]).expect("student");
        }
        drop(c);
        let sessions = LocalSessionService::initialize(db.clone()).expect("sessions");
        let quiz = LiveQuizService::initialize(db.clone(), dir.path()).expect("quiz");
        let server = LocalServerService::new(
            sessions,
            quiz,
            GroupingService::initialize(db.clone()),
            StudentAssetLocation::from_root(dir.path().join("student")),
        );
        let status = server
            .start_on(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), false)
            .await
            .expect("server");
        let port = status.port.expect("port");
        let instance = status.server_instance_id.expect("instance");
        let session = server
            .session
            .create(class, instance.clone())
            .expect("session");
        let lobby = server
            .session
            .open_lobby(session.id, instance.clone())
            .expect("lobby");
        let first = http_join(port, &lobby.join_code, 1, "Student").await;
        let second = http_join(port, &lobby.join_code, 2, "Student").await;
        server
            .session
            .start(lobby.id.clone(), instance)
            .expect("active");
        let question = Uuid::now_v7().to_string();
        let c = db.connection().expect("connection");
        c.execute("INSERT INTO session_questions(id,session_id,question_type,prompt,points,position,answer_config,grading_config,metadata,config_version,state,created_at,updated_at) VALUES(?1,?2,'essay','Explain',5,0,'{}','{}','{}',1,'OPEN','now','now')",rusqlite::params![question,lobby.id]).expect("question");
        drop(c);
        for p in [&first, &second] {
            server
                .quiz
                .submit(
                    p.participant_id.clone(),
                    lobby.id.clone(),
                    question.clone(),
                    Uuid::now_v7().to_string(),
                    StudentAnswer::Essay {
                        text: "Frozen essay".into(),
                    },
                )
                .expect("essay");
        }
        server.quiz.lock(question.clone()).expect("lock");
        let activity = PeerReviewRepository::create(
            &db,
            CreatePeerReviewActivity {
                session_id: lobby.id.clone(),
                session_question_id: question,
                mode: PeerReviewMode::StudentSelect,
                session_group_set_id: None,
                max_reviews_per_target: Some(3),
            },
        )
        .expect("draft");
        let (mut socket, initial) = authenticate_grouping_socket(port, &first).await;
        assert_eq!(initial["peerReview"]["visibleActivityCount"], 0);
        PeerReviewRepository::open_for_teacher(&db, &activity.id).expect("Teacher OPEN");
        server.session.peer_review.invalidate(&lobby.id);
        let changed = receive_until(&mut socket, "peer_review_changed").await;
        assert!(changed.len() < 100);
        let path = format!("/api/v1/peer-review/candidates/{}?limit=1", activity.id);
        assert!(http_get(port, &path).await.starts_with("http/1.1 401"));
        let response = peer_get(port, &path, &first).await;
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("no-store"));
        assert!(!response.contains("Frozen essay"));
        let body: serde_json::Value =
            serde_json::from_str(response.split_once("\r\n\r\n").expect("body").1).expect("json");
        let target = body["items"][0]["peerReviewTargetId"]
            .as_str()
            .expect("target");
        socket.send(ClientWebSocketMessage::Text(serde_json::json!({"protocolVersion":1,"type":"claim_peer_review","requestId":"claim","activityId":activity.id,"targetId":target}).to_string().into())).await.expect("claim");
        let ack = receive_until(&mut socket, "peer_review_acknowledged").await;
        let ack: serde_json::Value = serde_json::from_str(&ack).expect("ack");
        let assignment = ack["acknowledgement"]["assignmentId"]
            .as_str()
            .expect("assignment")
            .to_owned();
        assert!(peer_get(
            port,
            &format!("/api/v1/peer-review/essays/{assignment}"),
            &first
        )
        .await
        .contains("Frozen essay"));
        assert!(peer_get(
            port,
            &format!("/api/v1/peer-review/essays/{assignment}"),
            &second
        )
        .await
        .starts_with("HTTP/1.1 404"));
        let submit = serde_json::json!({"protocolVersion":1,"type":"submit_peer_review","requestId":"submit","reviewSubmissionId":review_id,"assignmentId":assignment,"expectedBaseRevision":0,"body":"Accepted feedback"});
        let mut committed = server.session.peer_review.subscribe();
        socket
            .send(ClientWebSocketMessage::Text(submit.to_string().into()))
            .await
            .expect("submit");
        tokio::time::timeout(Duration::from_secs(3), committed.recv())
            .await
            .expect("commit deadline")
            .expect("postcommit notification");
        // Discard the entire old connection without consuming its ACK. No production ACK hook.
        drop(socket);
        let (mut socket, sync) = authenticate_grouping_socket(port, &first).await;
        assert_eq!(sync["peerReview"]["visibleActivityCount"], 1);
        socket
            .send(ClientWebSocketMessage::Text(submit.to_string().into()))
            .await
            .expect("replay");
        let original = receive_until(&mut socket, "peer_review_acknowledged").await;
        PeerReviewRepository::finish(&db, &activity.id, false).expect("CLOSE");
        socket
            .send(ClientWebSocketMessage::Text(submit.to_string().into()))
            .await
            .expect("closed replay");
        assert_eq!(
            receive_until(&mut socket, "peer_review_acknowledged").await,
            original
        );
        let mut fresh = submit;
        fresh["reviewSubmissionId"] = serde_json::json!(Uuid::now_v7().to_string());
        fresh["expectedBaseRevision"] = serde_json::json!(1);
        socket
            .send(ClientWebSocketMessage::Text(fresh.to_string().into()))
            .await
            .expect("new ID closed");
        assert!(receive_until(&mut socket, "peer_review_rejected")
            .await
            .contains("PEER_REVIEW_CLOSED"));
        assert_eq!(
            PeerReviewRepository::responses(&db, &assignment)
                .expect("revisions")
                .len(),
            1
        );
        assert!(peer_get(
            port,
            &format!("/api/v1/peer-review/feedback/{assignment}"),
            &second
        )
        .await
        .contains("Accepted feedback"));
        socket.close(None).await.expect("close");
        server.session.end(lobby.id, "teacher_ended").expect("end");
        server.stop().await.expect("stop");
    }
}

async fn peer_get(port: u16, path: &str, p: &JoinResponse) -> String {
    http_raw_request(port,format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {}\r\nx-classroom-session: {}\r\nx-classroom-participant: {}\r\nConnection: close\r\n\r\n",p.credential,p.session_id,p.participant_id)).await
}
