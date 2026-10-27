//! Explicit opt-in synthetic Remote HTTP smoke/benchmark; never touches classroom data.
use super::*;
use crate::application::{ImportQuestionAssetRequest, LiveQuizService, PersistenceService};
use crate::infrastructure::persistence::repositories::peer_review::PeerReviewRepository;
use crate::infrastructure::persistence::{database::Database, repositories::*};
use crate::peer_review_domain::{CreatePeerReviewActivity, PeerReviewMode};
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
struct ClientProcess(std::process::Child);
impl Drop for ClientProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl std::ops::Deref for ClientProcess {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for ClientProcess {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
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
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "Bounded local-only Phase16F capacity; isolated synthetic data"]
async fn remote_capacity_local_pass_a() {
    let base =
        reqwest::Url::parse(&std::env::var("CLASSROOM_REMOTE_BASE_URL").expect("local relay URL"))
            .expect("URL");
    assert!(
        base.scheme() == "http" && matches!(base.host_str(), Some("127.0.0.1" | "localhost")),
        "Pass A prohibits production targets"
    );
    assert!(
        std::env::var("CLASSROOM_TEST_ACTIVATION_CODE").is_err(),
        "Pass A only local operator enrollment"
    );
    let students = std::env::var("CLASSROOM_CAPACITY_STUDENTS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(40);
    assert!((1..=40).contains(&students));
    super::super::remote_capacity_metrics::enable();
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
    for seat in 1..=students {
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
            question_type: "true_false".to_owned(),
            prompt: "Synthetic essay".to_owned(),
            points: 1,
            position: 0,
            answer_config: serde_json::json!({"correctAnswer":true}),
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
    assert_eq!(
        service.base_url().expect("effective local URL"),
        &base,
        "Effective native target must match verified loopback URL"
    );
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

    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let script = root.join("apps/relay/scripts/capacity-local.js");
    let mut child = ClientProcess(
        std::process::Command::new("node")
            .arg(script)
            .current_dir(&root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .expect("local Node client harness"),
    );
    let mut input = child.stdin.take().expect("client stdin");
    let output = child.stdout.take().expect("client stdout");
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(64);
    tokio::task::spawn_blocking(move || {
        use std::io::BufRead;
        for line in std::io::BufReader::new(output).lines() {
            match line {
                Ok(line) => {
                    if tx.blocking_send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    let config = serde_json::json!({"origin":base.as_str(),"remoteSessionId":created.remote_session_id,
        "sessionId":created.local_session_id,"students":students,
        "mode":std::env::var("CLASSROOM_CAPACITY_MODE").unwrap_or_else(|_|"full".to_owned()),
        "soakSeconds":std::env::var("CLASSROOM_CAPACITY_SOAK_SECONDS").ok().and_then(|v|v.parse::<u64>().ok()).unwrap_or(600).min(600),
        "imageHash":format!("{:x}",Sha256::digest(std::fs::read(Path::new(&media_dir).join("image.png")).expect("synthetic image"))),
        "pdfHash":file_hash(&Path::new(&media_dir).join("document.pdf")).iter().map(|b|format!("{b:02x}")).collect::<String>(),
        "clientModule":root.join(if std::env::var("CLASSROOM_CAPACITY_BASELINE").as_deref()==Ok("1") {"apps/teacher/src-tauri/target/phase16f-client/student-http-baseline.mjs"}else{"apps/teacher/src-tauri/target/phase16f-client/student-http-client.mjs"}),
        "outputPath":std::env::var("CLASSROOM_CAPACITY_OUTPUT").expect("ignored report output")});
    use std::io::Write;
    writeln!(input, "{config}").expect("client configuration");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1800);
    let mut question = None;
    let mut done = false;
    loop {
        tokio::select! {
            line=rx.recv()=>{
                let Some(line)=line else{break};
                let value:serde_json::Value=serde_json::from_str(&line).expect("bounded client metrics JSON");
                if let Some(control)=value["control"].as_str(){
                    let result=match control {
                        "start"=>{
                            service.start_session(created.local_session_id.clone()).expect("start synthetic class");
                            let essay=QuestionRepository::create(&db,NewQuestion{
                                question_set_id:source.question_set_id.clone(),question_type:"essay".to_owned(),
                                prompt:"Synthetic frozen essay".to_owned(),points:1,position:1,
                                answer_config:serde_json::json!({}),grading_config:serde_json::json!({}),metadata:serde_json::json!({})
                            }).expect("essay fixture");
                            let essay=quiz.publish(created.local_session_id.clone(),essay.id).expect("essay snapshot");
                            quiz.open(essay.id.clone()).expect("essay open");
                            for id in value["participantIds"].as_array().expect("synthetic participants"){
                                quiz.submit(id.as_str().expect("UUID").to_owned(),created.local_session_id.clone(),essay.id.clone(),
                                    Uuid::now_v7().to_string(),StudentAnswer::Essay{text:"Synthetic text".to_owned()}).expect("fixture essay");
                            }
                            quiz.lock(essay.id.clone()).expect("essay lock");
                            let activity=PeerReviewRepository::create(&db,CreatePeerReviewActivity{
                                session_id:created.local_session_id.clone(),session_question_id:essay.id.clone(),
                                mode:PeerReviewMode::StudentSelect,session_group_set_id:None,max_reviews_per_target:Some(3)
                            }).expect("peer review fixture");
                            PeerReviewRepository::open_for_teacher(&db,&activity.id).expect("peer review open");
                            quiz.reveal(essay.id.clone()).expect("release active question slot");
                            let published=quiz.publish(created.local_session_id.clone(),source.id.clone()).expect("quiz snapshot");
                            quiz.open(published.id.clone()).expect("quiz open");
                            question=Some(published.id.clone());
                            serde_json::json!({"questionId":published.id,"activityId":activity.id,
                                "imageId":published.assets.iter().find(|a|a.display_name=="image.png").expect("image").id,
                                "pdfId":published.assets.iter().find(|a|a.display_name=="document.pdf").expect("pdf").id})
                        },
                        "metrics"=>super::super::remote_capacity_metrics::snapshot(),
                        "presence"=>{
                            let participants=sessions.list_participants(&created.local_session_id).expect("synthetic presence");
                            serde_json::json!({"online":participants.iter().filter(|p|server.is_participant_online(&p.participant_id)).count(),"total":participants.len(),"generation":service.status().expect("status").and_then(|s|s.generation)})
                        },
                        "lock"=>{quiz.lock(question.clone().expect("question")).expect("lock");serde_json::json!({"done":true})},
                        "reveal"=>{quiz.reveal(question.clone().expect("question")).expect("reveal");serde_json::json!({"done":true})},
                        "progress"=>serde_json::to_value(quiz.teacher_progress(question.clone().expect("question"),students as usize).expect("authoritative progress")).expect("metrics"),
                        "lock_reveal"=>{
                            quiz.lock(question.clone().expect("question")).expect("lock");
                            quiz.reveal(question.clone().expect("question")).expect("reveal");
                            serde_json::json!({"done":true})
                        },
                        "reconnect"=>{
                            let previous=service.status().expect("status").expect("active").generation.expect("generation");
                            let (mut replacement,_)=connect_once(service.client().expect("client"),service.base_url().expect("base"),&created.remote_session_id).await.expect("synthetic generation");
                            let _=replacement.close(None).await;
                            wait_open(&service,previous).await;
                            serde_json::json!({"done":true})
                        },
                        _=>panic!("unknown harness control"),
                    };
                    writeln!(input,"{}",serde_json::json!({"controlId":value["controlId"],"result":result})).expect("control reply");
                }else{
                    if value["done"].as_bool()==Some(true){done=true;}
                    println!("CAPACITY {}",value);
                }
            },
            _=sleep(Duration::from_secs(1))=>{
                if tokio::time::Instant::now()>=deadline || super::super::remote_capacity_metrics::stopped(){
                    let _=child.kill();break;
                }
            }
        }
    }
    let status = child.wait().expect("client exit");
    service
        .close_session()
        .await
        .expect("close isolated remote class");
    println!(
        "NATIVE_FINAL {}",
        super::super::remote_capacity_metrics::snapshot()
    );
    assert!(done && status.success(), "bounded capacity client failed");
}
