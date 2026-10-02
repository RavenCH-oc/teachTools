use super::*;
use crate::application::grouping::GroupingService;
use crate::application::{LiveQuizService, LocalServerService, StudentAssetLocation};
use crate::infrastructure::persistence::database::Database;
use crate::infrastructure::persistence::repositories::{
    ClassroomRepository, NewClassroom, NewStudent, StudentRepository,
};
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

fn fixture() -> (
    RemoteParticipants,
    Arc<LocalSessionService>,
    tempfile::TempDir,
) {
    let directory = tempfile::tempdir().expect("temporary application data");
    let database = Database::open_in_app_data(directory.path()).expect("database");
    database.initialize().expect("migrations");
    let classroom = ClassroomRepository::create(
        &database,
        NewClassroom {
            name: "Remote test".to_owned(),
            academic_year: None,
        },
    )
    .expect("classroom");
    StudentRepository::create(
        &database,
        NewStudent {
            class_id: classroom.id.clone(),
            seat_number: 12,
            name: "王小明".to_owned(),
        },
    )
    .expect("roster");
    let quiz = LiveQuizService::initialize(database.clone(), directory.path()).expect("quiz");
    let grouping = GroupingService::initialize(database.clone());
    let sessions = LocalSessionService::initialize(database).expect("sessions");
    let server = LocalServerService::new(
        Arc::clone(&sessions),
        quiz,
        grouping,
        StudentAssetLocation::from_root(directory.path()),
    );
    let remote_id = "a".repeat(32);
    let local = sessions
        .create(classroom.id, format!("remote:{remote_id}"))
        .expect("session");
    sessions
        .open_lobby(local.id.clone(), local.server_instance_id)
        .expect("lobby");
    let adapter = RemoteParticipants::new(
        Arc::clone(&sessions),
        server.participant_realtime(),
        local.id,
        &remote_id,
    );
    (adapter, sessions, directory)
}

async fn join(adapter: &mut RemoteParticipants, attempt: Uuid, seat: i64, name: &str) -> Value {
    let message = json!({"v":1,"type":"CONTROL","id":Uuid::now_v7(),"payload":{
        "op":"join","generation":1,"joinAttemptId":attempt,"seatNumber":seat,"name":name}});
    adapter
        .handle(&message.to_string(), 1)
        .await
        .expect("join routing")
        .remove(0)
}

#[tokio::test]
async fn lost_join_response_recovers_exact_result_without_duplicate_participant() {
    let (mut adapter, sessions, _directory) = fixture();
    let attempt = Uuid::now_v7();
    let first = join(&mut adapter, attempt, 12, "王小明").await;
    let original = &first["payload"]["result"];
    assert_eq!(original["participant"]["participant"]["seatNumber"], 12);
    assert_eq!(
        original["participant"]["credential"].as_str().map(str::len),
        Some(43)
    );
    let retry = join(&mut adapter, attempt, 12, "王小明").await;
    assert!(&retry["payload"]["result"] == original);
    let local = sessions.active().expect("active").expect("session");
    assert_eq!(
        sessions
            .list_participants(&local.id)
            .expect("participants")
            .len(),
        1
    );
    sessions
        .start(local.id.clone(), local.server_instance_id)
        .expect("start");
    assert!(&join(&mut adapter, attempt, 12, "王小明").await["payload"]["result"] == original);
    sessions.end(local.id, "test").expect("end");
    assert_eq!(
        join(&mut adapter, attempt, 12, "王小明").await["payload"]["error"]["code"],
        "SESSION_NOT_OPEN"
    );
}

#[tokio::test]
async fn invalid_roster_and_changed_logical_attempt_are_rejected() {
    let (mut adapter, sessions, _directory) = fixture();
    let attempt = Uuid::now_v7();
    assert_eq!(
        join(&mut adapter, attempt, 12, "wrong").await["payload"]["error"]["code"],
        "IDENTITY_MISMATCH"
    );
    assert_eq!(
        join(&mut adapter, attempt, 12, "王小明").await["payload"]["error"]["code"],
        "JOIN_ATTEMPT_CONFLICT"
    );
    let good = Uuid::now_v7();
    join(&mut adapter, good, 12, "王小明").await;
    assert_eq!(
        join(&mut adapter, good, 13, "王小明").await["payload"]["error"]["code"],
        "JOIN_ATTEMPT_CONFLICT"
    );
    assert_eq!(
        sessions
            .list_participants(&sessions.active().expect("active").expect("session").id)
            .expect("participants")
            .len(),
        1
    );
}

#[tokio::test]
async fn auth_is_rust_scoped_and_generation_reauth_restores_personalized_sync() {
    let (mut adapter, _sessions, _directory) = fixture();
    let joined = join(&mut adapter, Uuid::now_v7(), 12, "王小明").await;
    let participant = &joined["payload"]["result"]["participant"];
    let connection_id = Uuid::now_v7();
    let auth_message = json!({"protocolVersion":1,"type":"participant_auth","requestId":"auth",
        "sessionId":participant["sessionId"],"participantId":participant["participantId"],"credential":participant["credential"]});
    let mut auth = json!({"v":1,"type":"AUTH","id":Uuid::now_v7(),"payload":{
        "connectionId":connection_id,"generation":1,"message":auth_message}});
    let mut wrong = auth.clone();
    wrong["payload"]["message"]["credential"] = json!("x".repeat(43));
    assert_eq!(
        adapter
            .handle(&wrong.to_string(), 1)
            .await
            .expect("rejected")[0]["payload"]["accepted"],
        false
    );
    wrong["payload"]["message"]["sessionId"] = json!(Uuid::now_v7());
    assert_eq!(
        adapter
            .handle(&wrong.to_string(), 1)
            .await
            .expect("cross session rejected")[0]["payload"]["accepted"],
        false
    );
    let accepted = adapter.handle(&auth.to_string(), 1).await.expect("auth");
    assert_eq!(accepted[0]["payload"]["accepted"], true);
    assert_eq!(accepted[1]["payload"]["message"]["type"], "session_sync");
    assert!(!accepted[1]
        .to_string()
        .contains(participant["credential"].as_str().expect("credential")));
    adapter.disconnect_all();
    let mutation = json!({"v":1,"type":"REALTIME","id":Uuid::now_v7(),"payload":{
        "connectionId":connection_id,"generation":2,"message":{"protocolVersion":1,"type":"ping","requestId":"ping"}}});
    assert!(adapter.handle(&mutation.to_string(), 2).await.is_err());
    assert!(adapter.handle(&auth.to_string(), 2).await.is_err());
    auth["payload"]["generation"] = json!(2);
    let restored = adapter
        .handle(&auth.to_string(), 2)
        .await
        .expect("fresh Rust validation");
    assert_eq!(restored[1]["payload"]["message"]["type"], "session_sync");
    assert_eq!(
        adapter
            .handle(&mutation.to_string(), 2)
            .await
            .expect("presence ping")[0]["payload"]["message"]["type"],
        "pong"
    );
}

#[tokio::test]
async fn transport_rejects_malformed_oversize_and_unsupported_protocol_before_domain() {
    let (mut adapter, sessions, _directory) = fixture();
    assert!(adapter.handle("{", 1).await.is_err());
    assert!(adapter.handle(&"x".repeat(64 * 1024 + 1), 1).await.is_err());
    assert!(adapter
        .handle(
            &json!({"v":2,"id":Uuid::now_v7(),"type":"CONTROL","payload":{"op":"join"}})
                .to_string(),
            1
        )
        .await
        .is_err());
    assert!(sessions
        .list_participants(&sessions.active().expect("active").expect("session").id)
        .expect("participants")
        .is_empty());
}

#[tokio::test]
async fn malformed_domain_message_is_scoped_without_dropping_teacher_transport() {
    let (mut adapter, _sessions, _directory) = fixture();
    let joined = join(&mut adapter, Uuid::now_v7(), 12, "王小明").await;
    let participant = &joined["payload"]["result"]["participant"];
    let connection_id = Uuid::now_v7();
    let auth = json!({"v":1,"type":"AUTH","id":Uuid::now_v7(),"payload":{
        "connectionId":connection_id,"generation":1,"message":{
            "protocolVersion":1,"type":"participant_auth","requestId":"auth",
            "sessionId":participant["sessionId"],"participantId":participant["participantId"],
            "credential":participant["credential"]}}});
    adapter.handle(&auth.to_string(), 1).await.expect("auth");
    let mut frame = json!({"v":1,"type":"REALTIME","id":Uuid::now_v7(),"payload":{
        "connectionId":connection_id,"generation":1,"message":{
            "protocolVersion":1,"type":"submit_answer"}}});
    let rejected = adapter
        .handle(&frame.to_string(), 1)
        .await
        .expect("scoped rejection");
    assert_eq!(rejected.len(), 1);
    assert_eq!(
        rejected[0]["payload"]["connectionId"],
        connection_id.to_string()
    );
    assert_eq!(rejected[0]["payload"]["message"]["code"], "PROTOCOL_ERROR");
    assert_eq!(adapter.connections.len(), 1);
    frame["payload"]["message"] =
        json!({"protocolVersion":1,"type":"ping","requestId":"after-rejection"});
    assert_eq!(
        adapter
            .handle(&frame.to_string(), 1)
            .await
            .expect("transport remains live")[0]["payload"]["message"]["type"],
        "pong"
    );
}

#[tokio::test]
async fn recovery_is_bounded_and_expiry_does_not_create_duplicate_participants() {
    let (mut adapter, sessions, _directory) = fixture();
    for _ in 0..MAX_JOIN_ATTEMPTS {
        join(&mut adapter, Uuid::now_v7(), 99, "invalid").await;
    }
    let attempt = Uuid::now_v7();
    assert_eq!(
        join(&mut adapter, attempt, 12, "王小明").await["payload"]["error"]["code"],
        "REMOTE_SERVICE_UNAVAILABLE"
    );
    assert_eq!(adapter.joins.len(), MAX_JOIN_ATTEMPTS);
    for cached in adapter.joins.values_mut() {
        cached.expires = Instant::now() - Duration::from_secs(1);
    }
    assert!(join(&mut adapter, attempt, 12, "王小明").await["payload"]["result"].is_object());
    adapter
        .joins
        .get_mut(&attempt)
        .expect("recovery entry")
        .expires = Instant::now() - Duration::from_secs(1);
    assert_eq!(
        join(&mut adapter, attempt, 12, "王小明").await["payload"]["error"]["code"],
        "SEAT_ALREADY_JOINED"
    );
    assert_eq!(
        sessions
            .list_participants(&sessions.active().expect("active").expect("session").id)
            .expect("participants")
            .len(),
        1
    );
}

#[tokio::test]
async fn same_connection_hibernation_reauth_revalidates_with_rust() {
    let (mut adapter, _sessions, _directory) = fixture();
    let joined = join(&mut adapter, Uuid::now_v7(), 12, "王小明").await;
    let participant = &joined["payload"]["result"]["participant"];
    let auth = json!({"v":1,"type":"AUTH","id":Uuid::now_v7(),"payload":{
        "connectionId":Uuid::now_v7(),"generation":1,"message":{"protocolVersion":1,
            "type":"participant_auth","requestId":"auth","sessionId":participant["sessionId"],
            "participantId":participant["participantId"],"credential":participant["credential"]}}});
    assert_eq!(
        adapter
            .handle(&auth.to_string(), 1)
            .await
            .expect("initial AUTH")[0]["payload"]["accepted"],
        true
    );
    assert_eq!(
        adapter
            .handle(&auth.to_string(), 1)
            .await
            .expect("hibernation AUTH")[0]["payload"]["accepted"],
        true
    );
    let mut invalid = auth;
    invalid["payload"]["message"]["credential"] = json!("x".repeat(43));
    assert_eq!(
        adapter
            .handle(&invalid.to_string(), 1)
            .await
            .expect("invalid AUTH")[0]["payload"]["accepted"],
        false
    );
    assert!(adapter.connections.is_empty());
}
