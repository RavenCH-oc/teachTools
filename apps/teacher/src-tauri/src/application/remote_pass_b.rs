//! Opt-in test binary bridge for the bounded Pass B supervisor. No import/startup effects.
//! All product decisions use existing Rust services; only test orchestration lives here.
use super::*;
use crate::application::{ImportQuestionAssetRequest, LiveQuizService, PersistenceService};
use crate::infrastructure::persistence::{database::Database, repositories::*};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

const PRODUCTION: &str = "https://classroom-relay.ryanaddy1102.workers.dev/";
const LOOPBACK: &str = "http://127.0.0.1:8794/";
const PREFIX: &str = "Classroom.RemoteInstallation.Phase16FPassB.";
type BridgeResult<T> = Result<T, &'static str>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    run_id: String,
    mode: String,
    origin: String,
    students: u32,
    teachers: u32,
    classrooms: u32,
    run_directory: PathBuf,
    image_path: PathBuf,
    image_hash: String,
    client_module: PathBuf,
    client_hash: String,
    native_hash: String,
    remaining_ms: u64,
    cleanup_reserve_ms: u64,
}

fn target_for(run_id: &str) -> BridgeResult<String> {
    let id = Uuid::parse_str(run_id).map_err(|_| "RUN_ID_INVALID")?;
    if id.is_nil() || id.to_string() != run_id {
        return Err("RUN_ID_INVALID");
    }
    Ok(format!("{PREFIX}{id}"))
}

fn validate_bounds(config: &Config, effective: &str) -> BridgeResult<()> {
    target_for(&config.run_id)?;
    let target = match config.mode.as_str() {
        "production" => PRODUCTION,
        "loopback" => LOOPBACK,
        _ => return Err("MODE_INVALID"),
    };
    if config.origin != target || effective != target {
        return Err("EFFECTIVE_TARGET_MISMATCH");
    }
    if !(1..=30).contains(&config.students) || config.teachers != 1 || config.classrooms != 1 {
        return Err("PROFILE_INVALID");
    }
    if config.remaining_ms > 1_800_000
        || !(1000..=120_000).contains(&config.cleanup_reserve_ms)
        || config.remaining_ms <= config.cleanup_reserve_ms
    {
        return Err("DEADLINE_INVALID");
    }
    Ok(())
}

fn hash_file(path: &Path, expected: &str, ceiling: u64) -> BridgeResult<()> {
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("IDENTITY_INVALID");
    }
    let mut file = std::fs::File::open(path).map_err(|_| "IDENTITY_UNAVAILABLE")?;
    if file.metadata().map_err(|_| "IDENTITY_UNAVAILABLE")?.len() > ceiling {
        return Err("IDENTITY_SIZE_INVALID");
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65_536];
    loop {
        let size = file.read(&mut buffer).map_err(|_| "IDENTITY_UNAVAILABLE")?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    if format!("{:x}", hash.finalize()) != expected {
        return Err("IDENTITY_MISMATCH");
    }
    Ok(())
}

fn inside(path: &Path, directory: &Path) -> BridgeResult<PathBuf> {
    let canonical = path.canonicalize().map_err(|_| "PATH_UNAVAILABLE")?;
    if canonical == directory || !canonical.starts_with(directory) {
        return Err("PATH_ESCAPE");
    }
    Ok(canonical)
}

fn validate_files(config: &Config) -> BridgeResult<PathBuf> {
    let target = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/phase16f-pass-b")
        .canonicalize()
        .map_err(|_| "PATH_UNAVAILABLE")?;
    let run = inside(&config.run_directory, &target)?;
    if run != target.join(&config.run_id) {
        return Err("RUN_DIRECTORY_INVALID");
    }
    let image = inside(&config.image_path, &run)?;
    let module = inside(&config.client_module, &run)?;
    hash_file(&image, &config.image_hash, 2 * 1024 * 1024)?;
    hash_file(&module, &config.client_hash, 16 * 1024 * 1024)?;
    hash_file(
        &std::env::current_exe().map_err(|_| "NATIVE_IDENTITY_UNAVAILABLE")?,
        &config.native_hash,
        1024 * 1024 * 1024,
    )?;
    Ok(run)
}

fn emit(value: &Value) -> BridgeResult<()> {
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    // libtest may print its test-name prefix without a trailing newline.
    writeln!(output, "\nPASS_B {value}").map_err(|_| "PIPE_UNAVAILABLE")?;
    output.flush().map_err(|_| "PIPE_UNAVAILABLE")
}

#[derive(Default)]
struct Effects {
    installation: Option<String>,
    session: Option<String>,
}

pub(super) struct Context {
    target: String,
    effects: Mutex<Effects>,
    write_attempted: AtomicBool,
    emit_events: bool,
    active_connections: AtomicUsize,
}

pub(super) struct RuntimeGuard(Arc<Context>);
impl Drop for RuntimeGuard {
    fn drop(&mut self) {
        self.0.active_connections.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Context {
    fn new(run_id: &str, emit_events: bool) -> BridgeResult<Self> {
        Ok(Self {
            target: target_for(run_id)?,
            effects: Mutex::new(Effects::default()),
            write_attempted: AtomicBool::new(false),
            emit_events,
            active_connections: AtomicUsize::new(0),
        })
    }
    pub(super) fn runtime_guard(self: &Arc<Self>) -> RuntimeGuard {
        self.active_connections.fetch_add(1, Ordering::SeqCst);
        RuntimeGuard(self.clone())
    }
    fn entry(&self) -> Result<keyring_core::Entry, AppError> {
        keyring_core::Entry::new_with_modifiers(
            &self.target,
            CREDENTIAL_USER,
            &HashMap::from([("persistence", "Local")]),
        )
        .map_err(|_| AppError::RemoteCredentialStore)
    }
    fn require_absent(&self) -> BridgeResult<()> {
        match self
            .entry()
            .map_err(|_| "CREDENTIAL_UNAVAILABLE")?
            .get_password()
        {
            Err(keyring_core::Error::NoEntry) => Ok(()),
            Ok(_) => Err("CREDENTIAL_COLLISION"),
            Err(_) => Err("CREDENTIAL_UNAVAILABLE"),
        }
    }
    pub(super) fn read_installation(&self) -> Result<Option<InstallationCredential>, AppError> {
        match self.entry()?.get_password() {
            Ok(raw) => {
                let value: InstallationCredential =
                    serde_json::from_str(&raw).map_err(|_| AppError::RemoteCredentialStore)?;
                if !is_secret(&value.installation_credential)
                    || Uuid::parse_str(&value.installation_id).is_err()
                {
                    return Err(AppError::RemoteCredentialStore);
                }
                Ok(Some(value))
            }
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(_) => Err(AppError::RemoteCredentialStore),
        }
    }
    pub(super) fn write_installation(
        &self,
        installation: &InstallationCredential,
    ) -> Result<(), AppError> {
        self.require_absent()
            .map_err(|_| AppError::RemoteCredentialStore)?;
        let raw =
            serde_json::to_string(installation).map_err(|_| AppError::RemoteCredentialStore)?;
        self.write_attempted.store(true, Ordering::SeqCst);
        self.entry()?
            .set_password(&raw)
            .map_err(|_| AppError::RemoteCredentialStore)
    }
    pub(super) fn confirmed(&self, resource: &str, id: &str) -> Result<(), AppError> {
        {
            let mut effects = self
                .effects
                .lock()
                .map_err(|_| AppError::RemoteUnavailable)?;
            let slot = match resource {
                "installation" => &mut effects.installation,
                "session" => &mut effects.session,
                _ => return Err(AppError::RemoteProtocolMismatch),
            };
            if slot.is_some() {
                return Err(AppError::Conflict("duplicate effect".to_owned()));
            }
            *slot = Some(id.to_owned());
        }
        if self.emit_events {
            emit(&json!({"event":"effectConfirmed","resource":resource,"id":id}))
                .map_err(|_| AppError::RemoteUnavailable)?;
        }
        Ok(())
    }
    fn owned_session(&self, id: &str) -> BridgeResult<()> {
        if self
            .effects
            .lock()
            .map_err(|_| "STATE_UNAVAILABLE")?
            .session
            .as_deref()
            != Some(id)
        {
            return Err("SESSION_NOT_OWNED");
        }
        Ok(())
    }
    fn installation_id(&self) -> BridgeResult<String> {
        self.effects
            .lock()
            .map_err(|_| "STATE_UNAVAILABLE")?
            .installation
            .clone()
            .ok_or("INSTALLATION_NOT_CONFIRMED")
    }
    pub(super) async fn connect(
        &self,
        client: &reqwest::Client,
        base: &reqwest::Url,
        id: &str,
    ) -> Result<(TeacherSocket, u64), AppError> {
        let installation = self
            .read_installation()?
            .ok_or(AppError::RemoteNotEnrolled)?;
        connect_with_installation(client, base, id, &installation).await
    }
    fn cleanup(&self) -> BridgeResult<()> {
        if !self.write_attempted.load(Ordering::SeqCst) {
            return Ok(());
        }
        let entry = self.entry().map_err(|_| "CREDENTIAL_CLEANUP_FAILED")?;
        cleanup_credential(
            || match entry.delete_credential() {
                Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
                Err(_) => Err("CREDENTIAL_CLEANUP_FAILED"),
            },
            || match entry.get_password() {
                Err(keyring_core::Error::NoEntry) => Ok(()),
                _ => Err("CREDENTIAL_CLEANUP_UNCONFIRMED"),
            },
        )?;
        self.write_attempted.store(false, Ordering::SeqCst);
        Ok(())
    }
}

fn cleanup_credential(
    delete: impl FnOnce() -> BridgeResult<()>,
    verify: impl FnOnce() -> BridgeResult<()>,
) -> BridgeResult<()> {
    delete()?;
    verify()
}

struct Runner {
    config: Config,
    directory: PathBuf,
    database: Database,
    persistence: PersistenceService,
    quiz: Arc<LiveQuizService>,
    sessions: Arc<LocalSessionService>,
    server: crate::application::LocalServerService,
    service: RemoteControlService,
    context: Arc<Context>,
    classroom_id: String,
    set_id: String,
    local_session: Option<String>,
    question: Option<String>,
    question_state: &'static str,
    ordinal: i64,
    enrollment_attempted: bool,
    create_attempted: bool,
    close_attempted: bool,
    total_deadline: Instant,
    work_deadline: Instant,
}

fn setup_owned_directory<T>(
    directory: &Path,
    setup: impl FnOnce() -> BridgeResult<T>,
) -> BridgeResult<T> {
    // Ownership starts only after exclusive creation; never remove a collision.
    std::fs::create_dir(directory).map_err(|_| "APP_DATA_COLLISION")?;
    match setup() {
        Ok(value) => Ok(value),
        Err(error) => {
            // The closure has returned, so all failed setup's services/handles
            // have been dropped before removing this run's owned directory.
            std::fs::remove_dir_all(directory).map_err(|_| "APP_DATA_CLEANUP_FAILED")?;
            Err(error)
        }
    }
}

impl Runner {
    fn configure(config: Config) -> BridgeResult<Self> {
        let began = Instant::now();
        // Validate structural constraints before any new app data or credential lookup.
        validate_bounds(&config, &config.origin)?;
        let effective = configured_base_url().ok_or("EFFECTIVE_TARGET_MISMATCH")?;
        validate_bounds(&config, effective.as_str())?;
        let run = validate_files(&config)?;
        let directory = run.join("native-app-data");
        setup_owned_directory(&directory, || {
            let persistence = PersistenceService::initialize(&directory)
                .map_err(|_| "APP_DATA_INITIALIZATION_FAILED")?;
            let database = persistence.database_for_local_session();
            let quiz = LiveQuizService::initialize(database.clone(), &directory)
                .map_err(|_| "QUIZ_INITIALIZATION_FAILED")?;
            let sessions = LocalSessionService::initialize(database.clone())
                .map_err(|_| "SESSION_INITIALIZATION_FAILED")?;
            let server = crate::application::LocalServerService::new(
                sessions.clone(),
                quiz.clone(),
                crate::application::grouping::GroupingService::initialize(database.clone()),
                crate::application::StudentAssetLocation::from_root(&directory),
            );
            let mut service =
                RemoteControlService::initialize(sessions.clone(), server.participant_realtime());
            let effective = service
                .base_url()
                .map_err(|_| "EFFECTIVE_TARGET_MISMATCH")?
                .as_str();
            validate_bounds(&config, effective)?;
            let context = Arc::new(Context::new(&config.run_id, true)?);
            context.require_absent()?;
            service.pass_b = Some(context.clone());
            let classroom = ClassroomRepository::create(
                &database,
                NewClassroom {
                    name: "Pass B synthetic classroom".to_owned(),
                    academic_year: None,
                },
            )
            .map_err(|_| "FIXTURE_SETUP_FAILED")?;
            for seat in 1..=config.students {
                StudentRepository::create(
                    &database,
                    NewStudent {
                        class_id: classroom.id.clone(),
                        seat_number: i64::from(seat),
                        name: format!("Fixture {seat}"),
                    },
                )
                .map_err(|_| "FIXTURE_SETUP_FAILED")?;
            }
            let set = QuestionSetRepository::create(
                &database,
                NewQuestionSet {
                    lesson_id: None,
                    title: "Pass B synthetic questions".to_owned(),
                    description: None,
                },
            )
            .map_err(|_| "FIXTURE_SETUP_FAILED")?;
            let work_deadline =
                began + Duration::from_millis(config.remaining_ms - config.cleanup_reserve_ms);
            let total_deadline = began + Duration::from_millis(config.remaining_ms);
            let remaining_work = work_deadline
                .checked_duration_since(Instant::now())
                .ok_or("SETUP_DEADLINE_EXCEEDED")?;
            super::super::remote_capacity_metrics::enable_pass_b(remaining_work)?;
            Ok(Self {
                config,
                directory: directory.clone(),
                database,
                persistence,
                quiz,
                sessions,
                server,
                service,
                context,
                classroom_id: classroom.id,
                set_id: set.id,
                local_session: None,
                question: None,
                question_state: "NONE",
                ordinal: 0,
                enrollment_attempted: false,
                create_attempted: false,
                close_attempted: false,
                total_deadline,
                work_deadline,
            })
        })
    }
    fn check_work(&self) -> BridgeResult<()> {
        if Instant::now() >= self.work_deadline || super::super::remote_capacity_metrics::stopped()
        {
            Err("WORK_BUDGET_STOPPED")
        } else {
            Ok(())
        }
    }
    fn local_id(&self) -> BridgeResult<&str> {
        self.local_session.as_deref().ok_or("SESSION_NOT_READY")
    }
    fn current_question(&self) -> BridgeResult<String> {
        self.question.clone().ok_or("QUESTION_NOT_READY")
    }
    fn publish(&mut self) -> BridgeResult<Value> {
        self.check_work()?;
        if self.ordinal >= 12 {
            return Err("QUESTION_LIMIT");
        }
        if let Some(previous) = self.question.clone() {
            if self.question_state == "OPEN" {
                self.quiz
                    .lock(previous.clone())
                    .map_err(|_| "QUIZ_LOCK_FAILED")?;
            }
            if self.question_state != "REVEALED" {
                self.quiz
                    .reveal(previous)
                    .map_err(|_| "QUIZ_REVEAL_FAILED")?;
            }
        }
        self.ordinal += 1;
        let source = QuestionRepository::create(
            &self.database,
            NewQuestion {
                question_set_id: self.set_id.clone(),
                question_type: "true_false".to_owned(),
                prompt: format!("Synthetic question {}", self.ordinal),
                points: 1,
                position: self.ordinal,
                answer_config: json!({"correctAnswer":true}),
                grading_config: json!({}),
                metadata: json!({}),
            },
        )
        .map_err(|_| "QUESTION_SETUP_FAILED")?;
        self.persistence
            .import_question_asset(ImportQuestionAssetRequest {
                question_id: source.id.clone(),
                source_path: self.config.image_path.to_string_lossy().into_owned(),
            })
            .map_err(|_| "IMAGE_IMPORT_FAILED")?;
        let published = self
            .quiz
            .publish(self.local_id()?.to_owned(), source.id)
            .map_err(|_| "QUIZ_PUBLISH_FAILED")?;
        self.quiz
            .open(published.id.clone())
            .map_err(|_| "QUIZ_OPEN_FAILED")?;
        let image_id = published
            .assets
            .first()
            .ok_or("IMAGE_ASSET_MISSING")?
            .id
            .clone();
        self.question = Some(published.id.clone());
        self.question_state = "OPEN";
        Ok(json!({"questionId":published.id,"imageId":image_id}))
    }
    async fn wait_ready(&self, previous: u64) -> BridgeResult<Value> {
        loop {
            self.check_work()?;
            if let Some(status) = self.service.status().map_err(|_| "STATUS_UNAVAILABLE")? {
                if matches!(status.state, RemoteConnectionState::Open)
                    && status.generation.is_some_and(|g| g > previous)
                {
                    return Ok(json!({"generation":status.generation}));
                }
            }
            sleep(Duration::from_millis(40)).await;
        }
    }
    fn stop_owned(&self) -> BridgeResult<()> {
        super::super::remote_capacity_metrics::stop_pass_b();
        let state = self.service.active.lock().map_err(|_| "STOP_FAILED")?;
        if let Some(active) = state.as_ref() {
            active.stop.send_replace(true);
        }
        Ok(())
    }
    async fn command(&mut self, command: &str, value: &Value) -> BridgeResult<Value> {
        if !matches!(
            command,
            "close" | "cleanup" | "metrics" | "stop" | "shutdown"
        ) {
            self.check_work()?;
        }
        match command {
            "enroll" => {
                if self.enrollment_attempted {
                    return Err("ENROLLMENT_ALREADY_ATTEMPTED");
                }
                let code = value["activationCode"]
                    .as_str()
                    .filter(|s| is_secret(s))
                    .ok_or("ACTIVATION_INVALID")?
                    .to_owned();
                self.enrollment_attempted = true;
                self.service
                    .enroll(code)
                    .await
                    .map_err(|_| "ENROLLMENT_EFFECT_UNKNOWN")?;
                Ok(json!({"installationId":self.context.installation_id()?}))
            }
            "create" => {
                if self.create_attempted {
                    return Err("SESSION_ALREADY_ATTEMPTED");
                }
                if !self
                    .service
                    .enrolled()
                    .map_err(|_| "CREDENTIAL_UNAVAILABLE")?
                {
                    return Err("NOT_ENROLLED");
                }
                self.create_attempted = true;
                let created = self
                    .service
                    .create_session(self.classroom_id.clone())
                    .await
                    .map_err(|_| "SESSION_EFFECT_UNKNOWN")?;
                self.local_session = Some(created.local_session_id.clone());
                Ok(
                    json!({"remoteSessionId":created.remote_session_id,"localSessionId":created.local_session_id}),
                )
            }
            "ready" => self.wait_ready(0).await,
            "start" => {
                let ids: Vec<String> = serde_json::from_value(value["participantIds"].clone())
                    .map_err(|_| "PARTICIPANTS_INVALID")?;
                let actual = self
                    .sessions
                    .list_participants(self.local_id()?)
                    .map_err(|_| "PARTICIPANTS_UNAVAILABLE")?;
                let mut expected: Vec<_> =
                    actual.iter().map(|p| p.participant_id.clone()).collect();
                let mut provided = ids;
                expected.sort();
                provided.sort();
                if expected != provided || expected.len() != self.config.students as usize {
                    return Err("PARTICIPANTS_MISMATCH");
                }
                self.service
                    .start_session(self.local_id()?.to_owned())
                    .map_err(|_| "START_FAILED")?;
                self.publish()
            }
            "publish" => self.publish(),
            "progress" => {
                let progress = self
                    .quiz
                    .teacher_progress(self.current_question()?, self.config.students as usize)
                    .map_err(|_| "PROGRESS_FAILED")?;
                Ok(
                    json!({"answeredCount":progress.answered_count,"participantCount":progress.participant_count}),
                )
            }
            "presence" => {
                let participants = self
                    .sessions
                    .list_participants(self.local_id()?)
                    .map_err(|_| "PRESENCE_FAILED")?;
                Ok(
                    json!({"online":participants.iter().filter(|p|self.server.is_participant_online(&p.participant_id)).count(),"total":participants.len(),"generation":self.service.status().map_err(|_|"STATUS_UNAVAILABLE")?.and_then(|s|s.generation)}),
                )
            }
            "metrics" => Ok(metrics_summary()),
            "lock" => {
                self.quiz
                    .lock(self.current_question()?)
                    .map_err(|_| "QUIZ_LOCK_FAILED")?;
                self.question_state = "LOCKED";
                Ok(json!({"done":true}))
            }
            "reveal" => {
                self.quiz
                    .reveal(self.current_question()?)
                    .map_err(|_| "QUIZ_REVEAL_FAILED")?;
                self.question_state = "REVEALED";
                Ok(json!({"done":true}))
            }
            "reconnect" => {
                let status = self
                    .service
                    .status()
                    .map_err(|_| "STATUS_UNAVAILABLE")?
                    .ok_or("SESSION_NOT_READY")?;
                let previous = status.generation.ok_or("GENERATION_UNAVAILABLE")?;
                let (mut replacement, _) = self
                    .context
                    .connect(
                        self.service.client().map_err(|_| "CLIENT_UNAVAILABLE")?,
                        self.service
                            .base_url()
                            .map_err(|_| "EFFECTIVE_TARGET_MISMATCH")?,
                        &status.remote_session_id,
                    )
                    .await
                    .map_err(|_| "RECONNECT_FAILED")?;
                replacement
                    .close(None)
                    .await
                    .map_err(|_| "REPLACEMENT_CLOSE_FAILED")?;
                self.wait_ready(previous).await
            }
            "stop" => {
                self.stop_owned()?;
                Ok(json!({"stopped":true}))
            }
            "close" => {
                let id = value["remoteSessionId"]
                    .as_str()
                    .ok_or("SESSION_NOT_OWNED")?;
                self.context.owned_session(id)?;
                if self.close_attempted {
                    return Err("CLOSE_ALREADY_ATTEMPTED");
                }
                self.close_attempted = true;
                self.stop_owned()?;
                if self
                    .service
                    .status()
                    .map_err(|_| "STATUS_UNAVAILABLE")?
                    .is_some()
                {
                    self.service
                        .close_session()
                        .await
                        .map_err(|_| "CLOSE_UNCONFIRMED")?;
                } else {
                    let installation = self
                        .context
                        .read_installation()
                        .map_err(|_| "CREDENTIAL_UNAVAILABLE")?
                        .ok_or("NOT_ENROLLED")?;
                    self.service
                        .close_relay(id, &installation)
                        .await
                        .map_err(|_| "CLOSE_UNCONFIRMED")?;
                }
                Ok(json!({"confirmed":true,"closed":true,"remoteSessionId":id}))
            }
            _ => Err("COMMAND_INVALID"),
        }
    }
}

fn metrics_summary() -> Value {
    let mut value = super::super::remote_capacity_metrics::snapshot();
    if let Some(object) = value.as_object_mut() {
        object.remove("requests");
        object.remove("timeline");
    }
    value
}

async fn cleanup_runner(runner: Runner) -> BridgeResult<Value> {
    let stop = runner.stop_owned();
    let stop_timeout = runner
        .total_deadline
        .saturating_duration_since(Instant::now())
        .min(Duration::from_secs(12));
    let stopped = timeout(stop_timeout, async {
        while runner.context.active_connections.load(Ordering::SeqCst) > 0 {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| "TRANSPORT_STOP_UNCONFIRMED");
    let credentials = runner.context.cleanup();
    let directory = runner.directory.clone();
    let root = runner
        .config
        .run_directory
        .canonicalize()
        .map_err(|_| "CLEANUP_PATH_UNAVAILABLE")?;
    let canonical = inside(&directory, &root)?;
    if canonical != root.join("native-app-data") {
        return Err("CLEANUP_PATH_ESCAPE");
    }
    drop(runner);
    let data = if stopped.is_ok() {
        std::fs::remove_dir_all(canonical).map_err(|_| "APP_DATA_CLEANUP_FAILED")
    } else {
        Err("APP_DATA_RETAINED_FOR_ACTIVE_TRANSPORT")
    };
    stop?;
    stopped?;
    credentials?;
    data?;
    Ok(json!({"credentialCleaned":true,"temporaryDataCleaned":true,"transportStopped":true}))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "Explicit Pass B supervisor only; production execution requires separate authorization"]
async fn remote_pass_b_runner() {
    // An owned, bounded stdin reader keeps slow/closed pipes off Tokio's runtime.
    let (sender, mut receiver) = tokio::sync::mpsc::channel(8);
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut reader = stdin.lock();
        loop {
            let mut bytes = Vec::new();
            match reader.by_ref().take(65_537).read_until(b'\n', &mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(_) if bytes.len() > 65_536 => {
                    let _ = sender.blocking_send(Err("INPUT_TOO_LARGE"));
                    break;
                }
                Ok(_) => {
                    let parsed =
                        serde_json::from_slice::<Value>(&bytes).map_err(|_| "INPUT_INVALID");
                    if sender.blocking_send(parsed).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let mut overall_deadline = Instant::now() + Duration::from_secs(30);
    let mut runner: Option<Runner> = None;
    let mut configured = false;
    loop {
        let deadline = overall_deadline;
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        let incoming = timeout(remaining, receiver.recv()).await;
        let value = match incoming {
            Ok(Some(Ok(value))) => value,
            _ => break,
        };
        let Some(id) = value["id"]
            .as_str()
            .filter(|id| id.len() <= 80 && !id.is_empty())
        else {
            break;
        };
        let command = value["command"].as_str().unwrap_or("");
        let result = if command == "configure" && !configured {
            configured = true;
            match serde_json::from_value::<Config>(value["config"].clone())
                .map_err(|_| "CONFIG_INVALID")
                .and_then(Runner::configure)
            {
                Ok(next) => {
                    overall_deadline = next.total_deadline;
                    let result = json!({"effectiveUrl":next.config.origin,"credentialTarget":next.context.target,"students":next.config.students,"rawLimit":1_073_741_824u64,"wireLimit":2_147_483_648u64});
                    runner = Some(next);
                    Ok(result)
                }
                Err(error) => Err(error),
            }
        } else if command == "shutdown" {
            if runner.is_some() {
                Err("CLEANUP_REQUIRED")
            } else {
                Ok(json!({"shutdown":true}))
            }
        } else if command == "cleanup" {
            match runner.take() {
                Some(owned) => cleanup_runner(owned).await,
                None => Err("NOT_CONFIGURED"),
            }
        } else if let Some(owned) = runner.as_mut() {
            let limit = if matches!(command, "ready" | "reconnect") {
                35_000
            } else {
                15_000
            };
            let bounded = deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(limit));
            timeout(bounded, owned.command(command, &value))
                .await
                .unwrap_or(Err("COMMAND_DEADLINE_EXCEEDED"))
        } else {
            Err("NOT_CONFIGURED")
        };
        let response = match result {
            Ok(result) => json!({"id":id,"ok":true,"result":result}),
            Err(code) => {
                json!({"id":id,"ok":false,"errorCode":code,"effect":if matches!(command,"enroll"|"create") {"EFFECT_UNKNOWN"} else {"NOT_CONFIRMED"}})
            }
        };
        if emit(&response).is_err() || (command == "shutdown" && response["ok"] == true) {
            break;
        }
    }
    if let Some(owned) = runner {
        // A supervisor pipe/deadline failure does not assert remote resources were cleaned.
        let _ = owned.stop_owned();
        let result = cleanup_runner(owned).await;
        let _ = emit(
            &json!({"event":"terminated","cleanup":if result.is_ok(){"LOCAL_ONLY_COMPLETE"}else{"CLEANUP_INCOMPLETE"},"remoteCleanup":"NOT_CONFIRMED"}),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            run_id: Uuid::now_v7().to_string(),
            mode: "loopback".to_owned(),
            origin: LOOPBACK.to_owned(),
            students: 30,
            teachers: 1,
            classrooms: 1,
            run_directory: PathBuf::new(),
            image_path: PathBuf::new(),
            image_hash: "0".repeat(64),
            client_module: PathBuf::new(),
            client_hash: "0".repeat(64),
            native_hash: "0".repeat(64),
            remaining_ms: 60_000,
            cleanup_reserve_ms: 10_000,
        }
    }
    #[test]
    fn pass_b_target_profile_and_effective_url_fail_closed() {
        let mut value = config();
        assert!(validate_bounds(&value, LOOPBACK).is_ok());
        for target in [
            "http://localhost:8794/",
            "http://127.0.0.1:8794/path",
            "https://classroom-relay.ryanaddy1102.workers.dev/?x=1",
            "https://user@classroom-relay.ryanaddy1102.workers.dev/",
            "https://classroom-relay.ryanaddy1102.workers.dev:444/",
        ] {
            value.origin = target.to_owned();
            assert!(validate_bounds(&value, target).is_err());
        }
        value = config();
        assert!(validate_bounds(&value, PRODUCTION).is_err());
        value.students = 31;
        assert!(validate_bounds(&value, LOOPBACK).is_err());
        value.students = 30;
        value.teachers = 2;
        assert!(validate_bounds(&value, LOOPBACK).is_err());
        value.teachers = 1;
        value.classrooms = 2;
        assert!(validate_bounds(&value, LOOPBACK).is_err());
        value.classrooms = 1;
        value.remaining_ms = 1_800_001;
        assert!(validate_bounds(&value, LOOPBACK).is_err());
    }
    #[test]
    fn pass_b_credential_targets_and_cleanup_errors_are_isolated() {
        let first = target_for(&Uuid::now_v7().to_string()).expect("run target");
        let second = target_for(&Uuid::now_v7().to_string()).expect("run target");
        assert_ne!(first, second);
        assert_ne!(first, "Classroom.RemoteInstallation");
        assert_ne!(first, "Classroom.RemoteInstallation.Phase16CTest");
        assert!(target_for("../../teacher").is_err());
        assert_eq!(
            cleanup_credential(
                || Err("DELETE_FAILED"),
                || panic!("verify after failed delete")
            ),
            Err("DELETE_FAILED")
        );
        assert_eq!(
            cleanup_credential(|| Ok(()), || Err("STILL_PRESENT")),
            Err("STILL_PRESENT")
        );
    }
    #[test]
    fn pass_b_windows_run_credential_collision_and_exact_cleanup() {
        keyring_core::set_default_store(
            windows_native_keyring_store::Store::new().expect("Windows store"),
        );
        let context = Context::new(&Uuid::now_v7().to_string(), false).expect("context");
        context.require_absent().expect("new target");
        let installation = InstallationCredential {
            installation_id: Uuid::now_v7().to_string(),
            installation_credential: "s".repeat(43),
        };
        context
            .write_installation(&installation)
            .expect("isolated write");
        assert_eq!(context.require_absent(), Err("CREDENTIAL_COLLISION"));
        assert!(context.write_installation(&installation).is_err());
        assert_eq!(
            context
                .read_installation()
                .expect("isolated read")
                .expect("present")
                .installation_id,
            installation.installation_id
        );
        context.cleanup().expect("verified deletion");
        context.require_absent().expect("deleted");
    }
    #[test]
    fn pass_b_identity_and_path_escape_rejected() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::NamedTempFile::new().expect("outside");
        assert!(inside(
            outside.path(),
            &root.path().canonicalize().expect("canonical")
        )
        .is_err());
        let fixture = root.path().join("fixture.bin");
        std::fs::write(&fixture, b"synthetic").expect("fixture");
        assert_eq!(
            hash_file(&fixture, &"0".repeat(64), 1024),
            Err("IDENTITY_MISMATCH")
        );
        assert_eq!(
            hash_file(&fixture, &format!("{:x}", Sha256::digest(b"synthetic")), 1),
            Err("IDENTITY_SIZE_INVALID")
        );
    }
    #[test]
    fn pass_b_exact_ownership_and_single_confirmation() {
        let context = Context::new(&Uuid::now_v7().to_string(), false).expect("context");
        let id = "a".repeat(32);
        assert!(context.owned_session(&id).is_err());
        context.confirmed("session", &id).expect("confirmed");
        assert!(context.owned_session(&id).is_ok());
        assert!(context.owned_session(&"b".repeat(32)).is_err());
        assert!(context.confirmed("session", &id).is_err());
    }

    #[test]
    fn pass_b_post_setup_failure_drops_handles_and_removes_owned_data() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = tempfile::tempdir().expect("test root");
        for error in ["SETUP_DEADLINE_EXCEEDED", "BUDGET_INVALID"] {
            let directory = root.path().join(error);
            let result = setup_owned_directory(&directory, || {
                let persistence =
                    PersistenceService::initialize(&directory).map_err(|_| "TEST_SETUP_FAILED")?;
                let database = persistence.database_for_local_session();
                let _sessions =
                    LocalSessionService::initialize(database).map_err(|_| "TEST_SETUP_FAILED")?;
                // Windows denies directory removal until this local handle is dropped.
                let _exclusive = std::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .share_mode(0)
                    .open(directory.join("owned-fixture"))
                    .map_err(|_| "TEST_SETUP_FAILED")?;
                Err::<(), _>(error)
            });
            assert_eq!(result, Err(error));
            assert!(!directory.exists());
        }
    }

    #[test]
    fn pass_b_setup_collision_is_preserved_and_cleanup_error_is_visible() {
        let root = tempfile::tempdir().expect("test root");
        let directory = root.path().join("existing");
        std::fs::create_dir(&directory).expect("existing directory");
        let marker = directory.join("unowned");
        std::fs::write(&marker, "preserve").expect("existing data");
        let collision: BridgeResult<()> =
            setup_owned_directory(&directory, || panic!("must not run setup"));
        assert_eq!(collision, Err("APP_DATA_COLLISION"));
        assert_eq!(
            std::fs::read_to_string(marker).expect("preserved"),
            "preserve"
        );

        let failed = root.path().join("cleanup-error");
        let result = setup_owned_directory(&failed, || {
            std::fs::remove_dir(&failed).map_err(|_| "TEST_SETUP_FAILED")?;
            std::fs::write(&failed, "synthetic replacement").map_err(|_| "TEST_SETUP_FAILED")?;
            Err::<(), _>("BUDGET_INVALID")
        });
        assert_eq!(result, Err("APP_DATA_CLEANUP_FAILED"));
    }
}
