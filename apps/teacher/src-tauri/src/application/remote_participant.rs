//! Remote routing only. Identity, mutations and personalized projections use the LAN application seam.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::participant_realtime::{ParticipantConnection, ParticipantRealtimeService};
use super::LocalSessionService;
use crate::error::AppError;

pub(crate) const MAX_REMOTE_ENVELOPE_BYTES: usize = 64 * 1024;
const JOIN_RECOVERY_TTL: Duration = Duration::from_secs(120);
const MAX_JOIN_ATTEMPTS: usize = 128;
const MAX_CONNECTIONS: usize = 512;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    v: u8,
    id: Uuid,
    #[serde(rename = "type")]
    family: String,
    payload: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JoinRequest {
    op: String,
    generation: u64,
    join_attempt_id: Uuid,
    seat_number: i64,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RoutedMessage {
    generation: u64,
    connection_id: Uuid,
    message: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Disconnected {
    op: String,
    generation: u64,
    connection_id: Uuid,
}

struct JoinRecovery {
    identity_hash: [u8; 32],
    expires: Instant,
    result: Result<Value, (&'static str, &'static str)>,
}

pub(crate) struct RemoteParticipants {
    sessions: Arc<LocalSessionService>,
    realtime: ParticipantRealtimeService,
    local_session_id: String,
    server_instance_id: String,
    connections: HashMap<Uuid, ParticipantConnection>,
    // Credentials live only in this bounded Teacher-process cache, never in relay storage.
    joins: HashMap<Uuid, JoinRecovery>,
}

impl RemoteParticipants {
    pub(crate) fn new(
        sessions: Arc<LocalSessionService>,
        realtime: ParticipantRealtimeService,
        local_session_id: String,
        remote_session_id: &str,
    ) -> Self {
        Self {
            sessions,
            realtime,
            local_session_id,
            server_instance_id: format!("remote:{remote_session_id}"),
            connections: HashMap::new(),
            joins: HashMap::new(),
        }
    }

    pub(crate) fn disconnect_all(&mut self) {
        for participant in self.connections.values() {
            self.realtime.disconnect(participant);
        }
        self.connections.clear();
    }

    pub(crate) async fn handle(
        &mut self,
        raw: &str,
        generation: u64,
    ) -> Result<Vec<Value>, AppError> {
        if raw.len() > MAX_REMOTE_ENVELOPE_BYTES {
            return Err(AppError::RemoteProtocolMismatch);
        }
        let envelope: Envelope =
            serde_json::from_str(raw).map_err(|_| AppError::RemoteProtocolMismatch)?;
        if envelope.v != 1 {
            return Err(AppError::RemoteProtocolMismatch);
        }
        match envelope.family.as_str() {
            "CONTROL" => match envelope.payload.get("op").and_then(Value::as_str) {
                Some("pong") => Ok(Vec::new()),
                Some("join") => {
                    let request: JoinRequest = serde_json::from_value(envelope.payload)
                        .map_err(|_| AppError::RemoteProtocolMismatch)?;
                    if request.op != "join" || request.generation != generation {
                        return Err(AppError::RemoteProtocolMismatch);
                    }
                    let result = self.join(request).await;
                    let mut payload = json!({"op":"join_result", "generation":generation});
                    match result {
                        Ok(result) => payload["result"] = result,
                        Err((code, message)) => {
                            payload["error"] = json!({"code":code,"message":message})
                        }
                    }
                    Ok(vec![
                        json!({"v":1,"type":"CONTROL","id":envelope.id,"payload":payload}),
                    ])
                }
                Some("participant_disconnected") => {
                    let request: Disconnected = serde_json::from_value(envelope.payload)
                        .map_err(|_| AppError::RemoteProtocolMismatch)?;
                    if request.op != "participant_disconnected" || request.generation != generation
                    {
                        return Err(AppError::RemoteProtocolMismatch);
                    }
                    if let Some(participant) = self.connections.remove(&request.connection_id) {
                        self.realtime.disconnect(&participant);
                    }
                    Ok(Vec::new())
                }
                _ => Err(AppError::RemoteProtocolMismatch),
            },
            "AUTH" | "REALTIME" => {
                let routed: RoutedMessage = serde_json::from_value(envelope.payload)
                    .map_err(|_| AppError::RemoteProtocolMismatch)?;
                if routed.generation != generation {
                    return Err(AppError::RemoteProtocolMismatch);
                }
                let text = routed.message.to_string();
                if envelope.family == "AUTH" {
                    if routed.message.get("sessionId").and_then(Value::as_str)
                        != Some(&self.local_session_id)
                        || (!self.connections.contains_key(&routed.connection_id)
                            && self.connections.len() >= MAX_CONNECTIONS)
                    {
                        return self.auth_rejected(
                            envelope.id,
                            routed.connection_id,
                            generation,
                            "AUTH_FAILED",
                        );
                    }
                    // A DO hibernation wake can require re-auth on the same physical
                    // connection/generation. Always discard its earlier presence trust.
                    if let Some(previous) = self.connections.remove(&routed.connection_id) {
                        self.realtime.disconnect(&previous);
                    }
                    match self
                        .realtime
                        .authenticate(&self.server_instance_id, &text, routed.connection_id)
                        .await
                    {
                        Ok((participant, messages)) => {
                            let sync = match self.realtime.sync_messages(&participant).await {
                                Ok(sync) => sync,
                                Err(_) => {
                                    self.realtime.disconnect(&participant);
                                    return self.auth_rejected(
                                        envelope.id,
                                        routed.connection_id,
                                        generation,
                                        "SESSION_ENDED",
                                    );
                                }
                            };
                            let Some(message) = messages.into_iter().next() else {
                                self.realtime.disconnect(&participant);
                                return Err(AppError::RemoteProtocolMismatch);
                            };
                            self.connections.insert(routed.connection_id, participant);
                            let mut frames = vec![json!({"v":1,"type":"AUTH","id":envelope.id,
                                "payload":{"connectionId":routed.connection_id,"generation":generation,
                                    "accepted":true,"message":message}})];
                            frames.extend(self.wrap_messages(
                                routed.connection_id,
                                generation,
                                sync,
                            )?);
                            Ok(frames)
                        }
                        Err(code) => {
                            self.auth_rejected(envelope.id, routed.connection_id, generation, code)
                        }
                    }
                } else {
                    let participant = self
                        .connections
                        .get(&routed.connection_id)
                        .ok_or(AppError::RemoteProtocolMismatch)?;
                    // Invalid input from one authenticated Student must not tear down
                    // the shared Teacher transport or invalidate other participants.
                    let messages = match self.realtime.handle(participant, &text).await {
                        Ok(messages) => messages,
                        Err(()) => vec![ParticipantRealtimeService::error("PROTOCOL_ERROR")],
                    };
                    self.wrap_messages(routed.connection_id, generation, messages)
                }
            }
            _ => Err(AppError::RemoteProtocolMismatch),
        }
    }

    fn auth_rejected(
        &self,
        id: Uuid,
        connection_id: Uuid,
        generation: u64,
        code: &'static str,
    ) -> Result<Vec<Value>, AppError> {
        Ok(vec![json!({"v":1,"type":"AUTH","id":id,"payload":{
            "connectionId":connection_id,"generation":generation,"accepted":false,
            "message":ParticipantRealtimeService::error(code)}})])
    }

    pub(crate) async fn sync_all(
        &self,
        generation: u64,
        quiz: bool,
    ) -> Result<Vec<Value>, AppError> {
        let mut frames = Vec::new();
        for (connection_id, participant) in &self.connections {
            let messages = if quiz {
                self.realtime.quiz_sync_messages(participant).await
            } else {
                self.realtime.sync_messages(participant).await
            };
            match messages {
                Ok(messages) => {
                    frames.extend(self.wrap_messages(*connection_id, generation, messages)?)
                }
                Err(_) => frames.extend(self.wrap_messages(
                    *connection_id,
                    generation,
                    vec![ParticipantRealtimeService::error("SESSION_ENDED")],
                )?),
            }
        }
        Ok(frames)
    }

    pub(crate) fn session_changed(
        &self,
        generation: u64,
        state: &str,
    ) -> Result<Vec<Value>, AppError> {
        let mut frames = Vec::new();
        for connection_id in self.connections.keys() {
            frames.push(json!({"v":1,"type":"REALTIME","id":Uuid::now_v7(),"payload":{
                "connectionId":connection_id,"generation":generation,"message":{
                    "protocolVersion":1,"type":"session_state_changed","sessionId":self.local_session_id,"state":state}}}));
        }
        Ok(frames)
    }

    fn wrap_messages(
        &self,
        connection_id: Uuid,
        generation: u64,
        messages: Vec<super::participant_realtime::ServerMessage>,
    ) -> Result<Vec<Value>, AppError> {
        let mut frames = Vec::new();
        for message in messages {
            let frame = json!({"v":1,"type":"REALTIME","id":Uuid::now_v7(),"payload":{
                "connectionId":connection_id,"generation":generation,"message":message}});
            if frame.to_string().len() > MAX_REMOTE_ENVELOPE_BYTES {
                frames.push(json!({"v":1,"type":"ERROR","id":Uuid::now_v7(),"payload":{
                    "connectionId":connection_id,"generation":generation,"kind":"transport",
                    "code":"MESSAGE_TOO_LARGE","retryable":false}}));
                break;
            }
            frames.push(frame);
        }
        Ok(frames)
    }

    async fn join(&mut self, request: JoinRequest) -> Result<Value, (&'static str, &'static str)> {
        let now = Instant::now();
        self.joins.retain(|_, cached| cached.expires > now);
        let identity_hash: [u8; 32] =
            Sha256::digest(format!("{}:{}", request.seat_number, request.name).as_bytes()).into();
        if let Some(cached) = self.joins.get(&request.join_attempt_id) {
            if cached.identity_hash != identity_hash {
                return Err(("JOIN_ATTEMPT_CONFLICT", "加入資料已變更，請重新開始加入。"));
            }
            // Recovery after a lost response is allowed during ACTIVE, but never after Session end.
            let sessions = Arc::clone(&self.sessions);
            let local_id = self.local_session_id.clone();
            let active = tauri::async_runtime::spawn_blocking(move || sessions.active())
                .await
                .ok()
                .and_then(Result::ok)
                .flatten();
            if !active.is_some_and(|session| session.id == local_id) {
                return Err(("SESSION_NOT_OPEN", "課堂已結束。"));
            }
            return cached.result.clone();
        }
        if self.joins.len() >= MAX_JOIN_ATTEMPTS {
            return Err(("REMOTE_SERVICE_UNAVAILABLE", "加入請求過多，請稍後再試。"));
        }
        let sessions = Arc::clone(&self.sessions);
        let local_id = self.local_session_id.clone();
        let instance_id = self.server_instance_id.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let session = sessions
                .active()?
                .filter(|session| {
                    session.id == local_id && session.server_instance_id == instance_id
                })
                .ok_or(AppError::SessionNotOpen)?;
            let info = sessions.public_join_info(&session.join_code, &instance_id, 1)?;
            let joined = sessions.join(
                &session.join_code,
                request.seat_number,
                &request.name,
                &instance_id,
            )?;
            Ok::<Value, AppError>(json!({"info":info,"participant":joined}))
        })
        .await
        .map_err(|_| ("REMOTE_SERVICE_UNAVAILABLE", "遠端課堂目前無法使用。"))?
        .map_err(join_error);
        self.joins.insert(
            request.join_attempt_id,
            JoinRecovery {
                identity_hash,
                expires: now + JOIN_RECOVERY_TTL,
                result: result.clone(),
            },
        );
        result
    }
}

impl Drop for RemoteParticipants {
    fn drop(&mut self) {
        self.disconnect_all();
    }
}

fn join_error(error: AppError) -> (&'static str, &'static str) {
    match error {
        AppError::SeatAlreadyJoined => ("SEAT_ALREADY_JOINED", "這個座號已經加入課堂。"),
        AppError::SessionNotOpen | AppError::SessionEnded => {
            ("SESSION_NOT_OPEN", "課堂大廳尚未開放或已結束。")
        }
        AppError::IdentityMismatch | AppError::JoinCodeInvalid => {
            ("IDENTITY_MISMATCH", "座號或姓名不正確。")
        }
        _ => ("REMOTE_SERVICE_UNAVAILABLE", "遠端課堂目前無法使用。"),
    }
}

#[cfg(test)]
#[path = "remote_participant_tests.rs"]
mod tests;
