use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::{Duration, Instant};

use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    ConnectInfo, Path, State,
};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use network_interface::{Addr, NetworkInterface, NetworkInterfaceConfig};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tower_http::limit::RequestBodyLimitLayer;
use uuid::Uuid;

use crate::application::{
    LiveQuizService, LocalSessionService, QuestionPublicView, QuestionRevealView, SessionSyncDto,
    StudentAssetLocation, StudentAssetProvider, SubmissionAckDto,
};
use crate::error::AppError;
use crate::question_domain::StudentAnswer;

pub const LOCAL_PROTOCOL_VERSION: u8 = 1;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 64 * 1024;
const JOIN_LIMIT_MAX_FAILURES: usize = 10;
const JOIN_LIMIT_WINDOW: Duration = Duration::from_secs(60);
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
pub const PRESENCE_TIMEOUT: Duration = Duration::from_secs(7);

#[cfg(debug_assertions)]
fn transport_debug(category: &str) {
    eprintln!("Local transport: {category}");
}

#[cfg(not(debug_assertions))]
fn transport_debug(_: &str) {}

#[cfg(debug_assertions)]
fn transport_connection_debug(connection_id: Uuid, category: &str) {
    eprintln!("Local transport [{connection_id}]: {category}");
}

#[cfg(not(debug_assertions))]
fn transport_connection_debug(_: Uuid, _: &str) {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalServerLifecycleState {
    Stopped,
    Starting,
    Running,
    Stopping,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerStatus {
    pub running: bool,
    pub lifecycle_state: LocalServerLifecycleState,
    pub port: Option<u16>,
    pub local_url: Option<String>,
    pub server_instance_id: Option<String>,
    pub candidate_urls: Vec<String>,
    pub web_socket_urls: Vec<String>,
    pub protocol_version: u8,
}

#[derive(Debug, Clone)]
struct ServerDetails {
    bound_address: SocketAddr,
    server_instance_id: String,
    candidate_urls: Vec<String>,
    web_socket_urls: Vec<String>,
}

struct RunningServer {
    details: ServerDetails,
    shutdown_sender: oneshot::Sender<()>,
    task: tauri::async_runtime::JoinHandle<()>,
}

enum ServerLifecycle {
    Stopped,
    Starting,
    Running(RunningServer),
    Stopping(Option<ServerDetails>),
}

impl ServerLifecycle {
    fn status(&self) -> LocalServerStatus {
        match self {
            Self::Stopped => LocalServerStatus::stopped(LocalServerLifecycleState::Stopped),
            Self::Starting => LocalServerStatus::stopped(LocalServerLifecycleState::Starting),
            Self::Running(server) => LocalServerStatus::running(&server.details),
            Self::Stopping(details) => match details {
                Some(details) => LocalServerStatus::stopping(details),
                None => LocalServerStatus::stopped(LocalServerLifecycleState::Stopping),
            },
        }
    }
}

impl LocalServerStatus {
    fn stopped(lifecycle_state: LocalServerLifecycleState) -> Self {
        Self {
            running: false,
            lifecycle_state,
            port: None,
            local_url: None,
            server_instance_id: None,
            candidate_urls: Vec::new(),
            web_socket_urls: Vec::new(),
            protocol_version: LOCAL_PROTOCOL_VERSION,
        }
    }

    fn running(details: &ServerDetails) -> Self {
        Self {
            running: true,
            lifecycle_state: LocalServerLifecycleState::Running,
            port: Some(details.bound_address.port()),
            local_url: Some(local_url(details.bound_address.port())),
            server_instance_id: Some(details.server_instance_id.clone()),
            candidate_urls: details.candidate_urls.clone(),
            web_socket_urls: details.web_socket_urls.clone(),
            protocol_version: LOCAL_PROTOCOL_VERSION,
        }
    }

    fn stopping(details: &ServerDetails) -> Self {
        Self {
            running: false,
            lifecycle_state: LocalServerLifecycleState::Stopping,
            port: Some(details.bound_address.port()),
            local_url: Some(local_url(details.bound_address.port())),
            server_instance_id: Some(details.server_instance_id.clone()),
            candidate_urls: details.candidate_urls.clone(),
            web_socket_urls: details.web_socket_urls.clone(),
            protocol_version: LOCAL_PROTOCOL_VERSION,
        }
    }
}

pub struct LocalServerService {
    lifecycle: Arc<Mutex<ServerLifecycle>>,
    session: Arc<LocalSessionService>,
    quiz: Arc<LiveQuizService>,
    student_assets: StudentAssetLocation,
    presence: PresenceRegistry,
}

impl LocalServerService {
    pub fn new(
        session: Arc<LocalSessionService>,
        quiz: Arc<LiveQuizService>,
        student_assets: StudentAssetLocation,
    ) -> Self {
        Self {
            lifecycle: Arc::new(Mutex::new(ServerLifecycle::Stopped)),
            session,
            quiz,
            student_assets,
            presence: PresenceRegistry::default(),
        }
    }

    pub fn is_participant_online(&self, participant_id: &str) -> bool {
        self.presence.is_online(participant_id)
    }

    pub fn status(&self) -> Result<LocalServerStatus, AppError> {
        Ok(self.lifecycle()?.status())
    }

    pub async fn start(&self) -> Result<LocalServerStatus, AppError> {
        self.start_on(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)), true)
            .await
    }

    pub async fn stop(&self) -> Result<LocalServerStatus, AppError> {
        if self.session.has_nonterminal_session()? {
            return Err(AppError::Conflict(
                "end the local session before stopping the server".to_owned(),
            ));
        }
        let shutdown = {
            let mut lifecycle = self.lifecycle()?;
            match std::mem::replace(&mut *lifecycle, ServerLifecycle::Stopped) {
                ServerLifecycle::Stopped => return Ok(lifecycle.status()),
                ServerLifecycle::Starting => {
                    *lifecycle = ServerLifecycle::Stopping(None);
                    return Ok(lifecycle.status());
                }
                ServerLifecycle::Stopping(details) => {
                    *lifecycle = ServerLifecycle::Stopping(details);
                    return Ok(lifecycle.status());
                }
                ServerLifecycle::Running(server) => {
                    let details = server.details.clone();
                    *lifecycle = ServerLifecycle::Stopping(Some(details));
                    Some((server.shutdown_sender, server.task))
                }
            }
        };

        if let Some((shutdown_sender, task)) = shutdown {
            let _ = shutdown_sender.send(());
            if task.await.is_err() {
                let mut lifecycle = self.lifecycle()?;
                *lifecycle = ServerLifecycle::Stopped;
                return Err(AppError::ServerShutdownFailed);
            }
        }

        let mut lifecycle = self.lifecycle()?;
        *lifecycle = ServerLifecycle::Stopped;
        Ok(lifecycle.status())
    }

    async fn start_on(
        &self,
        bind_address: SocketAddr,
        discover_lan_candidates: bool,
    ) -> Result<LocalServerStatus, AppError> {
        {
            let mut lifecycle = self.lifecycle()?;
            match &*lifecycle {
                ServerLifecycle::Running(_)
                | ServerLifecycle::Starting
                | ServerLifecycle::Stopping(_) => {
                    return Ok(lifecycle.status());
                }
                ServerLifecycle::Stopped => *lifecycle = ServerLifecycle::Starting,
            }
        }

        let listener = match TcpListener::bind(bind_address).await {
            Ok(listener) => listener,
            Err(_) => {
                eprintln!("Local server bind failed.");
                let mut lifecycle = self.lifecycle()?;
                *lifecycle = ServerLifecycle::Stopped;
                return Err(AppError::ServerBindFailed);
            }
        };
        let bound_address = match listener.local_addr() {
            Ok(address) => address,
            Err(_) => {
                let mut lifecycle = self.lifecycle()?;
                *lifecycle = ServerLifecycle::Stopped;
                return Err(AppError::ServerStartFailed);
            }
        };
        let server_instance_id = Uuid::now_v7().to_string();
        let candidate_urls = if discover_lan_candidates {
            discover_candidate_urls(bound_address.port())
        } else {
            Vec::new()
        };
        let details = ServerDetails {
            bound_address,
            server_instance_id: server_instance_id.clone(),
            web_socket_urls: web_socket_urls(bound_address.port(), &candidate_urls),
            candidate_urls,
        };
        let assets = self.student_assets.load()?;
        let router_state = Arc::new(TransportState {
            server_instance_id,
            session: Arc::clone(&self.session),
            quiz: Arc::clone(&self.quiz),
            assets,
            presence: self.presence.clone(),
            limiter: JoinRateLimiter::default(),
        });
        let (shutdown_sender, shutdown_receiver) = oneshot::channel();

        let mut lifecycle = self.lifecycle()?;
        match &*lifecycle {
            ServerLifecycle::Starting => {
                let task_lifecycle = Arc::clone(&self.lifecycle);
                let task_server_id = details.server_instance_id.clone();
                let router = router(router_state);
                let task = tauri::async_runtime::spawn(async move {
                    run_server(
                        listener,
                        router,
                        shutdown_receiver,
                        task_lifecycle,
                        task_server_id,
                    )
                    .await;
                });
                eprintln!("Local server started.");
                *lifecycle = ServerLifecycle::Running(RunningServer {
                    details: details.clone(),
                    shutdown_sender,
                    task,
                });
                Ok(LocalServerStatus::running(&details))
            }
            ServerLifecycle::Stopping(None) => {
                *lifecycle = ServerLifecycle::Stopped;
                Ok(lifecycle.status())
            }
            _ => {
                *lifecycle = ServerLifecycle::Stopped;
                Err(AppError::ServerStartFailed)
            }
        }
    }

    fn lifecycle(&self) -> Result<MutexGuard<'_, ServerLifecycle>, AppError> {
        self.lifecycle
            .lock()
            .map_err(|_| AppError::ServerStartFailed)
    }
}

#[derive(Clone)]
struct TransportState {
    server_instance_id: String,
    session: Arc<LocalSessionService>,
    quiz: Arc<LiveQuizService>,
    assets: StudentAssetProvider,
    presence: PresenceRegistry,
    limiter: JoinRateLimiter,
}

type PresenceClock = Arc<dyn Fn() -> Duration + Send + Sync>;

#[derive(Clone)]
pub struct PresenceRegistry {
    connections: Arc<RwLock<HashMap<String, HashMap<Uuid, Duration>>>>,
    clock: PresenceClock,
}

impl Default for PresenceRegistry {
    fn default() -> Self {
        let started_at = Instant::now();
        Self::with_clock(Arc::new(move || started_at.elapsed()))
    }
}

impl PresenceRegistry {
    fn with_clock(clock: PresenceClock) -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            clock,
        }
    }

    fn connect(&self, participant_id: &str) -> Uuid {
        let connection_id = Uuid::now_v7();
        self.connect_with_id(participant_id, connection_id);
        connection_id
    }

    fn connect_with_id(&self, participant_id: &str, connection_id: Uuid) {
        if let Ok(mut connections) = self.connections.write() {
            connections
                .entry(participant_id.to_owned())
                .or_default()
                .insert(connection_id, (self.clock)());
        }
    }

    fn heartbeat(&self, participant_id: &str, connection_id: Uuid) {
        if let Ok(mut connections) = self.connections.write() {
            if let Some(last_seen) = connections
                .get_mut(participant_id)
                .and_then(|participant| participant.get_mut(&connection_id))
            {
                *last_seen = (self.clock)();
            }
        }
    }

    fn disconnect(&self, participant_id: &str, connection_id: Uuid) {
        if let Ok(mut connections) = self.connections.write() {
            let should_remove = connections
                .get_mut(participant_id)
                .is_some_and(|participant| {
                    participant.remove(&connection_id);
                    participant.is_empty()
                });
            if should_remove {
                connections.remove(participant_id);
            }
        }
    }

    fn is_online(&self, participant_id: &str) -> bool {
        let now = (self.clock)();
        let Ok(mut connections) = self.connections.write() else {
            return false;
        };
        let online = connections
            .get_mut(participant_id)
            .is_some_and(|participant| {
                participant
                    .retain(|_, last_seen| now.saturating_sub(*last_seen) <= PRESENCE_TIMEOUT);
                !participant.is_empty()
            });
        if !online {
            connections.remove(participant_id);
        }
        online
    }
}

#[derive(Clone, Default)]
struct JoinRateLimiter {
    attempts: Arc<Mutex<HashMap<IpAddr, JoinAttemptWindow>>>,
}

#[derive(Clone)]
struct JoinAttemptWindow {
    started_at: Instant,
    failures: usize,
}

impl JoinRateLimiter {
    fn permits(&self, source: IpAddr) -> bool {
        let Ok(mut attempts) = self.attempts.lock() else {
            return false;
        };
        let now = Instant::now();
        let window = attempts.entry(source).or_insert(JoinAttemptWindow {
            started_at: now,
            failures: 0,
        });
        if now.duration_since(window.started_at) >= JOIN_LIMIT_WINDOW {
            *window = JoinAttemptWindow {
                started_at: now,
                failures: 0,
            };
        }
        window.failures < JOIN_LIMIT_MAX_FAILURES
    }

    fn failure(&self, source: IpAddr) {
        if let Ok(mut attempts) = self.attempts.lock() {
            let now = Instant::now();
            let window = attempts.entry(source).or_insert(JoinAttemptWindow {
                started_at: now,
                failures: 0,
            });
            if now.duration_since(window.started_at) >= JOIN_LIMIT_WINDOW {
                *window = JoinAttemptWindow {
                    started_at: now,
                    failures: 0,
                };
            }
            window.failures = window.failures.saturating_add(1);
        }
    }

    fn success(&self, source: IpAddr) {
        if let Ok(mut attempts) = self.attempts.lock() {
            attempts.remove(&source);
        }
    }
}

fn router(state: Arc<TransportState>) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/ws", get(web_socket_upgrade))
        .route("/student/", get(student_root))
        .route("/student/join/{join_code}", get(student_join_page))
        .route("/student/assets/{file_name}", get(student_asset))
        .route("/api/v1/session-assets/{asset_id}", get(session_asset))
        .route("/api/v1/join/{join_code}", get(join_info).post(join))
        .fallback(not_found)
        .layer(RequestBodyLimitLayer::new(MAX_HTTP_BODY_BYTES))
        .with_state(state)
}

async fn root() -> Response {
    let response = Html(
        "<!doctype html><html lang=\"zh-Hant\"><head><meta charset=\"utf-8\"><title>Classroom</title></head><body><main><h1>Classroom</h1><p>本機教室伺服器正在執行。</p></main></body></html>",
    )
    .into_response();
    with_static_security(response)
}

async fn student_root(State(state): State<Arc<TransportState>>) -> Response {
    student_html(&state)
}

async fn student_join_page(
    State(state): State<Arc<TransportState>>,
    Path(_join_code): Path<String>,
) -> Response {
    student_html(&state)
}

async fn student_asset(
    State(state): State<Arc<TransportState>>,
    Path(file_name): Path<String>,
) -> Response {
    match state.assets.asset(&file_name) {
        Ok(Some(contents)) => {
            let mut response = contents.into_response();
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, asset_content_type(&file_name));
            response.headers_mut().insert(
                "x-content-type-options",
                HeaderValue::from_static("nosniff"),
            );
            response.headers_mut().insert(
                "cache-control",
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            );
            response
        }
        Ok(None) => with_static_security((StatusCode::NOT_FOUND, "Not found.").into_response()),
        Err(_) => with_static_security(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Student application unavailable.",
            )
                .into_response(),
        ),
    }
}

fn student_html(state: &TransportState) -> Response {
    match state.assets.index_html() {
        Ok(contents) => {
            let mut response = contents.into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            );
            with_static_security(response)
        }
        Err(_) => with_static_security(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Student application unavailable.",
            )
                .into_response(),
        ),
    }
}

fn asset_content_type(file_name: &str) -> HeaderValue {
    let value = if file_name.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if file_name.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if file_name.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "application/octet-stream"
    };
    HeaderValue::from_static(value)
}

async fn join_info(
    State(state): State<Arc<TransportState>>,
    Path(join_code): Path<String>,
) -> Response {
    let session = Arc::clone(&state.session);
    let server_instance_id = state.server_instance_id.clone();
    match blocking(move || {
        session.public_join_info(&join_code, &server_instance_id, LOCAL_PROTOCOL_VERSION)
    })
    .await
    {
        Ok(info) => with_static_security(Json(info).into_response()),
        Err(AppError::SessionNotOpen) => public_error(
            StatusCode::CONFLICT,
            "SESSION_NOT_OPEN",
            "課堂目前未開放新加入。",
        ),
        Err(_) => public_error(
            StatusCode::NOT_FOUND,
            "JOIN_CODE_INVALID",
            "課堂代碼無效或課堂尚未開放。",
        ),
    }
}

async fn session_asset(
    State(state): State<Arc<TransportState>>,
    Path(asset_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some((session_id, participant_id, credential)) = asset_credentials(&headers) else {
        return with_static_security(
            (StatusCode::UNAUTHORIZED, "Authentication required.").into_response(),
        );
    };
    let session = Arc::clone(&state.session);
    let server_instance_id = state.server_instance_id.clone();
    let authentication_session_id = session_id.clone();
    let authenticated = blocking(move || {
        session.authenticate(
            &authentication_session_id,
            &participant_id,
            &credential,
            &server_instance_id,
        )
    })
    .await;
    if authenticated.is_err() {
        return with_static_security(
            (StatusCode::UNAUTHORIZED, "Authentication required.").into_response(),
        );
    }
    let quiz = Arc::clone(&state.quiz);
    match blocking(move || quiz.read_asset_for_session(&asset_id, &session_id)).await {
        Ok((bytes, mime_type)) => {
            let mut response = bytes.into_response();
            if let Ok(value) = HeaderValue::from_str(&mime_type) {
                response.headers_mut().insert(header::CONTENT_TYPE, value);
            }
            response.headers_mut().insert(
                "x-content-type-options",
                HeaderValue::from_static("nosniff"),
            );
            response
                .headers_mut()
                .insert("cache-control", HeaderValue::from_static("no-store"));
            response
        }
        Err(_) => with_static_security((StatusCode::NOT_FOUND, "Not found.").into_response()),
    }
}

fn asset_credentials(headers: &HeaderMap) -> Option<(String, String, String)> {
    let session_id = headers
        .get("x-classroom-session")?
        .to_str()
        .ok()?
        .to_owned();
    let participant_id = headers
        .get("x-classroom-participant")?
        .to_str()
        .ok()?
        .to_owned();
    let credential = headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")?
        .to_owned();
    Some((session_id, participant_id, credential))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JoinRequest {
    seat_number: i64,
    name: String,
}

async fn join(
    State(state): State<Arc<TransportState>>,
    ConnectInfo(source): ConnectInfo<SocketAddr>,
    Path(join_code): Path<String>,
    headers: HeaderMap,
    Json(request): Json<JoinRequest>,
) -> Response {
    if !origin_matches_host(&headers) {
        return public_error(
            StatusCode::FORBIDDEN,
            "ORIGIN_REJECTED",
            "無法完成加入請求。請從課堂網址重新開啟頁面。",
        );
    }
    let source_ip = source.ip();
    if !state.limiter.permits(source_ip) {
        return public_error(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "嘗試次數過多，請稍後再試。",
        );
    }
    let session = Arc::clone(&state.session);
    let server_instance_id = state.server_instance_id.clone();
    match blocking(move || {
        session.join(
            &join_code,
            request.seat_number,
            &request.name,
            &server_instance_id,
        )
    })
    .await
    {
        Ok(joined) => {
            state.limiter.success(source_ip);
            with_static_security(Json(joined).into_response())
        }
        Err(AppError::SeatAlreadyJoined) => {
            state.limiter.failure(source_ip);
            public_error(
                StatusCode::CONFLICT,
                "SEAT_ALREADY_JOINED",
                "這個座號已經加入課堂。",
            )
        }
        Err(AppError::SessionNotOpen) => {
            state.limiter.failure(source_ip);
            public_error(
                StatusCode::CONFLICT,
                "SESSION_NOT_OPEN",
                "課堂大廳尚未開放或已結束。",
            )
        }
        Err(AppError::ServerInstanceMismatch) => {
            state.limiter.failure(source_ip);
            public_error(
                StatusCode::CONFLICT,
                "SERVER_INSTANCE_MISMATCH",
                "課堂伺服器已更新，請重新整理頁面。",
            )
        }
        Err(_) => {
            state.limiter.failure(source_ip);
            public_error(
                StatusCode::UNAUTHORIZED,
                "IDENTITY_MISMATCH",
                "座號或姓名不正確。",
            )
        }
    }
}

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| AppError::Storage)?
}

fn public_error(status: StatusCode, code: &'static str, message: &'static str) -> Response {
    with_static_security((status, Json(PublicError { code, message })).into_response())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicError {
    code: &'static str,
    message: &'static str,
}

async fn health(State(state): State<Arc<TransportState>>) -> Response {
    with_static_security(
        Json(HealthResponse {
            status: "ok",
            protocol_version: LOCAL_PROTOCOL_VERSION,
            server_instance_id: state.server_instance_id.clone(),
        })
        .into_response(),
    )
}

async fn not_found() -> Response {
    let response = (StatusCode::NOT_FOUND, "Not found.").into_response();
    with_static_security(response)
}

async fn web_socket_upgrade(
    State(state): State<Arc<TransportState>>,
    headers: HeaderMap,
    web_socket: WebSocketUpgrade,
) -> Response {
    if !origin_matches_host(&headers) {
        return with_static_security(
            (StatusCode::FORBIDDEN, "WebSocket origin rejected.").into_response(),
        );
    }

    web_socket
        .max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state))
        .into_response()
}

async fn handle_socket(mut socket: WebSocket, state: Arc<TransportState>) {
    transport_debug("ws connection opened");
    if !send_server_message(
        &mut socket,
        &ServerMessage::ServerHello {
            protocol_version: LOCAL_PROTOCOL_VERSION,
            server_instance_id: state.server_instance_id.clone(),
        },
    )
    .await
    {
        transport_debug("server hello send failed");
        return;
    }
    transport_debug("server_hello sent");

    let authentication = tokio::time::timeout(
        AUTH_TIMEOUT,
        authenticate_socket(&mut socket, Arc::clone(&state)),
    )
    .await;
    let authenticated = match authentication {
        Ok(SocketAuthentication::Authenticated(value)) => value,
        Ok(SocketAuthentication::Rejected(code)) => {
            transport_debug("participant authentication rejected");
            let _ = send_transport_error(&mut socket, code).await;
            return;
        }
        Ok(SocketAuthentication::Disconnected) => {
            transport_debug("socket closed before authentication");
            return;
        }
        Err(_) => {
            transport_debug("participant authentication timed out");
            let _ = send_transport_error(&mut socket, "AUTH_TIMEOUT").await;
            return;
        }
    };
    let connection_id = authenticated.connection_id;
    transport_connection_debug(connection_id, "participant_authenticated");
    if authenticated.session_state == "ACTIVE" {
        let initial_sync = {
            let quiz = Arc::clone(&state.quiz);
            let participant_id = authenticated.participant_id.clone();
            let session_id = authenticated.session_id.clone();
            blocking(move || quiz.sync(&participant_id, &session_id, "ACTIVE")).await
        };
        match initial_sync {
            Ok(sync) => {
                if !send_server_message(
                    &mut socket,
                    &ServerMessage::SessionSync {
                        protocol_version: LOCAL_PROTOCOL_VERSION,
                        sync: Box::new(sync),
                    },
                )
                .await
                {
                    state
                        .presence
                        .disconnect(&authenticated.participant_id, connection_id);
                    return;
                }
            }
            Err(_) => {
                state
                    .presence
                    .disconnect(&authenticated.participant_id, connection_id);
                return;
            }
        }
    }
    transport_debug("presence lease created");
    let mut events = state.session.subscribe();
    let mut quiz_events = state.quiz.subscribe();
    let exit_reason = loop {
        tokio::select! {
            next = socket.recv() => {
                let Some(next) = next else { break "socket_receive_closed"; };
                if !handle_authenticated_socket_message(&mut socket, next, &state, &authenticated, connection_id).await { break "message_handler_stopped"; }
            }
            event = events.recv() => match event {
                Ok(event) => {
                    if !send_server_message(&mut socket, &ServerMessage::SessionStateChanged { protocol_version: LOCAL_PROTOCOL_VERSION, session_id: event.session_id, state: event.state }).await { break "session_event_send_failed"; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break "session_event_channel_closed",
            },
            event = quiz_events.recv() => match event {
                Ok(event) if event.session_id == authenticated.session_id => {
                    let quiz = Arc::clone(&state.quiz);
                    let participant_id = authenticated.participant_id.clone();
                    let session_id = authenticated.session_id.clone();
                    match blocking(move || quiz.sync(&participant_id, &session_id, "ACTIVE")).await {
                        Ok(sync) => if !send_quiz_sync(&mut socket, sync).await { break "quiz_sync_send_failed"; },
                        Err(_) => break "quiz_sync_failed",
                    }
                }
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break "quiz_event_channel_closed",
            },
        }
    };
    transport_connection_debug(connection_id, exit_reason);
    state
        .presence
        .disconnect(&authenticated.participant_id, connection_id);
    transport_connection_debug(connection_id, "socket_closed");
    transport_debug("presence lease removed; socket closed");
}

struct SocketParticipant {
    participant_id: String,
    session_id: String,
    session_state: String,
    connection_id: Uuid,
}
enum SocketAuthentication {
    Authenticated(SocketParticipant),
    Rejected(&'static str),
    Disconnected,
}

async fn authenticate_socket(
    socket: &mut WebSocket,
    state: Arc<TransportState>,
) -> SocketAuthentication {
    while let Some(next) = socket.recv().await {
        match next {
            Ok(Message::Text(text)) if text.len() <= MAX_MESSAGE_BYTES => {
                match parse_client_message(&text) {
                    Ok(ClientMessage::Ping { request_id, .. }) => {
                        if !send_server_message(
                            socket,
                            &ServerMessage::Pong {
                                protocol_version: LOCAL_PROTOCOL_VERSION,
                                request_id,
                            },
                        )
                        .await
                        {
                            return SocketAuthentication::Disconnected;
                        }
                    }
                    Ok(ClientMessage::ParticipantAuth {
                        session_id,
                        participant_id,
                        credential,
                        ..
                    }) => {
                        transport_debug("participant_auth received");
                        let session = Arc::clone(&state.session);
                        let server_instance_id = state.server_instance_id.clone();
                        let authentication_participant_id = participant_id.clone();
                        match blocking(move || {
                            session.authenticate(
                                &session_id,
                                &authentication_participant_id,
                                &credential,
                                &server_instance_id,
                            )
                        })
                        .await
                        {
                            Ok(authenticated) => {
                                let session_id = authenticated.participant.session_id.clone();
                                let session_state = authenticated.session_state.clone();
                                let authenticated_participant_id =
                                    authenticated.participant.participant_id.clone();
                                let connection_id =
                                    state.presence.connect(&authenticated_participant_id);
                                if !send_server_message(
                                    socket,
                                    &ServerMessage::ParticipantAuthenticated {
                                        protocol_version: LOCAL_PROTOCOL_VERSION,
                                        participant: authenticated.participant,
                                        classroom_name: authenticated.classroom_name,
                                        session_state: authenticated.session_state,
                                    },
                                )
                                .await
                                {
                                    state
                                        .presence
                                        .disconnect(&authenticated_participant_id, connection_id);
                                    return SocketAuthentication::Disconnected;
                                }
                                transport_debug("participant authentication succeeded");
                                return SocketAuthentication::Authenticated(SocketParticipant {
                                    participant_id: authenticated_participant_id,
                                    session_id,
                                    session_state,
                                    connection_id,
                                });
                            }
                            Err(error) => {
                                return SocketAuthentication::Rejected(authentication_error_code(
                                    &error,
                                ));
                            }
                        }
                    }
                    Ok(ClientMessage::SubmitAnswer { .. }) => {
                        return SocketAuthentication::Rejected("PROTOCOL_ERROR")
                    }
                    Err(()) => {
                        return SocketAuthentication::Rejected("PROTOCOL_ERROR");
                    }
                }
            }
            Ok(Message::Text(_)) | Ok(Message::Binary(_)) => {
                return SocketAuthentication::Rejected("PROTOCOL_ERROR");
            }
            Ok(Message::Close(_)) | Err(_) => return SocketAuthentication::Disconnected,
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
        }
    }
    SocketAuthentication::Disconnected
}

async fn handle_authenticated_socket_message(
    socket: &mut WebSocket,
    next: Result<Message, axum::Error>,
    state: &TransportState,
    participant: &SocketParticipant,
    connection_id: Uuid,
) -> bool {
    match next {
        Ok(Message::Text(text)) if text.len() <= MAX_MESSAGE_BYTES => {
            match parse_client_message(&text) {
                Ok(ClientMessage::Ping { request_id, .. }) => {
                    transport_connection_debug(connection_id, "ping_received");
                    state
                        .presence
                        .heartbeat(&participant.participant_id, connection_id);
                    send_server_message(
                        socket,
                        &ServerMessage::Pong {
                            protocol_version: LOCAL_PROTOCOL_VERSION,
                            request_id,
                        },
                    )
                    .await
                }
                Ok(ClientMessage::SubmitAnswer {
                    submission_id,
                    session_question_id,
                    answer,
                    ..
                }) => {
                    transport_connection_debug(connection_id, "SUBMIT_FRAME_RECEIVED");
                    let quiz = Arc::clone(&state.quiz);
                    let participant_id = participant.participant_id.clone();
                    let session_id = participant.session_id.clone();
                    transport_connection_debug(connection_id, "SUBMIT_SERVICE_ENTERED");
                    match blocking(move || {
                        quiz.submit(
                            participant_id,
                            session_id,
                            session_question_id,
                            submission_id,
                            answer,
                        )
                    })
                    .await
                    {
                        Ok(ack) => {
                            transport_connection_debug(connection_id, "SUBMIT_PERSISTED");
                            send_submission_acknowledgement(socket, connection_id, ack).await
                        }
                        Err(error) => {
                            transport_connection_debug(connection_id, "submission_rejected");
                            let sent =
                                send_transport_error(socket, submission_error_code(&error)).await;
                            transport_connection_debug(
                                connection_id,
                                if sent {
                                    "application_error_sent"
                                } else {
                                    "application_error_send_failed"
                                },
                            );
                            sent
                        }
                    }
                }
                _ => {
                    let _ = send_protocol_error(socket).await;
                    false
                }
            }
        }
        Ok(Message::Text(_)) | Ok(Message::Binary(_)) => {
            let _ = send_protocol_error(socket).await;
            false
        }
        Ok(Message::Close(_)) | Err(_) => false,
        Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => true,
    }
}

async fn send_quiz_sync(socket: &mut WebSocket, sync: SessionSyncDto) -> bool {
    let revealed = sync.reveal.is_some();
    if !send_server_message(
        socket,
        &ServerMessage::SessionSync {
            protocol_version: LOCAL_PROTOCOL_VERSION,
            sync: Box::new(sync.clone()),
        },
    )
    .await
    {
        return false;
    }
    if let Some(question) = sync.current_question {
        if !send_server_message(
            socket,
            &ServerMessage::QuestionStateChanged {
                protocol_version: LOCAL_PROTOCOL_VERSION,
                question,
            },
        )
        .await
        {
            return false;
        }
    }
    if let Some(reveal) = sync.reveal {
        if !send_server_message(
            socket,
            &ServerMessage::QuestionRevealed {
                protocol_version: LOCAL_PROTOCOL_VERSION,
                reveal,
            },
        )
        .await
        {
            return false;
        }
    }
    if let Some(result) = sync.own_latest_submission {
        if revealed
            && !send_server_message(
                socket,
                &ServerMessage::SubmissionResult {
                    protocol_version: LOCAL_PROTOCOL_VERSION,
                    result,
                },
            )
            .await
        {
            return false;
        }
    }
    true
}

async fn send_protocol_error(socket: &mut WebSocket) -> bool {
    send_server_message(
        socket,
        &ServerMessage::Error {
            protocol_version: LOCAL_PROTOCOL_VERSION,
            code: "PROTOCOL_ERROR",
            message: "The transport message is invalid.",
        },
    )
    .await
}

fn authentication_error_code(error: &AppError) -> &'static str {
    match error {
        AppError::ServerInstanceMismatch => "SERVER_INSTANCE_MISMATCH",
        AppError::SessionNotOpen => "SESSION_ENDED",
        _ => "AUTH_FAILED",
    }
}

fn submission_error_code(error: &AppError) -> &'static str {
    match error {
        AppError::QuestionLocked => "QUESTION_LOCKED",
        AppError::Conflict(_) => "SUBMISSION_CONFLICT",
        AppError::Validation(_) => "INVALID_ANSWER",
        _ => "PROTOCOL_ERROR",
    }
}

async fn send_transport_error(socket: &mut WebSocket, code: &'static str) -> bool {
    send_server_message(
        socket,
        &ServerMessage::Error {
            protocol_version: LOCAL_PROTOCOL_VERSION,
            code,
            message: "Participant authentication failed.",
        },
    )
    .await
}

async fn send_submission_acknowledgement(
    socket: &mut WebSocket,
    connection_id: Uuid,
    acknowledgement: SubmissionAckDto,
) -> bool {
    let message = ServerMessage::SubmissionAcknowledged {
        protocol_version: LOCAL_PROTOCOL_VERSION,
        acknowledgement,
    };
    let serialized = match serde_json::to_string(&message) {
        Ok(value) => {
            transport_connection_debug(connection_id, "submission_acknowledgement_serialized");
            value
        }
        Err(_) => {
            transport_connection_debug(
                connection_id,
                "submission_acknowledgement_serialize_failed",
            );
            return false;
        }
    };
    let sent = socket.send(Message::Text(serialized.into())).await.is_ok();
    transport_connection_debug(
        connection_id,
        if sent {
            "SUBMIT_ACK_SENT"
        } else {
            "submission_acknowledgement_send_failed"
        },
    );
    sent
}

async fn send_server_message(socket: &mut WebSocket, message: &ServerMessage) -> bool {
    let serialized = match serde_json::to_string(message) {
        Ok(value) => value,
        Err(_) => return false,
    };
    socket.send(Message::Text(serialized.into())).await.is_ok()
}

fn parse_client_message(text: &str) -> Result<ClientMessage, ()> {
    let message: ClientMessage = serde_json::from_str(text).map_err(|_| ())?;
    match &message {
        ClientMessage::Ping {
            protocol_version,
            request_id,
        } if *protocol_version == LOCAL_PROTOCOL_VERSION
            && !request_id.trim().is_empty()
            && request_id.len() <= 120 =>
        {
            Ok(message)
        }
        ClientMessage::ParticipantAuth {
            protocol_version,
            request_id,
            session_id,
            participant_id,
            credential,
        } if *protocol_version == LOCAL_PROTOCOL_VERSION
            && !request_id.trim().is_empty()
            && request_id.len() <= 120
            && Uuid::parse_str(session_id).is_ok()
            && Uuid::parse_str(participant_id).is_ok()
            && credential.len() == 43
            && credential
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') =>
        {
            Ok(message)
        }
        ClientMessage::SubmitAnswer {
            protocol_version,
            request_id,
            submission_id,
            session_question_id,
            ..
        } if *protocol_version == LOCAL_PROTOCOL_VERSION
            && !request_id.trim().is_empty()
            && request_id.len() <= 120
            && Uuid::parse_str(submission_id).is_ok()
            && Uuid::parse_str(session_question_id).is_ok() =>
        {
            Ok(message)
        }
        _ => Err(()),
    }
}

fn origin_matches_host(headers: &HeaderMap) -> bool {
    let origin = match headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        Some(value) => value,
        None => return false,
    };
    let host = match headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    {
        Some(value) => value,
        None => return false,
    };
    let origin = match origin.parse::<Uri>() {
        Ok(value) => value,
        Err(_) => return false,
    };
    origin.scheme_str() == Some("http")
        && origin.path() == "/"
        && origin
            .authority()
            .is_some_and(|authority| authority.as_str().eq_ignore_ascii_case(host))
}

fn with_static_security(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    response
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    protocol_version: u8,
    server_instance_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum ClientMessage {
    Ping {
        protocol_version: u8,
        request_id: String,
    },
    ParticipantAuth {
        protocol_version: u8,
        request_id: String,
        session_id: String,
        participant_id: String,
        credential: String,
    },
    SubmitAnswer {
        protocol_version: u8,
        request_id: String,
        submission_id: String,
        session_question_id: String,
        answer: StudentAnswer,
    },
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum ServerMessage {
    ServerHello {
        protocol_version: u8,
        server_instance_id: String,
    },
    Pong {
        protocol_version: u8,
        request_id: String,
    },
    ParticipantAuthenticated {
        protocol_version: u8,
        participant: crate::application::ParticipantSelfView,
        classroom_name: String,
        session_state: String,
    },
    SessionStateChanged {
        protocol_version: u8,
        session_id: String,
        state: String,
    },
    SessionSync {
        protocol_version: u8,
        sync: Box<SessionSyncDto>,
    },
    QuestionStateChanged {
        protocol_version: u8,
        question: QuestionPublicView,
    },
    QuestionRevealed {
        protocol_version: u8,
        reveal: QuestionRevealView,
    },
    SubmissionAcknowledged {
        protocol_version: u8,
        acknowledgement: SubmissionAckDto,
    },
    SubmissionResult {
        protocol_version: u8,
        result: crate::application::OwnSubmissionResultDto,
    },
    Error {
        protocol_version: u8,
        code: &'static str,
        message: &'static str,
    },
}

async fn run_server(
    listener: TcpListener,
    router: Router,
    shutdown_receiver: oneshot::Receiver<()>,
    lifecycle: Arc<Mutex<ServerLifecycle>>,
    server_instance_id: String,
) {
    let result = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = shutdown_receiver.await;
    })
    .await;
    if result.is_err() {
        eprintln!("Local server terminated unexpectedly.");
    }
    if let Ok(mut lifecycle) = lifecycle.lock() {
        match &*lifecycle {
            ServerLifecycle::Running(server)
                if server.details.server_instance_id == server_instance_id =>
            {
                *lifecycle = ServerLifecycle::Stopped;
            }
            ServerLifecycle::Stopping(Some(details))
                if details.server_instance_id == server_instance_id =>
            {
                *lifecycle = ServerLifecycle::Stopped;
            }
            _ => {}
        }
    }
    eprintln!("Local server stopped.");
}

fn discover_candidate_urls(port: u16) -> Vec<String> {
    let interfaces = match NetworkInterface::show() {
        Ok(interfaces) => interfaces,
        Err(_) => {
            eprintln!("Local server interface discovery unavailable.");
            return Vec::new();
        }
    };
    let mut addresses = interfaces
        .iter()
        .filter(|interface| !interface.internal)
        .flat_map(|interface| interface.addr.iter())
        .filter_map(|address| match address {
            Addr::V4(address) => Some(address.ip),
            Addr::V6(_) => None,
        })
        .filter(|address| {
            !address.is_loopback()
                && !address.is_unspecified()
                && !address.is_multicast()
                && *address != Ipv4Addr::BROADCAST
        })
        .collect::<Vec<_>>();
    addresses.sort_by_key(classify_ipv4_address);
    addresses.dedup();
    addresses
        .into_iter()
        .map(|address| format!("http://{address}:{port}"))
        .collect()
}

fn classify_ipv4_address(address: &Ipv4Addr) -> u8 {
    if address.is_private() {
        0
    } else if address.is_link_local() {
        1
    } else {
        2
    }
}

fn local_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn web_socket_urls(port: u16, candidate_urls: &[String]) -> Vec<String> {
    let mut urls = vec![format!("ws://127.0.0.1:{port}/ws")];
    urls.extend(
        candidate_urls
            .iter()
            .map(|url| format!("{}/ws", url.replacen("http://", "ws://", 1))),
    );
    urls
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    use futures_util::{SinkExt, StreamExt};
    use serde::Deserialize;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue};
    use tokio_tungstenite::{connect_async, tungstenite::Message as ClientWebSocketMessage};

    use super::*;

    type TestSocket = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    fn test_presence_clock() -> (Arc<AtomicU64>, PresenceClock) {
        let milliseconds = Arc::new(AtomicU64::new(0));
        let clock_milliseconds = Arc::clone(&milliseconds);
        (
            milliseconds,
            Arc::new(move || Duration::from_millis(clock_milliseconds.load(Ordering::Relaxed))),
        )
    }

    fn test_service() -> LocalServerService {
        test_service_with_roster().0
    }

    fn test_service_with_roster() -> (LocalServerService, String) {
        let directory = tempfile::tempdir().expect("test directory").keep();
        std::fs::create_dir_all(directory.join("student/assets"))
            .expect("student assets directory");
        std::fs::write(directory.join("student/index.html"), "<main>student</main>")
            .expect("student index");
        std::fs::write(
            directory.join("student/assets/app-test.js"),
            "console.log('student')",
        )
        .expect("student asset");
        let database = crate::infrastructure::persistence::database::Database::open(
            directory.join("classroom.sqlite3"),
        );
        database.initialize().expect("database");
        let classroom =
            crate::infrastructure::persistence::repositories::ClassroomRepository::create(
                &database,
                crate::infrastructure::persistence::repositories::NewClassroom {
                    name: "3A".to_owned(),
                    academic_year: None,
                },
            )
            .expect("classroom");
        crate::infrastructure::persistence::repositories::StudentRepository::create(
            &database,
            crate::infrastructure::persistence::repositories::NewStudent {
                class_id: classroom.id.clone(),
                seat_number: 12,
                name: "王小明".to_owned(),
            },
        )
        .expect("student");
        let quiz = LiveQuizService::initialize(database.clone(), &directory).expect("quiz service");
        let session = LocalSessionService::initialize(database).expect("session service");
        (
            LocalServerService::new(
                session,
                quiz,
                StudentAssetLocation::from_root(directory.join("student")),
            ),
            classroom.id,
        )
    }

    fn test_service_with_roster_and_question() -> (LocalServerService, String, String) {
        let directory = tempfile::tempdir().expect("test directory").keep();
        std::fs::create_dir_all(directory.join("student/assets"))
            .expect("student assets directory");
        std::fs::write(directory.join("student/index.html"), "<main>student</main>")
            .expect("student index");
        let database = crate::infrastructure::persistence::database::Database::open(
            directory.join("classroom.sqlite3"),
        );
        database.initialize().expect("database");
        let classroom =
            crate::infrastructure::persistence::repositories::ClassroomRepository::create(
                &database,
                crate::infrastructure::persistence::repositories::NewClassroom {
                    name: "3A".to_owned(),
                    academic_year: None,
                },
            )
            .expect("classroom");
        crate::infrastructure::persistence::repositories::StudentRepository::create(
            &database,
            crate::infrastructure::persistence::repositories::NewStudent {
                class_id: classroom.id.clone(),
                seat_number: 12,
                name: "王小明".to_owned(),
            },
        )
        .expect("student");
        let set = crate::infrastructure::persistence::repositories::QuestionSetRepository::create(
            &database,
            crate::infrastructure::persistence::repositories::NewQuestionSet {
                lesson_id: None,
                title: "Live quiz".to_owned(),
                description: None,
            },
        )
        .expect("question set");
        let question =
            crate::infrastructure::persistence::repositories::QuestionRepository::create(
                &database,
                crate::infrastructure::persistence::repositories::NewQuestion {
                    question_set_id: set.id,
                    question_type: "true_false".to_owned(),
                    prompt: "地球是圓的。".to_owned(),
                    points: 1,
                    position: 0,
                    answer_config: serde_json::json!({"correctAnswer": true}),
                    grading_config: serde_json::json!({}),
                    metadata: serde_json::json!({}),
                },
            )
            .expect("question");
        let quiz = LiveQuizService::initialize(database.clone(), &directory).expect("quiz service");
        let session = LocalSessionService::initialize(database).expect("session service");
        (
            LocalServerService::new(
                session,
                quiz,
                StudentAssetLocation::from_root(directory.join("student")),
            ),
            classroom.id,
            question.id,
        )
    }

    #[tokio::test]
    async fn http_endpoints_are_narrow_and_safe() {
        let service = test_service();
        let status = service
            .start_on(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), false)
            .await
            .expect("server starts");
        let port = status.port.expect("port");

        let root = http_get(port, "/").await;
        assert!(root.starts_with("http/1.1 200"), "{root}");
        assert!(root.contains("classroom"));
        assert!(root.contains("x-content-type-options: nosniff"));
        assert!(root.contains("cache-control: no-store"));

        let health = http_get(port, "/health").await;
        assert!(health.starts_with("http/1.1 200"));
        assert!(health.contains("\"status\":\"ok\""));
        assert!(health.contains("\"protocolversion\":1"));
        assert!(!health.contains("sqlite"));
        assert!(!health.contains("c:\\\\"));

        let unknown = http_get(port, "/not-a-route").await;
        assert!(unknown.starts_with("http/1.1 404"));
        let traversal = http_get(port, "/assets/not-available").await;
        assert!(traversal.starts_with("http/1.1 404"));
        let oversized = http_oversized_request(port).await;
        assert!(oversized.starts_with("http/1.1 413"));
        let student = http_get(port, "/student/").await;
        assert!(student.starts_with("http/1.1 200"));
        assert!(student.contains("<main>student</main>"));
        let asset = http_get(port, "/student/assets/app-test.js").await;
        assert!(asset.starts_with("http/1.1 200"));
        assert!(asset.contains("console.log"));
        assert!(http_get(port, "/student/assets/missing.js")
            .await
            .starts_with("http/1.1 404"));

        service.stop().await.expect("server stops");
    }

    #[tokio::test]
    async fn websocket_handshake_ping_and_protocol_errors_are_safe() {
        let service = test_service();
        let status = service
            .start_on(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), false)
            .await
            .expect("server starts");
        let port = status.port.expect("port");
        let (mut socket, _) = connect_same_origin(port).await;

        let hello = receive_text(&mut socket).await;
        assert_server_hello(
            &hello,
            status.server_instance_id.as_deref().expect("server id"),
        );

        socket
            .send(ClientWebSocketMessage::Text(
                "{\"protocolVersion\":1,\"type\":\"ping\",\"requestId\":\"request-7\"}".into(),
            ))
            .await
            .expect("ping sends");
        let pong = receive_text(&mut socket).await;
        assert!(pong.contains("\"type\":\"pong\""));
        assert!(pong.contains("\"requestId\":\"request-7\""));

        socket
            .send(ClientWebSocketMessage::Text("{invalid".into()))
            .await
            .expect("malformed payload sends");
        assert_protocol_error(&receive_text(&mut socket).await);

        service.stop().await.expect("server stops");
    }

    #[tokio::test]
    async fn websocket_submit_answer_matches_frontend_wire_and_updates_teacher_progress() {
        let (service, classroom_id, source_question_id) = test_service_with_roster_and_question();
        let status = service
            .start_on(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), false)
            .await
            .expect("server starts");
        let port = status.port.expect("port");
        let server_id = status.server_instance_id.clone().expect("server id");
        let session = service
            .session
            .create(classroom_id, server_id.clone())
            .expect("session");
        let lobby = service
            .session
            .open_lobby(session.id, server_id.clone())
            .expect("lobby");
        let joined = http_join(port, &lobby.join_code, 12, "王小明").await;
        service
            .session
            .start(lobby.id.clone(), server_id)
            .expect("session starts");
        let snapshot = service
            .quiz
            .publish(lobby.id.clone(), source_question_id)
            .expect("question publishes");
        let opened = service.quiz.open(snapshot.id).expect("question opens");

        let (mut socket, _) = connect_same_origin(port).await;
        assert_server_hello(
            &receive_text(&mut socket).await,
            status.server_instance_id.as_deref().expect("server id"),
        );
        socket
            .send(ClientWebSocketMessage::Text(
                format!("{{\"protocolVersion\":1,\"type\":\"participant_auth\",\"requestId\":\"auth-live-1\",\"sessionId\":\"{}\",\"participantId\":\"{}\",\"credential\":\"{}\"}}", joined.session_id, joined.participant_id, joined.credential).into(),
            ))
            .await
            .expect("auth sends");
        assert!(receive_text(&mut socket)
            .await
            .contains("participant_authenticated"));
        let sync = receive_text(&mut socket).await;
        assert!(sync.contains("\"type\":\"session_sync\""));
        assert!(sync.contains("\"sessionQuestionId\""));
        assert!(sync.contains("\"state\":\"OPEN\""));

        let submission_id = Uuid::now_v7().to_string();
        let session_question_id = opened.id.clone();
        let submit = serde_json::json!({
            "protocolVersion": 1,
            "type": "submit_answer",
            "requestId": "request-live-submit-1",
            "submissionId": submission_id.clone(),
            "sessionQuestionId": session_question_id,
            "answer": {"type": "true_false", "value": true}
        });
        assert!(parse_client_message(&submit.to_string()).is_ok());
        socket
            .send(ClientWebSocketMessage::Text(submit.to_string().into()))
            .await
            .expect("answer sends");
        let acknowledgement = receive_text(&mut socket).await;
        assert!(acknowledgement.contains("\"type\":\"submission_acknowledged\""));
        assert!(acknowledgement.contains(&format!("\"submissionId\":\"{submission_id}\"")));
        assert!(acknowledgement.contains("\"accepted\":true"));
        assert!(acknowledgement.contains("\"gradingStatus\":\"graded\""));
        let acknowledgement_json: serde_json::Value =
            serde_json::from_str(&acknowledgement).expect("acknowledgement json");
        assert_eq!(acknowledgement_json["protocolVersion"], 1);
        assert_eq!(
            acknowledgement_json["acknowledgement"]["sessionQuestionId"],
            opened.id
        );
        assert!(acknowledgement_json["acknowledgement"]["submittedAt"]
            .as_str()
            .is_some_and(|value| {
                time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
                    .is_ok()
                    && value.ends_with('Z')
            }));
        socket
            .send(ClientWebSocketMessage::Text(
                "{\"protocolVersion\":1,\"type\":\"ping\",\"requestId\":\"after-ack\"}".into(),
            ))
            .await
            .expect("post-ack ping sends");
        assert!(receive_until(&mut socket, "\"type\":\"pong\"")
            .await
            .contains("after-ack"));

        let invalid_submission = serde_json::json!({
            "protocolVersion": 1,
            "type": "submit_answer",
            "requestId": "request-live-invalid",
            "submissionId": Uuid::now_v7().to_string(),
            "sessionQuestionId": opened.id.clone(),
            "answer": {"type": "essay", "text": "invalid for true false"}
        });
        socket
            .send(ClientWebSocketMessage::Text(
                invalid_submission.to_string().into(),
            ))
            .await
            .expect("invalid answer sends");
        assert!(receive_until(&mut socket, "\"code\":\"INVALID_ANSWER\"")
            .await
            .contains("error"));
        socket
            .send(ClientWebSocketMessage::Text(
                "{\"protocolVersion\":1,\"type\":\"ping\",\"requestId\":\"after-invalid\"}".into(),
            ))
            .await
            .expect("post-invalid ping sends");
        assert!(receive_until(&mut socket, "\"type\":\"pong\"")
            .await
            .contains("after-invalid"));

        let conflicting_submission = serde_json::json!({
            "protocolVersion": 1,
            "type": "submit_answer",
            "requestId": "request-live-conflict",
            "submissionId": submission_id.clone(),
            "sessionQuestionId": opened.id.clone(),
            "answer": {"type": "true_false", "value": false}
        });
        socket
            .send(ClientWebSocketMessage::Text(
                conflicting_submission.to_string().into(),
            ))
            .await
            .expect("conflicting answer sends");
        assert!(
            receive_until(&mut socket, "\"code\":\"SUBMISSION_CONFLICT\"")
                .await
                .contains("error")
        );
        socket
            .send(ClientWebSocketMessage::Text(
                "{\"protocolVersion\":1,\"type\":\"ping\",\"requestId\":\"after-conflict\"}".into(),
            ))
            .await
            .expect("post-conflict ping sends");
        assert!(receive_until(&mut socket, "\"type\":\"pong\"")
            .await
            .contains("after-conflict"));

        let progress = service
            .quiz
            .teacher_progress(opened.id.clone(), 1)
            .expect("progress");
        assert_eq!(progress.answered_count, 1);
        assert_eq!(progress.participant_count, 1);
        let revision_two_id = Uuid::now_v7().to_string();
        let revision_two = serde_json::json!({
            "protocolVersion": 1,
            "type": "submit_answer",
            "requestId": "request-live-submit-2",
            "submissionId": revision_two_id,
            "sessionQuestionId": opened.id.clone(),
            "answer": {"type": "true_false", "value": false}
        });
        socket
            .send(ClientWebSocketMessage::Text(
                revision_two.to_string().into(),
            ))
            .await
            .expect("revision sends");
        let revision_acknowledgement = receive_text(&mut socket).await;
        assert!(revision_acknowledgement.contains("\"type\":\"submission_acknowledged\""));
        let revision_progress = service
            .quiz
            .teacher_progress(opened.id.clone(), 1)
            .expect("revision progress");
        assert_eq!(revision_progress.answered_count, 1);
        assert_eq!(revision_progress.participant_count, 1);
        service
            .quiz
            .lock(opened.id.clone())
            .expect("question locks");
        let locked_submission = serde_json::json!({
            "protocolVersion": 1,
            "type": "submit_answer",
            "requestId": "request-live-locked",
            "submissionId": Uuid::now_v7().to_string(),
            "sessionQuestionId": opened.id.clone(),
            "answer": {"type": "true_false", "value": true}
        });
        socket
            .send(ClientWebSocketMessage::Text(
                locked_submission.to_string().into(),
            ))
            .await
            .expect("locked answer sends");
        assert!(receive_until(&mut socket, "\"code\":\"QUESTION_LOCKED\"")
            .await
            .contains("error"));
        socket
            .send(ClientWebSocketMessage::Text(
                "{\"protocolVersion\":1,\"type\":\"ping\",\"requestId\":\"after-locked\"}".into(),
            ))
            .await
            .expect("post-locked ping sends");
        assert!(receive_until(&mut socket, "\"type\":\"pong\"")
            .await
            .contains("after-locked"));
        let sync = service
            .quiz
            .sync(&joined.participant_id, &lobby.id, "ACTIVE")
            .expect("student sync");
        assert_eq!(sync.own_latest_submission.expect("submission").revision, 2);
        service
            .session
            .end(lobby.id, "teacher_ended")
            .expect("session ends");
        service.stop().await.expect("server stops");
    }

    #[tokio::test]
    async fn websocket_rejects_unknown_protocol_binary_and_foreign_origin() {
        let service = test_service();
        let status = service
            .start_on(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), false)
            .await
            .expect("server starts");
        let port = status.port.expect("port");

        let foreign = web_socket_request(port, "http://example.invalid");
        assert!(connect_async(foreign).await.is_err());

        let (mut socket, _) = connect_same_origin(port).await;
        let _ = receive_text(&mut socket).await;
        socket
            .send(ClientWebSocketMessage::Text(
                "{\"protocolVersion\":9,\"type\":\"ping\",\"requestId\":\"wrong-version\"}".into(),
            ))
            .await
            .expect("unsupported protocol sends");
        assert_protocol_error(&receive_text(&mut socket).await);

        let (mut binary_socket, _) = connect_same_origin(port).await;
        let _ = receive_text(&mut binary_socket).await;
        binary_socket
            .send(ClientWebSocketMessage::Binary(vec![1, 2, 3].into()))
            .await
            .expect("binary payload sends");
        assert_protocol_error(&receive_text(&mut binary_socket).await);

        service.stop().await.expect("server stops");
    }

    #[tokio::test]
    async fn multiple_clients_and_lifecycle_are_idempotent() {
        let service = test_service();
        let first = service
            .start_on(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), false)
            .await
            .expect("server starts");
        let port = first.port.expect("port");
        let duplicate = service.start().await.expect("duplicate start");
        assert_eq!(duplicate.server_instance_id, first.server_instance_id);
        assert_eq!(duplicate.port, first.port);

        let mut clients = Vec::new();
        for index in 0..10 {
            clients.push(tokio::spawn(async move {
                let (mut socket, _) = connect_same_origin(port).await;
                let _ = receive_text(&mut socket).await;
                socket
                    .send(ClientWebSocketMessage::Text(
                        format!("{{\"protocolVersion\":1,\"type\":\"ping\",\"requestId\":\"client-{index}\"}}").into(),
                    ))
                    .await
                    .expect("ping sends");
                let pong = receive_text(&mut socket).await;
                assert!(pong.contains(&format!("client-{index}")));
                socket.close(None).await.expect("socket closes");
            }));
        }
        for client in clients {
            client.await.expect("client task");
        }

        let stopped = service.stop().await.expect("server stops");
        assert!(!stopped.running);
        assert_eq!(stopped.lifecycle_state, LocalServerLifecycleState::Stopped);
        let probe = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
            .await
            .expect("port released");
        drop(probe);
        assert!(!service.stop().await.expect("duplicate stop").running);

        let restarted = service
            .start_on(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), false)
            .await
            .expect("server restarts");
        assert_ne!(restarted.server_instance_id, first.server_instance_id);
        service.stop().await.expect("server stops after restart");
    }

    #[tokio::test]
    async fn normal_stop_requires_ending_lobby_or_active_session() {
        let (service, classroom_id) = test_service_with_roster();
        let status = service
            .start_on(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), false)
            .await
            .expect("server starts");
        let server_id = status.server_instance_id.clone().expect("server id");
        let created = service
            .session
            .create(classroom_id, server_id.clone())
            .expect("session creates");
        let lobby = service
            .session
            .open_lobby(created.id, server_id.clone())
            .expect("lobby opens");

        assert!(matches!(service.stop().await, Err(AppError::Conflict(_))));
        assert!(
            service
                .status()
                .expect("status after lobby stop rejection")
                .running
        );

        let active = service
            .session
            .start(lobby.id.clone(), server_id)
            .expect("session starts");
        assert_eq!(active.state, "ACTIVE");
        assert!(matches!(service.stop().await, Err(AppError::Conflict(_))));
        assert!(
            service
                .status()
                .expect("status after active stop rejection")
                .running
        );

        service
            .session
            .end(lobby.id, "teacher_ended")
            .expect("session ends");
        assert!(
            !service
                .stop()
                .await
                .expect("server stops after end")
                .running
        );
    }

    #[test]
    fn presence_uses_recent_connection_leases_instead_of_socket_counts() {
        let (milliseconds, clock) = test_presence_clock();
        let presence = PresenceRegistry::with_clock(clock);
        let participant_id = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
        let first_connection = Uuid::now_v7();
        let second_connection = Uuid::now_v7();

        presence.connect_with_id(participant_id, first_connection);
        assert!(presence.is_online(participant_id));

        milliseconds.store(6_000, Ordering::Relaxed);
        presence.heartbeat(participant_id, first_connection);
        milliseconds.store(12_999, Ordering::Relaxed);
        assert!(presence.is_online(participant_id));

        milliseconds.store(13_001, Ordering::Relaxed);
        assert!(!presence.is_online(participant_id));

        presence.connect_with_id(participant_id, first_connection);
        presence.connect_with_id(participant_id, second_connection);
        milliseconds.store(20_002, Ordering::Relaxed);
        presence.heartbeat(participant_id, second_connection);
        assert!(presence.is_online(participant_id));

        milliseconds.store(27_003, Ordering::Relaxed);
        assert!(!presence.is_online(participant_id));

        presence.connect_with_id(participant_id, first_connection);
        assert!(presence.is_online(participant_id));
        presence.disconnect(participant_id, first_connection);
        assert!(!presence.is_online(participant_id));
    }

    #[tokio::test]
    async fn stale_presence_lease_expires_and_reauthentication_restores_teacher_online() {
        let (mut service, classroom_id) = test_service_with_roster();
        let (milliseconds, clock) = test_presence_clock();
        service.presence = PresenceRegistry::with_clock(clock);
        let status = service
            .start_on(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), false)
            .await
            .expect("server starts");
        let port = status.port.expect("port");
        let server_id = status.server_instance_id.clone().expect("server id");
        let session = service
            .session
            .create(classroom_id, server_id.clone())
            .expect("session");
        let session = service
            .session
            .open_lobby(session.id, server_id)
            .expect("lobby");
        let joined = http_join(port, &session.join_code, 12, "王小明").await;

        let (mut socket, _) = connect_same_origin(port).await;
        let _ = receive_text(&mut socket).await;
        socket
            .send(ClientWebSocketMessage::Text(
                format!("{{\"protocolVersion\":1,\"type\":\"participant_auth\",\"requestId\":\"auth-1\",\"sessionId\":\"{}\",\"participantId\":\"{}\",\"credential\":\"{}\"}}", joined.session_id, joined.participant_id, joined.credential).into(),
            ))
            .await
            .expect("auth sends");
        assert!(receive_text(&mut socket)
            .await
            .contains("participant_authenticated"));
        assert!(teacher_participants(&service, &session.id)[0].online);

        milliseconds.store(6_000, Ordering::Relaxed);
        socket
            .send(ClientWebSocketMessage::Text(
                "{\"protocolVersion\":1,\"type\":\"ping\",\"requestId\":\"heartbeat-1\"}".into(),
            ))
            .await
            .expect("heartbeat sends");
        assert!(receive_text(&mut socket)
            .await
            .contains("\"type\":\"pong\""));

        milliseconds.store(12_999, Ordering::Relaxed);
        assert!(teacher_participants(&service, &session.id)[0].online);

        milliseconds.store(13_001, Ordering::Relaxed);
        assert!(!teacher_participants(&service, &session.id)[0].online);

        let (mut reconnected, _) = connect_same_origin(port).await;
        let _ = receive_text(&mut reconnected).await;
        reconnected
            .send(ClientWebSocketMessage::Text(
                format!("{{\"protocolVersion\":1,\"type\":\"participant_auth\",\"requestId\":\"auth-2\",\"sessionId\":\"{}\",\"participantId\":\"{}\",\"credential\":\"{}\"}}", joined.session_id, joined.participant_id, joined.credential).into(),
            ))
            .await
            .expect("reconnect auth sends");
        assert!(receive_text(&mut reconnected)
            .await
            .contains("participant_authenticated"));
        assert!(teacher_participants(&service, &session.id)[0].online);

        reconnected
            .close(None)
            .await
            .expect("reconnected socket closes");
        socket.close(None).await.expect("stale socket closes");
        service
            .session
            .end(session.id, "teacher_ended")
            .expect("session ends");
        service.stop().await.expect("server stops");
    }

    #[tokio::test]
    async fn join_http_websocket_auth_presence_and_end_broadcast_are_safe() {
        let (service, classroom_id) = test_service_with_roster();
        let status = service
            .start_on(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), false)
            .await
            .expect("server starts");
        let port = status.port.expect("port");
        let server_id = status.server_instance_id.clone().expect("server id");
        let session = service
            .session
            .create(classroom_id, server_id.clone())
            .expect("session");
        let session = service
            .session
            .open_lobby(session.id, server_id.clone())
            .expect("lobby");
        let join_info = http_get(port, &format!("/api/v1/join/{}", session.join_code)).await;
        assert!(join_info.starts_with("http/1.1 200"));
        assert!(!join_info.contains("王小明"));
        let joined = http_join(port, &session.join_code, 12, "王小明").await;
        let (mut socket, _) = connect_same_origin(port).await;
        let _ = receive_text(&mut socket).await;
        socket.send(ClientWebSocketMessage::Text(format!("{{\"protocolVersion\":1,\"type\":\"participant_auth\",\"requestId\":\"auth-1\",\"sessionId\":\"{}\",\"participantId\":\"{}\",\"credential\":\"{}\"}}", joined.session_id, joined.participant_id, joined.credential).into())).await.expect("auth sends");
        let authenticated = receive_text(&mut socket).await;
        assert!(authenticated.contains("participant_authenticated"));
        assert!(service.is_participant_online(&joined.participant_id));
        assert!(teacher_participants(&service, &session.id)[0].online);

        socket.close(None).await.expect("socket closes");
        drop(socket);
        wait_for_presence(&service, &joined.participant_id, false).await;
        assert!(!teacher_participants(&service, &session.id)[0].online);

        let (mut reconnected, _) = connect_same_origin(port).await;
        let _ = receive_text(&mut reconnected).await;
        reconnected.send(ClientWebSocketMessage::Text(format!("{{\"protocolVersion\":1,\"type\":\"participant_auth\",\"requestId\":\"auth-2\",\"sessionId\":\"{}\",\"participantId\":\"{}\",\"credential\":\"{}\"}}", joined.session_id, joined.participant_id, joined.credential).into())).await.expect("reconnect auth sends");
        assert!(receive_text(&mut reconnected)
            .await
            .contains("participant_authenticated"));
        assert!(service.is_participant_online(&joined.participant_id));

        service
            .session
            .end(session.id, "teacher_ended")
            .expect("end");
        let ended = receive_text(&mut reconnected).await;
        assert!(ended.contains("session_state_changed"));
        assert!(ended.contains("ENDED"));
        reconnected.close(None).await.expect("close");
        drop(reconnected);
        wait_for_presence(&service, &joined.participant_id, false).await;

        let (mut expired, _) = connect_same_origin(port).await;
        let _ = receive_text(&mut expired).await;
        expired.send(ClientWebSocketMessage::Text(format!("{{\"protocolVersion\":1,\"type\":\"participant_auth\",\"requestId\":\"auth-3\",\"sessionId\":\"{}\",\"participantId\":\"{}\",\"credential\":\"{}\"}}", joined.session_id, joined.participant_id, joined.credential).into())).await.expect("expired auth sends");
        assert!(receive_text(&mut expired)
            .await
            .contains("\"code\":\"SESSION_ENDED\""));
        service.stop().await.expect("server stops");
    }

    #[tokio::test]
    async fn active_session_join_info_reports_no_new_join() {
        let (service, classroom_id) = test_service_with_roster();
        let status = service
            .start_on(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), false)
            .await
            .expect("server starts");
        let port = status.port.expect("port");
        let server_id = status.server_instance_id.clone().expect("server id");
        let session = service
            .session
            .create(classroom_id, server_id.clone())
            .expect("session creates");
        let session = service
            .session
            .open_lobby(session.id, server_id.clone())
            .expect("lobby opens");
        service
            .session
            .start(session.id.clone(), server_id)
            .expect("session starts");

        let response = http_raw_request(
            port,
            format!(
                "GET /api/v1/join/{} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n",
                session.join_code
            ),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 409"), "{response}");
        assert!(
            response.contains("\"code\":\"SESSION_NOT_OPEN\""),
            "{response}"
        );
        assert!(!response.contains("JOIN_CODE_INVALID"), "{response}");

        service
            .session
            .end(session.id, "teacher_ended")
            .expect("session ends");
        service.stop().await.expect("server stops");
    }

    #[test]
    fn protocol_fixture_and_network_classification_match_the_contract() {
        let fixtures: ProtocolFixtures = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/backend-contract/test-vectors/local-protocol-vectors.json"
        )))
        .expect("protocol fixtures");
        for message in fixtures.valid_client_messages {
            assert!(parse_client_message(&message.to_string()).is_ok());
        }
        for fixture in fixtures.invalid_client_messages {
            assert!(parse_client_message(&fixture.message.to_string()).is_err());
        }
        assert_eq!(classify_ipv4_address(&Ipv4Addr::new(192, 168, 1, 5)), 0);
        assert_eq!(
            classify_ipv4_address(&Ipv4Addr::from_str("169.254.1.5").expect("ip")),
            1
        );
        assert_eq!(classify_ipv4_address(&Ipv4Addr::new(8, 8, 8, 8)), 2);
    }

    async fn http_get(port: u16, path: &str) -> String {
        http_request(
            port,
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"),
        )
        .await
    }

    async fn http_join(port: u16, join_code: &str, seat_number: i64, name: &str) -> JoinResponse {
        let body = format!("{{\"seatNumber\":{seat_number},\"name\":\"{name}\"}}");
        let response = http_raw_request(
            port,
            format!(
                "POST /api/v1/join/{join_code} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ),
        )
        .await;
        let (headers, body) = response.split_once("\r\n\r\n").expect("http response body");
        assert!(headers.starts_with("HTTP/1.1 200"), "{response}");
        serde_json::from_str(body).expect("join response")
    }

    async fn http_oversized_request(port: u16) -> String {
        http_request(
            port,
            format!(
                "POST /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_HTTP_BODY_BYTES + 1
            ),
        )
        .await
    }

    async fn http_request(port: u16, request: String) -> String {
        http_raw_request(port, request).await.to_ascii_lowercase()
    }

    async fn http_raw_request(port: u16, request: String) -> String {
        let mut stream =
            tokio::net::TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
                .await
                .expect("http connect");
        stream
            .write_all(request.as_bytes())
            .await
            .expect("http request");
        let mut response = Vec::new();
        stream
            .read_to_end(&mut response)
            .await
            .expect("http response");
        String::from_utf8(response).expect("utf8 response")
    }

    async fn connect_same_origin(
        port: u16,
    ) -> (
        TestSocket,
        tokio_tungstenite::tungstenite::handshake::client::Response,
    ) {
        connect_async(web_socket_request(
            port,
            &format!("http://127.0.0.1:{port}"),
        ))
        .await
        .expect("websocket connects")
    }

    fn web_socket_request(
        port: u16,
        origin: &str,
    ) -> tokio_tungstenite::tungstenite::handshake::client::Request {
        let mut request = format!("ws://127.0.0.1:{port}/ws")
            .into_client_request()
            .expect("websocket request");
        request.headers_mut().insert(
            "origin",
            HeaderValue::from_str(origin).expect("origin header"),
        );
        request
    }

    async fn receive_text(socket: &mut TestSocket) -> String {
        match socket.next().await {
            Some(Ok(ClientWebSocketMessage::Text(text))) => text.to_string(),
            _ => panic!("expected text message"),
        }
    }

    async fn receive_until(socket: &mut TestSocket, needle: &str) -> String {
        for _ in 0..8 {
            let text = receive_text(socket).await;
            if text.contains(needle) {
                return text;
            }
        }
        panic!("expected websocket message containing {needle}");
    }

    fn assert_server_hello(text: &str, server_instance_id: &str) {
        assert!(text.contains("\"type\":\"server_hello\""));
        assert!(text.contains("\"protocolVersion\":1"));
        assert!(text.contains(server_instance_id));
        assert!(!text.contains("sqlite"));
        assert!(!text.contains("C:\\\\"));
    }

    fn assert_protocol_error(text: &str) {
        assert!(text.contains("\"type\":\"error\""));
        assert!(text.contains("\"code\":\"PROTOCOL_ERROR\""));
    }

    fn teacher_participants(
        service: &LocalServerService,
        session_id: &str,
    ) -> Vec<crate::application::TeacherParticipantDto> {
        let mut participants = service
            .session
            .list_participants(session_id)
            .expect("participants");
        for participant in &mut participants {
            participant.online = service.is_participant_online(&participant.participant_id);
        }
        participants
    }

    async fn wait_for_presence(service: &LocalServerService, participant_id: &str, online: bool) {
        for _ in 0..32 {
            if service.is_participant_online(participant_id) == online {
                return;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(service.is_participant_online(participant_id), online);
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct JoinResponse {
        session_id: String,
        participant_id: String,
        credential: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProtocolFixtures {
        valid_client_messages: Vec<serde_json::Value>,
        invalid_client_messages: Vec<InvalidClientFixture>,
    }

    #[derive(Deserialize)]
    struct InvalidClientFixture {
        message: serde_json::Value,
    }
}
