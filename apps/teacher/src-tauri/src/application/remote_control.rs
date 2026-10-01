use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::sync::{watch, Mutex as AsyncMutex};
use tokio::time::{interval, sleep, timeout};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

use super::LocalSessionService;
use crate::error::AppError;

const REMOTE_PROTOCOL_VERSION: u8 = 1;
const MAX_ENVELOPE_BYTES: usize = 64 * 1024;
#[cfg(not(test))]
const CREDENTIAL_SERVICE: &str = "Classroom.RemoteInstallation";
#[cfg(test)]
const CREDENTIAL_SERVICE: &str = "Classroom.RemoteInstallation.Phase16CTest";
const CREDENTIAL_USER: &str = "teacher";

type TeacherSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallationCredential {
    installation_id: String,
    installation_credential: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCreated {
    remote_session_id: String,
    remote_protocol_version: u8,
    expires_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectTicket {
    ticket: String,
    ticket_expires_at: i64,
}

#[derive(Deserialize)]
struct RelayError {
    code: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionStatus {
    pub remote_session_id: String,
    pub local_session_id: String,
    pub join_url: String,
    pub expires_at: i64,
    pub generation: Option<u64>,
    pub state: RemoteConnectionState,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RemoteConnectionState {
    Connecting,
    Open,
    TeacherOffline,
}

struct ActiveRemote {
    status: RemoteSessionStatus,
    stop: watch::Sender<bool>,
}

pub struct RemoteControlService {
    client: Option<reqwest::Client>,
    base_url: Option<reqwest::Url>,
    sessions: Arc<LocalSessionService>,
    operation: AsyncMutex<()>,
    active: Arc<Mutex<Option<ActiveRemote>>>,
}

impl RemoteControlService {
    pub fn initialize(sessions: Arc<LocalSessionService>) -> Self {
        #[cfg(windows)]
        {
            if let Ok(store) = windows_native_keyring_store::Store::new() {
                keyring_core::set_default_store(store);
            }
        }
        #[cfg(debug_assertions)]
        let configured = std::env::var("CLASSROOM_REMOTE_BASE_URL").unwrap_or_else(|_| {
            option_env!("CLASSROOM_REMOTE_BASE_URL")
                .unwrap_or("")
                .to_owned()
        });
        #[cfg(not(debug_assertions))]
        let configured = option_env!("CLASSROOM_REMOTE_BASE_URL")
            .unwrap_or("")
            .to_owned();
        let base_url = reqwest::Url::parse(&configured).ok().filter(|url| {
            let loopback_debug = cfg!(debug_assertions)
                && url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
            (url.scheme() == "https" || loopback_debug)
                && url.query().is_none()
                && url.fragment().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
        });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .ok();
        Self {
            client,
            base_url,
            sessions,
            operation: AsyncMutex::new(()),
            active: Arc::new(Mutex::new(None)),
        }
    }

    fn base_url(&self) -> Result<&reqwest::Url, AppError> {
        self.base_url.as_ref().ok_or(AppError::RemoteUnavailable)
    }

    fn client(&self) -> Result<&reqwest::Client, AppError> {
        self.client.as_ref().ok_or(AppError::RemoteUnavailable)
    }

    fn endpoint(&self, path: &str) -> Result<reqwest::Url, AppError> {
        self.base_url()?
            .join(path)
            .map_err(|_| AppError::RemoteUnavailable)
    }

    pub fn configured(&self) -> bool {
        self.base_url.is_some() && self.client.is_some()
    }

    pub fn enrolled(&self) -> Result<bool, AppError> {
        Ok(read_installation()?.is_some())
    }

    pub async fn enroll(&self, activation_code: String) -> Result<(), AppError> {
        if self.enrolled()? {
            return Err(AppError::Conflict("already enrolled".to_owned()));
        }
        if !is_secret(&activation_code) {
            return Err(AppError::Validation("activation code".to_owned()));
        }
        let response = self
            .client()?
            .post(self.endpoint("v1/enroll")?)
            .json(&serde_json::json!({ "activationCode": activation_code }))
            .send()
            .await
            .map_err(|_| AppError::RemoteUnavailable)?;
        let installation: InstallationCredential = self.parse_response(response).await?;
        if Uuid::parse_str(&installation.installation_id).is_err()
            || !is_secret(&installation.installation_credential)
        {
            return Err(AppError::RemoteProtocolMismatch);
        }
        write_installation(&installation)?;
        Ok(())
    }

    pub fn status(&self) -> Result<Option<RemoteSessionStatus>, AppError> {
        let state = self
            .active
            .lock()
            .map_err(|_| AppError::RemoteUnavailable)?;
        Ok(state.as_ref().map(|active| active.status.clone()))
    }

    pub async fn create_session(
        &self,
        classroom_id: String,
    ) -> Result<RemoteSessionStatus, AppError> {
        let _operation = self.operation.lock().await;
        if self.status()?.is_some() || self.sessions.has_nonterminal_session()? {
            return Err(AppError::Conflict("another session is active".to_owned()));
        }
        let installation = read_installation()?.ok_or(AppError::RemoteNotEnrolled)?;
        let response = self
            .client()?
            .post(self.endpoint("v1/teacher/sessions")?)
            .bearer_auth(&installation.installation_credential)
            .json(&serde_json::json!({
                "teacherAppVersion": env!("CARGO_PKG_VERSION"),
                "remoteProtocolVersion": REMOTE_PROTOCOL_VERSION,
            }))
            .send()
            .await
            .map_err(|_| AppError::RemoteUnavailable)?;
        let created: SessionCreated = self.parse_response(response).await?;
        if created.remote_protocol_version != REMOTE_PROTOCOL_VERSION
            || !is_session_id(&created.remote_session_id)
        {
            return Err(AppError::RemoteProtocolMismatch);
        }
        let local = match self.sessions.create(
            classroom_id,
            format!("remote:{}", created.remote_session_id),
        ) {
            Ok(local) => local,
            Err(error) => {
                let _ = self
                    .close_relay(&created.remote_session_id, &installation)
                    .await;
                return Err(error);
            }
        };
        let status = RemoteSessionStatus {
            join_url: self
                .endpoint(&format!("join/{}", created.remote_session_id))?
                .to_string(),
            remote_session_id: created.remote_session_id,
            local_session_id: local.id,
            expires_at: created.expires_at,
            generation: None,
            state: RemoteConnectionState::Connecting,
        };
        let (stop, receiver) = watch::channel(false);
        {
            let mut state = self
                .active
                .lock()
                .map_err(|_| AppError::RemoteUnavailable)?;
            *state = Some(ActiveRemote {
                status: status.clone(),
                stop,
            });
        }
        let client = self.client()?.clone();
        let base_url = self.base_url()?.clone();
        let active = Arc::clone(&self.active);
        let remote_id = status.remote_session_id.clone();
        tauri::async_runtime::spawn(async move {
            connection_loop(client, base_url, remote_id, active, receiver).await;
        });
        Ok(status)
    }

    pub async fn close_session(&self) -> Result<(), AppError> {
        let _operation = self.operation.lock().await;
        let status = self.status()?.ok_or(AppError::SessionNotFound)?;
        let relay_result = match read_installation() {
            Ok(Some(installation)) => {
                self.close_relay(&status.remote_session_id, &installation)
                    .await
            }
            Ok(None) => Err(AppError::RemoteNotEnrolled),
            Err(error) => Err(error),
        };
        {
            let mut state = self
                .active
                .lock()
                .map_err(|_| AppError::RemoteUnavailable)?;
            if let Some(active) = state.take() {
                let _ = active.stop.send(true);
            }
        }
        self.sessions
            .end(status.local_session_id, "teacher_ended")?;
        relay_result
    }

    pub async fn close_on_exit(&self) {
        if self.status().ok().flatten().is_some() {
            let _ = self.close_session().await;
        }
    }

    async fn close_relay(
        &self,
        id: &str,
        installation: &InstallationCredential,
    ) -> Result<(), AppError> {
        let response = self
            .client()?
            .delete(self.endpoint(&format!("v1/teacher/sessions/{id}"))?)
            .bearer_auth(&installation.installation_credential)
            .send()
            .await
            .map_err(|_| AppError::RemoteUnavailable)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(map_relay_error(response).await)
        }
    }

    async fn parse_response<T: for<'de> Deserialize<'de>>(
        &self,
        response: reqwest::Response,
    ) -> Result<T, AppError> {
        if !response.status().is_success() {
            return Err(map_relay_error(response).await);
        }
        response
            .json::<T>()
            .await
            .map_err(|_| AppError::RemoteProtocolMismatch)
    }
}

async fn map_relay_error(response: reqwest::Response) -> AppError {
    let body = response.json::<RelayError>().await.ok();
    match body.as_ref().map(|error| error.code.as_str()) {
        Some("AUTH_REQUIRED" | "AUTH_REJECTED") => AppError::RemoteAuthRejected,
        Some("PROTOCOL_MISMATCH") => AppError::RemoteProtocolMismatch,
        Some("SESSION_CLOSED" | "SESSION_EXPIRED") => AppError::SessionEnded,
        _ => AppError::RemoteUnavailable,
    }
}

fn is_secret(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn is_session_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[cfg(windows)]
fn credential_entry() -> Result<keyring_core::Entry, AppError> {
    use std::collections::HashMap;
    keyring_core::Entry::new_with_modifiers(
        CREDENTIAL_SERVICE,
        CREDENTIAL_USER,
        &HashMap::from([("persistence", "Local")]),
    )
    .map_err(|_| AppError::RemoteCredentialStore)
}

#[cfg(windows)]
fn read_installation() -> Result<Option<InstallationCredential>, AppError> {
    let entry = credential_entry()?;
    match entry.get_password() {
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

#[cfg(not(windows))]
fn read_installation() -> Result<Option<InstallationCredential>, AppError> {
    Err(AppError::RemoteCredentialStore)
}

#[cfg(windows)]
fn write_installation(installation: &InstallationCredential) -> Result<(), AppError> {
    let raw = serde_json::to_string(installation).map_err(|_| AppError::RemoteCredentialStore)?;
    credential_entry()?
        .set_password(&raw)
        .map_err(|_| AppError::RemoteCredentialStore)
}

#[cfg(not(windows))]
fn write_installation(_: &InstallationCredential) -> Result<(), AppError> {
    Err(AppError::RemoteCredentialStore)
}

async fn connect_once(
    client: &reqwest::Client,
    base: &reqwest::Url,
    id: &str,
) -> Result<(TeacherSocket, u64), AppError> {
    let installation = read_installation()?.ok_or(AppError::RemoteNotEnrolled)?;
    let ticket_url = base
        .join(&format!("v1/teacher/sessions/{id}/tickets"))
        .map_err(|_| AppError::RemoteUnavailable)?;
    let response = client
        .post(ticket_url)
        .bearer_auth(&installation.installation_credential)
        .send()
        .await
        .map_err(|_| AppError::RemoteUnavailable)?;
    if !response.status().is_success() {
        return Err(map_relay_error(response).await);
    }
    let ticket: ConnectTicket = response
        .json()
        .await
        .map_err(|_| AppError::RemoteProtocolMismatch)?;
    if !is_secret(&ticket.ticket) || ticket.ticket_expires_at <= 0 {
        return Err(AppError::RemoteProtocolMismatch);
    }
    let mut ws_url = base
        .join(&format!("v1/teacher/sessions/{id}/ws"))
        .map_err(|_| AppError::RemoteUnavailable)?;
    ws_url
        .set_scheme(if base.scheme() == "https" {
            "wss"
        } else {
            "ws"
        })
        .map_err(|_| AppError::RemoteUnavailable)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|_| AppError::RemoteUnavailable)?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", ticket.ticket))
            .map_err(|_| AppError::RemoteUnavailable)?,
    );
    let (mut socket, _) = timeout(Duration::from_secs(10), connect_async(request))
        .await
        .map_err(|_| AppError::RemoteUnavailable)?
        .map_err(|_| AppError::RemoteUnavailable)?;
    let first = timeout(Duration::from_secs(10), socket.next())
        .await
        .map_err(|_| AppError::RemoteUnavailable)?
        .ok_or(AppError::RemoteUnavailable)?
        .map_err(|_| AppError::RemoteUnavailable)?;
    let Message::Text(text) = first else {
        return Err(AppError::RemoteProtocolMismatch);
    };
    let generation = attached_generation(&text)?;
    Ok((socket, generation))
}

fn attached_generation(raw: &str) -> Result<u64, AppError> {
    if raw.len() > MAX_ENVELOPE_BYTES {
        return Err(AppError::RemoteProtocolMismatch);
    }
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| AppError::RemoteProtocolMismatch)?;
    if value.get("v").and_then(serde_json::Value::as_u64)
        != Some(u64::from(REMOTE_PROTOCOL_VERSION))
        || value.get("type").and_then(serde_json::Value::as_str) != Some("CONTROL")
        || value
            .pointer("/payload/op")
            .and_then(serde_json::Value::as_str)
            != Some("teacher_attached")
    {
        return Err(AppError::RemoteProtocolMismatch);
    }
    value
        .pointer("/payload/generation")
        .and_then(serde_json::Value::as_u64)
        .filter(|generation| *generation > 0)
        .ok_or(AppError::RemoteProtocolMismatch)
}

fn update_status(
    active: &Arc<Mutex<Option<ActiveRemote>>>,
    id: &str,
    state: RemoteConnectionState,
    generation: Option<u64>,
) {
    if let Ok(mut current) = active.lock() {
        if let Some(current) = current
            .as_mut()
            .filter(|current| current.status.remote_session_id == id)
        {
            current.status.state = state;
            if generation.is_some() {
                current.status.generation = generation;
            }
        }
    }
}

async fn connection_loop(
    client: reqwest::Client,
    base: reqwest::Url,
    id: String,
    active: Arc<Mutex<Option<ActiveRemote>>>,
    mut stop: watch::Receiver<bool>,
) {
    let mut attempt = 0u32;
    loop {
        if *stop.borrow() {
            return;
        }
        match connect_once(&client, &base, &id).await {
            Ok((mut socket, generation)) => {
                update_status(&active, &id, RemoteConnectionState::Open, Some(generation));
                attempt = 0;
                let mut heartbeat = interval(Duration::from_secs(if cfg!(test) { 2 } else { 20 }));
                loop {
                    tokio::select! {
                        changed = stop.changed() => {
                            if changed.is_err() || *stop.borrow() {
                                let _ = socket.close(None).await;
                                return;
                            }
                        }
                        _ = heartbeat.tick() => {
                            let ping = serde_json::json!({ "v": REMOTE_PROTOCOL_VERSION,
                                "type": "CONTROL", "id": Uuid::now_v7(), "payload": { "op": "ping" } });
                            if socket.send(Message::Text(ping.to_string().into())).await.is_err() { break; }
                        }
                        message = socket.next() => {
                            match message {
                                Some(Ok(Message::Text(text))) if text.len() <= MAX_ENVELOPE_BYTES => {
                                    let valid = serde_json::from_str::<serde_json::Value>(&text).ok()
                                        .and_then(|value| value.get("v").and_then(serde_json::Value::as_u64))
                                        == Some(u64::from(REMOTE_PROTOCOL_VERSION));
                                    if !valid { break; }
                                }
                                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {},
                                _ => break,
                            }
                        }
                    }
                }
                update_status(&active, &id, RemoteConnectionState::TeacherOffline, None);
            }
            Err(
                AppError::SessionEnded
                | AppError::RemoteAuthRejected
                | AppError::RemoteProtocolMismatch,
            ) => {
                update_status(&active, &id, RemoteConnectionState::TeacherOffline, None);
                return;
            }
            Err(_) => update_status(&active, &id, RemoteConnectionState::TeacherOffline, None),
        }
        attempt = attempt.saturating_add(1);
        let delay = Duration::from_secs(2u64.saturating_pow(attempt.min(5)));
        tokio::select! {
            _ = sleep(delay) => {},
            changed = stop.changed() => { if changed.is_err() || *stop.borrow() { return; } }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        attached_generation, credential_entry, RemoteConnectionState, RemoteControlService,
    };
    use crate::application::LocalSessionService;
    use crate::infrastructure::persistence::database::Database;
    use crate::infrastructure::persistence::repositories::classroom::NewClassroom;
    use crate::infrastructure::persistence::repositories::ClassroomRepository;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::time::{sleep, timeout};

    #[test]
    fn validates_teacher_attach() {
        let valid = r#"{"v":1,"type":"CONTROL","id":"00000000-0000-4000-8000-000000000000","payload":{"op":"teacher_attached","generation":2}}"#;
        assert_eq!(attached_generation(valid).ok(), Some(2));
        assert!(attached_generation(&valid.replace("\"v\":1", "\"v\":2")).is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn local_relay_and_windows_credential_lifecycle() {
        let directory = tempfile::tempdir().expect("temporary database directory");
        let database = Database::open_in_app_data(directory.path()).expect("database path");
        database.initialize().expect("database initialized");
        let classroom = ClassroomRepository::create(
            &database,
            NewClassroom {
                name: "Phase 16C Test".to_owned(),
                academic_year: None,
            },
        )
        .expect("test classroom");
        let sessions = LocalSessionService::initialize(database).expect("session service");
        let service = RemoteControlService::initialize(Arc::clone(&sessions));
        assert!(service.configured());
        let entry = credential_entry().expect("Windows Credential Manager entry");
        let _ = entry.delete_credential();
        assert!(!service.enrolled().expect("credential lookup"));

        let activation_code = if let Ok(code) = std::env::var("CLASSROOM_TEST_ACTIVATION_CODE") {
            code
        } else {
            let operator = std::env::var("CLASSROOM_TEST_OPERATOR_TOKEN")
                .expect("local test operator token is required");
            let response = service
                .client()
                .expect("HTTP client")
                .post(
                    service
                        .endpoint("v1/operator/activation-codes")
                        .expect("operator URL"),
                )
                .bearer_auth(&operator)
                .json(&serde_json::json!({}))
                .send()
                .await
                .expect("activation request");
            assert_eq!(response.status(), reqwest::StatusCode::CREATED);
            let code: serde_json::Value = response.json().await.expect("activation response");
            code.get("activationCode")
                .and_then(serde_json::Value::as_str)
                .expect("activation code")
                .to_owned()
        };
        service.enroll(activation_code).await.expect("enrollment");
        assert!(service
            .enrolled()
            .expect("credential lookup after enrollment"));
        if std::env::var_os("CLASSROOM_TEST_REPORT_INSTALLATION_ID").is_some() {
            let installation = super::read_installation()
                .expect("credential lookup")
                .expect("test installation");
            println!(
                "PHASE16C_TEST_INSTALLATION_ID={}",
                installation.installation_id
            );
        }
        assert!(entry
            .get_password()
            .expect("stored credential")
            .contains("installationCredential"));

        let created = service
            .create_session(classroom.id.clone())
            .await
            .expect("remote session");
        assert_eq!(created.remote_session_id.len(), 32);
        timeout(Duration::from_secs(10), async {
            loop {
                if service
                    .status()
                    .expect("status")
                    .as_ref()
                    .is_some_and(|status| {
                        matches!(status.state, RemoteConnectionState::Open)
                            && status.generation == Some(1)
                    })
                {
                    break;
                }
                sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("Teacher Rust WSS attachment");
        let bootstrap: serde_json::Value = service
            .client()
            .expect("HTTP client")
            .get(
                service
                    .endpoint(&format!(
                        "v1/sessions/{}/bootstrap",
                        created.remote_session_id
                    ))
                    .expect("bootstrap URL"),
            )
            .send()
            .await
            .expect("public bootstrap")
            .json()
            .await
            .expect("bootstrap response");
        assert_eq!(
            bootstrap.get("status").and_then(serde_json::Value::as_str),
            Some("available")
        );
        assert_eq!(bootstrap.as_object().map(|object| object.len()), Some(3));
        let (second_socket, generation) = super::connect_once(
            service.client().expect("HTTP client"),
            service.base_url().expect("relay URL"),
            &created.remote_session_id,
        )
        .await
        .expect("second one-use ticket attachment");
        assert_eq!(generation, 2);
        timeout(Duration::from_secs(20), async {
            loop {
                if service
                    .status()
                    .expect("status")
                    .as_ref()
                    .and_then(|status| status.generation)
                    .is_some_and(|generation| generation > 2)
                {
                    break;
                }
                sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .expect("automatic fresh-ticket reconnect");
        drop(second_socket);
        service.close_session().await.expect("close remote session");
        assert!(service.status().expect("status after close").is_none());
        assert!(sessions.active().expect("active session").is_none());
        let bootstrap: serde_json::Value = service
            .client()
            .expect("HTTP client")
            .get(
                service
                    .endpoint(&format!(
                        "v1/sessions/{}/bootstrap",
                        created.remote_session_id
                    ))
                    .expect("bootstrap URL"),
            )
            .send()
            .await
            .expect("public bootstrap after close")
            .json()
            .await
            .expect("bootstrap response after close");
        assert_eq!(
            bootstrap.get("status").and_then(serde_json::Value::as_str),
            Some("unavailable")
        );

        let mut unavailable = RemoteControlService::initialize(Arc::clone(&sessions));
        unavailable.base_url =
            Some(reqwest::Url::parse("http://127.0.0.1:9/").expect("loopback URL"));
        assert!(unavailable
            .create_session(classroom.id.clone())
            .await
            .is_err());
        let local = sessions
            .create(classroom.id, "local-server-test".to_owned())
            .expect("Local Mode remains available after relay failure");
        sessions
            .end(local.id, "test_end")
            .expect("local session end");
        entry.delete_credential().expect("remove test credential");
        assert!(!service.enrolled().expect("credential removed"));
    }
}
