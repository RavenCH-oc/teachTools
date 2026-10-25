//! Explicit opt-in synthetic Remote HTTP smoke/benchmark; never touches classroom data.
use super::*;
use crate::application::{ImportQuestionAssetRequest, LiveQuizService, PersistenceService};
use crate::infrastructure::persistence::repositories::peer_review::PeerReviewRepository;
use crate::infrastructure::persistence::{database::Database, repositories::*};
use crate::peer_review_domain::{CreatePeerReviewActivity, PeerReviewMode, SubmitPeerReview};
use crate::question_domain::StudentAnswer;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

#[cfg(windows)]
struct RestoreCredential {
    entry: keyring_core::Entry,
    previous: Option<String>,
}
#[cfg(windows)]
impl Drop for RestoreCredential {
    fn drop(&mut self) {
        if let Some(value) = &self.previous {
            let _ = self.entry.set_password(value);
        } else {
            let _ = self.entry.delete_credential();
        }
    }
}
fn file_hash(path: &Path) -> Vec<u8> {
    let mut file = std::fs::File::open(path).expect("synthetic file");
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let size = file.read(&mut buffer).expect("fixture read");
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    hash.finalize().to_vec()
}
fn read_request(
    client: &reqwest::Client,
    url: reqwest::Url,
    participant: &serde_json::Value,
) -> reqwest::RequestBuilder {
    client
        .get(url)
        .bearer_auth(participant["credential"].as_str().expect("credential"))
        .header(
            "x-classroom-session",
            participant["sessionId"].as_str().expect("session"),
        )
        .header(
            "x-classroom-participant",
            participant["participantId"].as_str().expect("participant"),
        )
}
async fn wait_open(service: &RemoteControlService, previous: u64) {
    timeout(Duration::from_secs(30), async {
        loop {
            if service.status().expect("status").is_some_and(|s| {
                matches!(s.state, RemoteConnectionState::Open)
                    && s.generation.is_some_and(|g| g > previous)
            }) {
                break;
            }
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("Teacher native reconnect");
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "Requires an explicitly configured relay and generated non-sensitive media"]
async fn remote_http_native_smoke_benchmark() {
    let _lock = super::tests::TEST_CREDENTIAL_LOCK.lock().await;
    let dir = tempfile::tempdir().expect("isolated app data");
    let db = Database::open_in_app_data(dir.path()).expect("database");
    db.initialize().expect("schema");
    let persistence = PersistenceService::initialize(dir.path()).expect("persistence");
    let classroom = ClassroomRepository::create(
        &db,
        NewClassroom {
            name: "Synthetic HTTP smoke".to_owned(),
            academic_year: None,
        },
    )
    .expect("class");
    for seat in 1..=2 {
        StudentRepository::create(
            &db,
            NewStudent {
                class_id: classroom.id.clone(),
                seat_number: seat,
                name: format!("Fixture {seat}"),
            },
        )
        .expect("roster");
    }
    let set = QuestionSetRepository::create(
        &db,
        NewQuestionSet {
            lesson_id: None,
            title: "Synthetic detail/media".to_owned(),
            description: None,
        },
    )
    .expect("set");
    let source = QuestionRepository::create(
        &db,
        NewQuestion {
            question_set_id: set.id,
            question_type: "essay".to_owned(),
            prompt: "Synthetic essay".to_owned(),
            points: 1,
            position: 0,
            answer_config: serde_json::json!({}),
            grading_config: serde_json::json!({}),
            metadata: serde_json::json!({}),
        },
    )
    .expect("question");
    let media_dir = std::env::var("CLASSROOM_TEST_MEDIA_DIR").expect("generated media directory");
    for name in ["image.png", "document.pdf"] {
        persistence
            .import_question_asset(ImportQuestionAssetRequest {
                question_id: source.id.clone(),
                source_path: Path::new(&media_dir)
                    .join(name)
                    .to_string_lossy()
                    .into_owned(),
            })
            .expect("validated synthetic import");
    }
    let quiz = LiveQuizService::initialize(db.clone(), dir.path()).expect("quiz");
    let sessions = LocalSessionService::initialize(db.clone()).expect("sessions");
    let server = crate::application::LocalServerService::new(
        sessions.clone(),
        quiz.clone(),
        crate::application::grouping::GroupingService::initialize(db.clone()),
        crate::application::StudentAssetLocation::from_root(dir.path()),
    );
    let service = RemoteControlService::initialize(sessions.clone(), server.participant_realtime());
    assert!(service.configured());
    let entry = credential_entry().expect("test Credential Manager");
    let previous = match entry.get_password() {
        Ok(v) => Some(v),
        Err(keyring_core::Error::NoEntry) => None,
        Err(_) => panic!("test credential unavailable"),
    };
    let _restore = RestoreCredential { entry, previous };
    let code = if let Ok(code) = std::env::var("CLASSROOM_TEST_ACTIVATION_CODE") {
        code
    } else {
        let operator = std::env::var("CLASSROOM_TEST_OPERATOR_TOKEN").expect("local operator");
        let response = service
            .client()
            .expect("client")
            .post(
                service
                    .endpoint("v1/operator/activation-codes")
                    .expect("operator endpoint"),
            )
            .bearer_auth(operator)
            .json(&serde_json::json!({}))
            .send()
            .await
            .expect("synthetic activation");
        assert_eq!(response.status(), 201);
        response
            .json::<serde_json::Value>()
            .await
            .expect("activation response")["activationCode"]
            .as_str()
            .expect("activation")
            .to_owned()
    };
    service.enroll(code).await.expect("synthetic enrollment");
    let created = service
        .create_session(classroom.id)
        .await
        .expect("Remote session");
    wait_open(&service, 0).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(650))
        .build()
        .expect("benchmark client");
    let mut participants = Vec::new();
    for seat in 1..=2 {
        let joined:serde_json::Value=client.post(service.endpoint(&format!("v1/sessions/{}/join",created.remote_session_id)).expect("join endpoint"))
            .json(&serde_json::json!({"remoteProtocolVersion":1,"joinAttemptId":Uuid::now_v7(),"seatNumber":seat,"name":format!("Fixture {seat}")}))
            .send().await.expect("join").error_for_status().expect("join accepted").json().await.expect("join result");
        participants.push(joined["participant"].clone());
    }
    service
        .start_session(created.local_session_id.clone())
        .expect("start");
    let published = quiz
        .publish(created.local_session_id.clone(), source.id)
        .expect("publish");
    quiz.open(published.id.clone()).expect("open");
    for (seat, p) in participants.iter().enumerate() {
        quiz.submit(
            p["participantId"].as_str().expect("participant").to_owned(),
            created.local_session_id.clone(),
            published.id.clone(),
            Uuid::now_v7().to_string(),
            StudentAnswer::Essay {
                text: format!("Frozen synthetic essay {}", seat + 1),
            },
        )
        .expect("essay");
    }
    quiz.lock(published.id.clone()).expect("lock");
    let activity = PeerReviewRepository::create(
        &db,
        CreatePeerReviewActivity {
            session_id: created.local_session_id.clone(),
            session_question_id: published.id.clone(),
            mode: PeerReviewMode::StudentSelect,
            session_group_set_id: None,
            max_reviews_per_target: Some(3),
        },
    )
    .expect("activity");
    PeerReviewRepository::open_for_teacher(&db, &activity.id).expect("open");
    let endpoint = |op: &str, query: &str| {
        service
            .endpoint(&format!(
                "v1/sessions/{}/http/{op}{query}",
                created.remote_session_id
            ))
            .expect("HTTP endpoint")
    };
    let p = &participants[0];
    let other = &participants[1];
    assert_eq!(
        client
            .get(endpoint("PEER_REVIEW_ACTIVITIES_LIST", ""))
            .send()
            .await
            .expect("unauthenticated")
            .status(),
        401
    );
    assert_eq!(
        read_request(&client, endpoint("NOT_ALLOWED", ""), p)
            .send()
            .await
            .expect("unknown")
            .status(),
        400
    );
    let unknown = client
        .get(service.endpoint("v1/unknown").expect("unknown"))
        .send()
        .await
        .expect("unknown API");
    assert_eq!(unknown.status(), 404);
    assert!(unknown
        .headers()
        .get("content-type")
        .expect("type")
        .to_str()
        .expect("type")
        .contains("json"));
    let activities: serde_json::Value = read_request(
        &client,
        endpoint("PEER_REVIEW_ACTIVITIES_LIST", "?limit=10"),
        p,
    )
    .send()
    .await
    .expect("activities")
    .error_for_status()
    .expect("activities accepted")
    .json()
    .await
    .expect("activities JSON");
    assert_eq!(activities["items"][0]["activityId"], activity.id);
    let metadata: serde_json::Value = read_request(
        &client,
        endpoint(
            "PEER_REVIEW_ACTIVITY_GET",
            &format!("?activityId={}", activity.id),
        ),
        p,
    )
    .send()
    .await
    .expect("metadata")
    .error_for_status()
    .expect("metadata accepted")
    .json()
    .await
    .expect("metadata JSON");
    assert_eq!(metadata["items"][0]["activityId"], activity.id);
    let candidates: serde_json::Value = read_request(
        &client,
        endpoint(
            "PEER_REVIEW_CANDIDATES_LIST",
            &format!("?activityId={}&limit=10", activity.id),
        ),
        p,
    )
    .send()
    .await
    .expect("candidates")
    .error_for_status()
    .expect("candidates accepted")
    .json()
    .await
    .expect("candidates JSON");
    let claim = sessions
        .peer_review
        .claim(
            &created.local_session_id,
            p["participantId"].as_str().expect("participant"),
            &activity.id,
            candidates["items"][0]["peerReviewTargetId"]
                .as_str()
                .expect("target"),
        )
        .expect("claim");
    let assignment = &claim.assignment_id;
    let essays: serde_json::Value = read_request(
        &client,
        endpoint(
            "PEER_REVIEW_ESSAYS_LIST",
            &format!("?assignmentId={assignment}&limit=5"),
        ),
        p,
    )
    .send()
    .await
    .expect("essays")
    .error_for_status()
    .expect("essay accepted")
    .json()
    .await
    .expect("essay JSON");
    assert_eq!(essays["items"][0]["essay"], "Frozen synthetic essay 2");
    assert_eq!(
        read_request(
            &client,
            endpoint(
                "PEER_REVIEW_ESSAYS_LIST",
                &format!("?assignmentId={assignment}")
            ),
            other
        )
        .send()
        .await
        .expect("denied essay")
        .status(),
        404
    );
    sessions
        .peer_review
        .submit(
            &created.local_session_id,
            p["participantId"].as_str().expect("participant"),
            SubmitPeerReview {
                assignment_id: assignment.clone(),
                review_submission_id: Uuid::now_v7().to_string(),
                expected_base_revision: 0,
                body: "Synthetic anonymous feedback".to_owned(),
                submitted_by_participant_id: p["participantId"]
                    .as_str()
                    .expect("participant")
                    .to_owned(),
            },
        )
        .expect("review");
    for (op, participant, query) in [
        (
            "PEER_REVIEW_OWN_REVIEW_GET",
            p,
            format!("?assignmentId={assignment}"),
        ),
        (
            "PEER_REVIEW_FEEDBACK_LIST",
            other,
            format!("?activityId={}", activity.id),
        ),
        (
            "PEER_REVIEW_FEEDBACK_GET",
            other,
            format!("?assignmentId={assignment}"),
        ),
    ] {
        let response = read_request(&client, endpoint(op, &query), participant)
            .send()
            .await
            .expect("feedback");
        assert_eq!(response.status(), 200);
        let value: serde_json::Value = response.json().await.expect("feedback JSON");
        assert!(!value.to_string().contains("credential"));
    }
    let mut wrong = p.clone();
    wrong["credential"] = serde_json::json!("A".repeat(43));
    assert_eq!(
        read_request(&client, endpoint("PEER_REVIEW_ACTIVITIES_LIST", ""), &wrong)
            .send()
            .await
            .expect("wrong credential")
            .status(),
        401
    );
    let mut wrong = p.clone();
    wrong["sessionId"] = serde_json::json!(Uuid::now_v7());
    assert_eq!(
        read_request(&client, endpoint("PEER_REVIEW_ACTIVITIES_LIST", ""), &wrong)
            .send()
            .await
            .expect("wrong Session")
            .status(),
        401
    );
    assert_eq!(
        read_request(
            &client,
            endpoint("SESSION_ASSET_GET", &format!("?assetId={}", Uuid::now_v7())),
            p
        )
        .send()
        .await
        .expect("unknown asset")
        .status(),
        404
    );
    println!("HTTP_DETAIL_SMOKE=PASS operations=7 auth_scope=PASS");
    for (name, mime) in [
        ("image.png", "image/png"),
        ("document.pdf", "application/pdf"),
    ] {
        let asset = published
            .assets
            .iter()
            .find(|a| a.display_name == name)
            .expect("snapshot asset");
        let source_path = Path::new(&media_dir).join(name);
        let expected = file_hash(&source_path);
        let size = std::fs::metadata(&source_path).expect("metadata").len();
        let start = std::time::Instant::now();
        let mut response = read_request(
            &client,
            endpoint("SESSION_ASSET_GET", &format!("?assetId={}", asset.id)),
            p,
        )
        .send()
        .await
        .expect("media request");
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["content-type"], mime);
        let mut bytes = 0u64;
        let mut hash = Sha256::new();
        while let Some(chunk) = response.chunk().await.expect("complete media stream") {
            bytes += chunk.len() as u64;
            hash.update(&chunk);
        }
        assert_eq!(bytes, size);
        assert_eq!(hash.finalize().to_vec(), expected);
        let seconds = start.elapsed().as_secs_f64();
        println!("HTTP_MEDIA_BENCHMARK kind={mime} bytes={bytes} seconds={seconds:.3} mib_per_second={:.3} exact_hash=PASS",bytes as f64/1048576.0/seconds);
    }
    let pdf = published
        .assets
        .iter()
        .find(|a| a.display_name == "document.pdf")
        .expect("PDF");
    let url = endpoint("SESSION_ASSET_GET", &format!("?assetId={}", pdf.id));
    let mut cancel = read_request(&client, url.clone(), p)
        .send()
        .await
        .expect("cancel start");
    assert_eq!(cancel.status(), 200);
    let prefix = cancel
        .chunk()
        .await
        .expect("prefix")
        .expect("prefix bytes")
        .len();
    drop(cancel);
    sleep(Duration::from_millis(500)).await;
    let mut replacement = read_request(&client, url.clone(), p)
        .send()
        .await
        .expect("after cancel");
    assert_eq!(replacement.status(), 200);
    replacement
        .chunk()
        .await
        .expect("replacement")
        .expect("replacement prefix");
    drop(replacement);
    println!("HTTP_CANCEL_SMOKE=PASS prefix_bytes={prefix} replacement_media=PASS");
    sleep(Duration::from_millis(500)).await;
    let mut inflight = read_request(&client, url, p)
        .send()
        .await
        .expect("generation start");
    assert_eq!(inflight.status(), 200);
    let first = inflight
        .chunk()
        .await
        .expect("first")
        .expect("first bytes")
        .len();
    let previous = service
        .status()
        .expect("status")
        .expect("active")
        .generation
        .expect("generation");
    let (mut displaced, _generation) = connect_once(
        service.client().expect("client"),
        service.base_url().expect("base"),
        &created.remote_session_id,
    )
    .await
    .expect("replace generation");
    let stopped = timeout(Duration::from_secs(15), async {
        let mut bytes = first;
        loop {
            match inflight.chunk().await {
                Ok(Some(chunk)) => bytes += chunk.len(),
                Err(_) => return bytes,
                Ok(None) => panic!("old generation completed silently"),
            }
        }
    })
    .await
    .expect("generation stream interruption");
    assert!(stopped < 100 * 1024 * 1024);
    let _ = displaced.close(None).await;
    wait_open(&service, previous).await;
    assert_eq!(
        read_request(&client, endpoint("PEER_REVIEW_ACTIVITIES_LIST", ""), p)
            .send()
            .await
            .expect("safe GET retry")
            .status(),
        200
    );
    println!("HTTP_GENERATION_SMOKE=PASS interrupted_bytes={stopped} safe_get_retry=PASS");
    service
        .close_session()
        .await
        .expect("close synthetic session");
}
