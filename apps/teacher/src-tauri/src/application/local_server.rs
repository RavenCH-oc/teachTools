use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard};

use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    State,
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

use crate::error::AppError;

pub const LOCAL_PROTOCOL_VERSION: u8 = 1;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 64 * 1024;

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
}

impl LocalServerService {
    pub fn new() -> Self {
        Self {
            lifecycle: Arc::new(Mutex::new(ServerLifecycle::Stopped)),
        }
    }

    pub fn status(&self) -> Result<LocalServerStatus, AppError> {
        Ok(self.lifecycle()?.status())
    }

    pub async fn start(&self) -> Result<LocalServerStatus, AppError> {
        self.start_on(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)), true)
            .await
    }

    pub async fn stop(&self) -> Result<LocalServerStatus, AppError> {
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
        let router_state = Arc::new(TransportState { server_instance_id });
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

impl Default for LocalServerService {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
struct TransportState {
    server_instance_id: String,
}

fn router(state: Arc<TransportState>) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/ws", get(web_socket_upgrade))
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
    if !send_server_message(
        &mut socket,
        &ServerMessage::ServerHello {
            protocol_version: LOCAL_PROTOCOL_VERSION,
            server_instance_id: state.server_instance_id.clone(),
        },
    )
    .await
    {
        return;
    }

    while let Some(next) = socket.recv().await {
        match next {
            Ok(Message::Text(text)) => {
                if text.len() > MAX_MESSAGE_BYTES {
                    let _ = send_protocol_error(&mut socket).await;
                    break;
                }
                match parse_client_message(&text) {
                    Ok(ClientMessage::Ping { request_id, .. }) => {
                        if !send_server_message(
                            &mut socket,
                            &ServerMessage::Pong {
                                protocol_version: LOCAL_PROTOCOL_VERSION,
                                request_id,
                            },
                        )
                        .await
                        {
                            break;
                        }
                    }
                    Err(()) => {
                        let _ = send_protocol_error(&mut socket).await;
                        break;
                    }
                }
            }
            Ok(Message::Binary(_)) => {
                let _ = send_protocol_error(&mut socket).await;
                break;
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
        }
    }
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
    let result = axum::serve(listener, router)
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

    #[tokio::test]
    async fn http_endpoints_are_narrow_and_safe() {
        let service = LocalServerService::new();
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

        service.stop().await.expect("server stops");
    }

    #[tokio::test]
    async fn websocket_handshake_ping_and_protocol_errors_are_safe() {
        let service = LocalServerService::new();
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
    async fn websocket_rejects_unknown_protocol_binary_and_foreign_origin() {
        let service = LocalServerService::new();
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
        let service = LocalServerService::new();
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
        String::from_utf8(response)
            .expect("utf8 response")
            .to_ascii_lowercase()
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
