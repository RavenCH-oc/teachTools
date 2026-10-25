//! Generation-bound, bounded native HTTP transport actor. Application reads remain authoritative.
use super::participant_http::{
    HttpIdentity, HttpOperation, HttpReadResponse, ParticipantHttpService,
};
use crate::error::AppError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;
use uuid::Uuid;

pub(crate) const HTTP_CHUNK_BYTES: usize = 32 * 1024;
pub(crate) const HTTP_WINDOW: usize = 4;
const MAX_REQUESTS: usize = 64;
const MAX_MEDIA: usize = 4;
const MAX_DETAIL_BYTES: usize = 16 * 1024 * 1024;
const MAX_MEDIA_BYTES: usize = 100 * 1024 * 1024;
const DETAIL_TIMEOUT: Duration = Duration::from_secs(15);
const MEDIA_TIMEOUT: Duration = Duration::from_secs(600);
const MEDIA_IDLE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    v: u8,
    id: Uuid,
    #[serde(rename = "type")]
    family: String,
    payload: Incoming,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all_fields = "camelCase", deny_unknown_fields)]
enum Incoming {
    #[serde(rename = "HTTP_REQUEST")]
    Request {
        generation: u64,
        identity: HttpIdentity,
        request: HttpOperation,
    },
    #[serde(rename = "HTTP_CREDIT")]
    Credit { generation: u64, credits: usize },
    #[serde(rename = "HTTP_CANCEL")]
    Cancel { generation: u64 },
}

#[derive(Clone)]
pub(crate) struct HttpReadBudget {
    readers: Arc<Semaphore>,
    media: Arc<Semaphore>,
}
impl Default for HttpReadBudget {
    fn default() -> Self {
        Self {
            readers: Arc::new(Semaphore::new(8)),
            media: Arc::new(Semaphore::new(MAX_MEDIA)),
        }
    }
}

struct Pending {
    media_permit: Option<OwnedSemaphorePermit>,
    task: Option<JoinHandle<()>>,
    response: Option<HttpReadResponse>,
    participant_id: String,
    media: bool,
    deadline: Instant,
    progress: Instant,
    offset: usize,
    sequence: usize,
    credits: usize,
}

pub(crate) struct Prepared {
    id: Uuid,
    response: HttpReadResponse,
    media_permit: Option<OwnedSemaphorePermit>,
}

pub(crate) struct RemoteHttp {
    budget: HttpReadBudget,
    service: ParticipantHttpService,
    instance: String,
    session_id: String,
    generation: u64,
    pending: HashMap<Uuid, Pending>,
    sender: mpsc::Sender<Prepared>,
    receiver: mpsc::Receiver<Prepared>,
}

impl RemoteHttp {
    pub(crate) fn new(
        service: ParticipantHttpService,
        session_id: String,
        remote_id: &str,
        generation: u64,
        budget: HttpReadBudget,
    ) -> Self {
        let (sender, receiver) = mpsc::channel(MAX_REQUESTS);
        Self {
            budget,
            service,
            session_id,
            instance: format!("remote:{remote_id}"),
            generation,
            pending: HashMap::new(),
            sender,
            receiver,
        }
    }

    fn frame(&self, id: Uuid, payload: Value) -> Value {
        let mut payload = payload;
        payload["generation"] = json!(self.generation);
        json!({"v":1,"type":"HTTP_RELAY","id":id,"payload":payload})
    }

    fn error(&self, id: Uuid, code: &str) -> Vec<Value> {
        vec![self.frame(id, json!({"op":"HTTP_ERROR","code":code}))]
    }

    pub(crate) async fn handle(&mut self, raw: &str) -> Result<Vec<Value>, AppError> {
        if raw.len() > super::remote_participant::MAX_REMOTE_ENVELOPE_BYTES {
            return Err(AppError::RemoteProtocolMismatch);
        }
        let envelope: Envelope =
            serde_json::from_str(raw).map_err(|_| AppError::RemoteProtocolMismatch)?;
        if envelope.v != 1 || envelope.family != "HTTP_RELAY" {
            return Err(AppError::RemoteProtocolMismatch);
        }
        match envelope.payload {
            Incoming::Request {
                generation,
                identity,
                request,
            } => {
                if generation != self.generation {
                    return Ok(Vec::new());
                }
                if self.pending.contains_key(&envelope.id) {
                    return Err(AppError::RemoteProtocolMismatch);
                }
                let media = matches!(request, HttpOperation::SessionAssetGet { .. });
                let owned = self
                    .pending
                    .values()
                    .filter(|p| p.participant_id == identity.participant_id);
                if self.pending.len() >= MAX_REQUESTS
                    || owned.clone().count() >= 4
                    || (media
                        && (owned.filter(|p| p.media).count() >= 1
                            || self.pending.values().filter(|p| p.media).count() >= MAX_MEDIA))
                {
                    return Ok(self.error(envelope.id, "REMOTE_SERVICE_UNAVAILABLE"));
                }
                // Permits outlive cancellation of the async wrapper if an existing
                // SQLite/integrity read is already running on the blocking pool.
                let Ok(read_permit) = self.budget.readers.clone().try_acquire_owned() else {
                    return Ok(self.error(envelope.id, "REMOTE_SERVICE_UNAVAILABLE"));
                };
                let media_permit = if media {
                    match self.budget.media.clone().try_acquire_owned() {
                        Ok(permit) => Some(permit),
                        Err(_) => return Ok(self.error(envelope.id, "REMOTE_SERVICE_UNAVAILABLE")),
                    }
                } else {
                    None
                };
                let participant_id = identity.participant_id.clone();
                let service = self.service.clone();
                let instance = self.instance.clone();
                let session_id = self.session_id.clone();
                let sender = self.sender.clone();
                let id = envelope.id;
                let task = tokio::spawn(async move {
                    let prepared = tokio::task::spawn_blocking(move || {
                        let _read_permit = read_permit;
                        Prepared {
                            id,
                            response: service.read(identity, &instance, Some(&session_id), request),
                            media_permit,
                        }
                    })
                    .await
                    .unwrap_or_else(|_| Prepared {
                        id,
                        response: HttpReadResponse::error(
                            500,
                            "REQUEST_FAILED",
                            "無法讀取課堂資料。",
                        ),
                        media_permit: None,
                    });
                    let _ = sender.send(prepared).await;
                });
                let now = Instant::now();
                self.pending.insert(
                    id,
                    Pending {
                        media_permit: None,
                        task: Some(task),
                        response: None,
                        participant_id,
                        media,
                        deadline: now + if media { MEDIA_TIMEOUT } else { DETAIL_TIMEOUT },
                        progress: now,
                        offset: 0,
                        sequence: 0,
                        credits: 0,
                    },
                );
                Ok(Vec::new())
            }
            Incoming::Cancel { generation } => {
                if generation == self.generation {
                    self.remove(envelope.id);
                }
                Ok(Vec::new())
            }
            Incoming::Credit {
                generation,
                credits,
            } => {
                if generation != self.generation {
                    return Ok(Vec::new());
                }
                let Some(pending) = self.pending.get_mut(&envelope.id) else {
                    return Ok(Vec::new());
                };
                if credits == 0
                    || credits > HTTP_WINDOW
                    || pending.credits + credits > HTTP_WINDOW
                    || pending.response.is_none()
                {
                    return Err(AppError::RemoteProtocolMismatch);
                }
                pending.credits += credits;
                pending.progress = Instant::now();
                Ok(self.pump(envelope.id))
            }
        }
    }

    pub(crate) async fn prepared(&mut self) -> Option<Prepared> {
        self.receiver.recv().await
    }

    pub(crate) fn ready(&mut self, prepared: Prepared) -> Vec<Value> {
        let Some(pending) = self.pending.get_mut(&prepared.id) else {
            return Vec::new();
        };
        let response = prepared.response;
        let limit = if pending.media {
            MAX_MEDIA_BYTES
        } else {
            MAX_DETAIL_BYTES
        };
        if response.bytes.len() > limit
            || !matches!(
                response.content_type.as_str(),
                "application/json" | "application/pdf" | "image/png" | "image/jpeg" | "image/webp"
            )
            || !matches!(response.status, 200 | 400 | 401 | 404 | 500)
        {
            self.remove(prepared.id);
            return self.error(prepared.id, "RESPONSE_INVALID");
        }
        let start = json!({"op":"HTTP_RESPONSE_START","status":response.status,
            "contentType":response.content_type,"contentLength":response.bytes.len()});
        pending.task = None;
        pending.media_permit = prepared.media_permit;
        pending.response = Some(response);
        pending.progress = Instant::now();
        vec![self.frame(prepared.id, start)]
    }

    fn pump(&mut self, id: Uuid) -> Vec<Value> {
        let mut payloads = Vec::with_capacity(HTTP_WINDOW + 1);
        let mut complete = false;
        if let Some(pending) = self.pending.get_mut(&id) {
            if let Some(response) = &pending.response {
                while pending.credits > 0 && pending.offset < response.bytes.len() {
                    let end = (pending.offset + HTTP_CHUNK_BYTES).min(response.bytes.len());
                    // Encode one bounded chunk only; never create a full-file base64 String.
                    let data = STANDARD.encode(&response.bytes[pending.offset..end]);
                    payloads.push(
                        json!({"op":"HTTP_RESPONSE_CHUNK","sequence":pending.sequence,"data":data}),
                    );
                    pending.sequence += 1;
                    pending.offset = end;
                    pending.credits -= 1;
                    pending.progress = Instant::now();
                }
                if pending.offset == response.bytes.len() {
                    payloads.push(json!({"op":"HTTP_RESPONSE_END","chunks":pending.sequence,"bytes":pending.offset}));
                    complete = true;
                }
            }
        }
        if complete {
            self.remove(id);
        }
        payloads
            .into_iter()
            .map(|payload| self.frame(id, payload))
            .collect()
    }

    fn remove(&mut self, id: Uuid) {
        if let Some(pending) = self.pending.remove(&id) {
            if let Some(task) = pending.task {
                task.abort();
            }
        }
    }

    pub(crate) fn expire(&mut self) -> Vec<Value> {
        let now = Instant::now();
        let expired: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| {
                now >= p.deadline
                    || (p.media && now.duration_since(p.progress) >= MEDIA_IDLE_TIMEOUT)
            })
            .map(|(id, _)| *id)
            .collect();
        let mut frames = Vec::new();
        for id in expired {
            self.remove(id);
            frames.extend(self.error(id, "REQUEST_TIMEOUT"));
        }
        frames
    }
}

impl Drop for RemoteHttp {
    fn drop(&mut self) {
        for pending in self.pending.values() {
            if let Some(task) = &pending.task {
                task.abort();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn actor() -> (RemoteHttp, tempfile::TempDir) {
        use crate::infrastructure::persistence::database::Database;
        let dir = tempfile::tempdir().expect("fixture");
        let db = Database::open_in_app_data(dir.path()).expect("database");
        db.initialize().expect("schema");
        let sessions = super::super::LocalSessionService::initialize(db.clone()).expect("session");
        let quiz = super::super::LiveQuizService::initialize(db, dir.path()).expect("quiz");
        (
            RemoteHttp::new(
                ParticipantHttpService::new(sessions, quiz),
                Uuid::now_v7().to_string(),
                &"a".repeat(32),
                1,
                HttpReadBudget::default(),
            ),
            dir,
        )
    }
    fn ready_bytes(actor: &mut RemoteHttp, id: Uuid, bytes: Vec<u8>) {
        let now = Instant::now();
        actor.pending.insert(
            id,
            Pending {
                media_permit: None,
                task: None,
                response: None,
                participant_id: "fixture".to_owned(),
                media: true,
                deadline: now + MEDIA_TIMEOUT,
                progress: now,
                offset: 0,
                sequence: 0,
                credits: 0,
            },
        );
        assert_eq!(
            actor.ready(Prepared {
                id,
                media_permit: None,
                response: HttpReadResponse {
                    status: 200,
                    content_type: "application/pdf".to_owned(),
                    bytes
                }
            })[0]["payload"]["op"],
            "HTTP_RESPONSE_START"
        );
    }
    fn incoming(id: Uuid, payload: Value) -> String {
        json!({"v":1,"type":"HTTP_RELAY","id":id,"payload":payload}).to_string()
    }
    #[tokio::test]
    async fn http_native_credit_reconstruction_and_envelope_ceiling() {
        let (mut actor, _dir) = actor();
        let id = Uuid::now_v7();
        let expected = vec![173; HTTP_CHUNK_BYTES * 9 + 17];
        ready_bytes(&mut actor, id, expected.clone());
        assert!(actor.pump(id).is_empty());
        let mut received = Vec::new();
        let mut sequence = 0;
        while actor.pending.contains_key(&id) {
            let frames = actor
                .handle(&incoming(
                    id,
                    json!({"op":"HTTP_CREDIT","generation":1,"credits":4}),
                ))
                .await
                .expect("credits");
            assert!(
                frames
                    .iter()
                    .filter(|f| f["payload"]["op"] == "HTTP_RESPONSE_CHUNK")
                    .count()
                    <= HTTP_WINDOW
            );
            for frame in frames {
                assert!(frame.to_string().len() < 64 * 1024);
                if frame["payload"]["op"] == "HTTP_RESPONSE_CHUNK" {
                    assert_eq!(frame["payload"]["sequence"], sequence);
                    sequence += 1;
                    received.extend(
                        STANDARD
                            .decode(frame["payload"]["data"].as_str().expect("data"))
                            .expect("chunk"),
                    );
                } else {
                    assert_eq!(frame["payload"]["op"], "HTTP_RESPONSE_END");
                    assert_eq!(frame["payload"]["bytes"], expected.len());
                }
            }
        }
        assert_eq!(received, expected);
    }
    #[tokio::test]
    async fn http_native_cancel_timeout_and_stale_generation_never_continue_chunks() {
        let (mut actor, _dir) = actor();
        let id = Uuid::now_v7();
        ready_bytes(&mut actor, id, vec![0; HTTP_CHUNK_BYTES * 8]);
        assert!(actor
            .handle(&incoming(
                id,
                json!({"op":"HTTP_CREDIT","generation":2,"credits":4})
            ))
            .await
            .expect("stale")
            .is_empty());
        actor
            .handle(&incoming(id, json!({"op":"HTTP_CANCEL","generation":1})))
            .await
            .expect("cancel");
        assert!(!actor.pending.contains_key(&id));
        ready_bytes(&mut actor, id, vec![0; 1]);
        actor.pending.get_mut(&id).expect("pending").deadline = Instant::now();
        assert_eq!(actor.expire()[0]["payload"]["code"], "REQUEST_TIMEOUT");
        assert!(actor.pending.is_empty());
    }
    #[tokio::test]
    async fn http_native_rejects_unknown_operations_paths_and_unbounded_credits() {
        let (mut actor, _dir) = actor();
        let id = Uuid::now_v7();
        let identity = json!({"sessionId":Uuid::now_v7(),"participantId":Uuid::now_v7(),"credential":"A".repeat(43)});
        for request in [
            json!({"operation":"HTTP_PROXY","arguments":{"url":"http://127.0.0.1"}}),
            json!({"operation":"SESSION_ASSET_GET","arguments":{"assetId":"x"},"path":"../secret"}),
        ] {
            assert!(actor.handle(&incoming(id,json!({"op":"HTTP_REQUEST","generation":1,"identity":identity,"request":request}))).await.is_err());
        }
        ready_bytes(&mut actor, id, vec![0; 1]);
        assert!(actor
            .handle(&incoming(
                id,
                json!({"op":"HTTP_CREDIT","generation":1,"credits":5})
            ))
            .await
            .is_err());
    }
    #[tokio::test]
    async fn http_native_media_budget_survives_generation_actor_replacement() {
        let (mut actor, _dir) = actor();
        let budget = actor.budget.clone();
        let mut ids = Vec::new();
        for _ in 0..MAX_MEDIA {
            let id = Uuid::now_v7();
            ready_bytes(&mut actor, id, vec![0; HTTP_CHUNK_BYTES]);
            actor.pending.get_mut(&id).expect("pending").media_permit = Some(
                budget
                    .media
                    .clone()
                    .try_acquire_owned()
                    .expect("bounded permit"),
            );
            ids.push(id);
        }
        let mut next = RemoteHttp::new(
            actor.service.clone(),
            actor.session_id.clone(),
            &"a".repeat(32),
            2,
            budget,
        );
        let id = Uuid::now_v7();
        let raw = incoming(
            id,
            json!({"op":"HTTP_REQUEST","generation":2,
            "identity":{"sessionId":next.session_id,"participantId":Uuid::now_v7(),"credential":"A".repeat(43)},
            "request":{"operation":"SESSION_ASSET_GET","arguments":{"assetId":Uuid::now_v7()}}}),
        );
        assert_eq!(
            next.handle(&raw).await.expect("bounded")[0]["payload"]["code"],
            "REMOTE_SERVICE_UNAVAILABLE"
        );
        actor.remove(ids[0]);
        assert!(next.handle(&raw).await.expect("permit released").is_empty());
        let prepared = next.prepared().await.expect("authoritative read");
        assert_eq!(next.ready(prepared)[0]["payload"]["status"], 401);
    }
}
