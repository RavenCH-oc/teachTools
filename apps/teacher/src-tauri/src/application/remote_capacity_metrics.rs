//! Test-only bounded diagnostics. Never records credentials, identities or domain bodies.
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};
use tokio::sync::Semaphore;
use uuid::Uuid;
#[derive(Default)]
struct Metrics {
    enabled: bool,
    began: Option<Instant>,
    timeline: Vec<Value>,
    raw_bytes: u64,
    wire_bytes: u64,
    stopped: bool,
    counts: BTreeMap<String, u64>,
    requests: BTreeMap<String, Value>,
    waiting: BTreeMap<String, Instant>,
    pending_high: usize,
    readers: Option<Arc<Semaphore>>,
    media: Option<Arc<Semaphore>>,
    send_wait_ms: f64,
    send_wait_max_ms: f64,
}
static STATE: OnceLock<Mutex<Metrics>> = OnceLock::new();
thread_local! { static REQUEST: RefCell<Option<Uuid>> = const { RefCell::new(None) }; }
fn state() -> &'static Mutex<Metrics> {
    STATE.get_or_init(|| Mutex::new(Metrics::default()))
}
pub fn enable() {
    *state().lock().expect("test metrics lock") = Metrics {
        enabled: true,
        began: Some(Instant::now()),
        ..Default::default()
    };
}
pub fn enabled() -> bool {
    state().lock().expect("test metrics lock").enabled
}
pub fn stopped() -> bool {
    state().lock().expect("test metrics lock").stopped
}
pub fn budget(readers: Arc<Semaphore>, media: Arc<Semaphore>) {
    let mut s = state().lock().expect("test metrics lock");
    if s.enabled {
        s.readers = Some(readers);
        s.media = Some(media);
    }
}
pub fn pending(n: usize) {
    let mut s = state().lock().expect("test metrics lock");
    if s.enabled {
        s.pending_high = s.pending_high.max(n);
    }
}
pub fn reading<T>(id: Uuid, read: impl FnOnce() -> T) -> T {
    if !enabled() {
        return read();
    }
    REQUEST.with(|v| *v.borrow_mut() = Some(id));
    let start = Instant::now();
    let result = read();
    event(id, "read_total_ms", start.elapsed().as_secs_f64() * 1000.0);
    REQUEST.with(|v| *v.borrow_mut() = None);
    result
}
pub fn current(name: &str, ms: f64) {
    REQUEST.with(|v| {
        if let Some(id) = *v.borrow() {
            event(id, name, ms);
        }
    });
}
pub fn event(id: Uuid, name: &str, value: f64) {
    let mut s = state().lock().expect("test metrics lock");
    if !s.enabled {
        return;
    }
    let key = id.to_string();
    if s.requests.len() >= 2048 && !s.requests.contains_key(&key) {
        return;
    }
    s.requests.entry(key).or_insert_with(|| json!({}))[name] = json!(value);
}
pub fn starved(id: Uuid) {
    let mut s = state().lock().expect("test metrics lock");
    if s.enabled {
        s.waiting.entry(id.to_string()).or_insert_with(Instant::now);
    }
}
pub fn credit(id: Uuid) {
    let mut s = state().lock().expect("test metrics lock");
    if !s.enabled {
        return;
    }
    if let Some(start) = s.waiting.remove(&id.to_string()) {
        let row = s
            .requests
            .entry(id.to_string())
            .or_insert_with(|| json!({}));
        let old = row["credit_wait_ms"].as_f64().unwrap_or(0.0);
        row["credit_wait_ms"] = json!(old + start.elapsed().as_secs_f64() * 1000.0);
        row["credit_grants"] = json!(row["credit_grants"].as_u64().unwrap_or(0) + 1);
    }
}
pub fn removed(id: Uuid) {
    state()
        .lock()
        .expect("test metrics lock")
        .waiting
        .remove(&id.to_string());
}
pub fn received(raw: &str) {
    let mut s = state().lock().expect("test metrics lock");
    if !s.enabled {
        return;
    }
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        trace_frame(&mut s, "in", &value);
    }
}
fn trace_frame(s: &mut Metrics, direction: &str, value: &Value) {
    let family = value["type"].as_str().unwrap_or("unknown");
    let op = value["payload"]["op"]
        .as_str()
        .or_else(|| value["payload"]["message"]["type"].as_str())
        .unwrap_or("other");
    if s.timeline.len() >= 2048
        || (family == "HTTP_RELAY"
            && !matches!(
                op,
                "HTTP_REQUEST" | "HTTP_RESPONSE_START" | "HTTP_RESPONSE_END" | "HTTP_ERROR"
            ))
        || (family != "CONTROL" && (op == "pong" || op == "ping"))
        || op == "quiz_state"
    {
        return;
    }
    s.timeline.push(json!({"atMs":s.began.map(|t|t.elapsed().as_secs_f64()*1000.0),"direction":direction,"id":value["id"],"family":family,"op":op,"generation":value["payload"]["generation"]}));
}
pub fn sent(raw: &str) -> bool {
    let mut s = state().lock().expect("test metrics lock");
    if !s.enabled {
        return true;
    }
    let value: Value = serde_json::from_str(raw).expect("valid native frame");
    trace_frame(&mut s, "out", &value);
    let family = value["type"].as_str().unwrap_or("unknown");
    let op = value["payload"]["op"]
        .as_str()
        .or_else(|| value["payload"]["message"]["type"].as_str())
        .unwrap_or("other");
    let key = format!("{family}:{op}");
    *s.counts.entry(key).or_default() += 1;
    s.wire_bytes += raw.len() as u64;
    if op == "HTTP_RESPONSE_CHUNK" {
        let data = value["payload"]["data"].as_str().expect("chunk");
        s.raw_bytes +=
            (data.len() / 4 * 3 - data.bytes().rev().take_while(|b| *b == b'=').count()) as u64;
    }
    // Conservative pre-send accounting includes cancelled/retried transfers.
    s.stopped |= s.raw_bytes > 1024 * 1024 * 1024 || s.wire_bytes > 2 * 1024 * 1024 * 1024;
    !s.stopped
}
pub fn send_wait(ms: f64) {
    let mut s = state().lock().expect("test metrics lock");
    if s.enabled {
        s.send_wait_ms += ms;
        s.send_wait_max_ms = s.send_wait_max_ms.max(ms);
    }
}
pub fn snapshot() -> Value {
    let s = state().lock().expect("test metrics lock");
    json!({"nativeRawBytesReserved":s.raw_bytes,"teacherWsUtf8BytesReserved":s.wire_bytes,
        "budgetStopped":s.stopped,"teacherFrames":s.counts,"pendingHigh":s.pending_high,
        "activeReaders":s.readers.as_ref().map(|v|8-v.available_permits()),
        "activeMedia":s.media.as_ref().map(|v|4-v.available_permits()),
        "creditWaiters":s.waiting.len(),"sendWaitMs":s.send_wait_ms,"sendWaitMaxMs":s.send_wait_max_ms,
        "requests":s.requests,"timeline":s.timeline})
}
