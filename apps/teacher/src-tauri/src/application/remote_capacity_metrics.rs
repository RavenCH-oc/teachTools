//! Test-only bounded diagnostics. Never records credentials, identities or domain bodies.
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
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
    pass_b: Option<PassBBudget>,
}

/// Pure reservation state. A rejected frame is never counted as reserved/sent.
struct PassBBudget {
    deadline: Instant,
    raw: u64,
    wire: u64,
    denied: u64,
    stopped: bool,
}
impl PassBBudget {
    fn reserve(&mut self, raw: u64, wire: u64, now: Instant) -> bool {
        let allowed = !self.stopped
            && now < self.deadline
            && self
                .raw
                .checked_add(raw)
                .is_some_and(|n| n <= 1024 * 1024 * 1024)
            && self
                .wire
                .checked_add(wire)
                .is_some_and(|n| n <= 2 * 1024 * 1024 * 1024);
        if allowed {
            self.raw += raw;
            self.wire += wire;
        } else {
            self.denied += 1;
            self.stopped = true;
        }
        allowed
    }
}

pub fn enable_pass_b(remaining_work: Duration) -> Result<(), &'static str> {
    let mut s = state().lock().map_err(|_| "METRICS_UNAVAILABLE")?;
    if s.enabled || remaining_work.is_zero() || remaining_work > Duration::from_secs(1800) {
        return Err("BUDGET_INVALID");
    }
    let now = Instant::now();
    *s = Metrics {
        enabled: true,
        began: Some(now),
        pass_b: Some(PassBBudget {
            deadline: now + remaining_work,
            raw: 0,
            wire: 0,
            denied: 0,
            stopped: false,
        }),
        ..Default::default()
    };
    Ok(())
}

pub fn stop_pass_b() {
    if let Ok(mut s) = state().lock() {
        if let Some(budget) = s.pass_b.as_mut() {
            budget.stopped = true;
            s.stopped = true;
        }
    }
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
    let s = state().lock().expect("test metrics lock");
    s.stopped
        || s.pass_b
            .as_ref()
            .is_some_and(|budget| Instant::now() >= budget.deadline)
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
    let raw_chunk_bytes = if op == "HTTP_RESPONSE_CHUNK" {
        let data = value["payload"]["data"].as_str().expect("chunk");
        (data.len() / 4 * 3 - data.bytes().rev().take_while(|b| *b == b'=').count()) as u64
    } else {
        0
    };
    if let Some(budget) = s.pass_b.as_mut() {
        if !budget.reserve(raw_chunk_bytes, raw.len() as u64, Instant::now()) {
            s.stopped = true;
            return false;
        }
    }
    let key = format!("{family}:{op}");
    *s.counts.entry(key).or_default() += 1;
    s.wire_bytes += raw.len() as u64;
    if op == "HTTP_RESPONSE_CHUNK" {
        s.raw_bytes += raw_chunk_bytes;
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
        "budgetStopped":s.stopped || s.pass_b.as_ref().is_some_and(|budget| Instant::now() >= budget.deadline),
        "deniedBeforeSend":s.pass_b.as_ref().map(|budget|budget.denied),
        "teacherFrames":s.counts,"pendingHigh":s.pending_high,
        "activeReaders":s.readers.as_ref().map(|v|8-v.available_permits()),
        "activeMedia":s.media.as_ref().map(|v|4-v.available_permits()),
        "creditWaiters":s.waiting.len(),"sendWaitMs":s.send_wait_ms,"sendWaitMaxMs":s.send_wait_max_ms,
        "requests":s.requests,"timeline":s.timeline})
}

#[cfg(test)]
mod pass_b_tests {
    use super::*;
    #[test]
    fn pass_b_reservations_cover_retries_cancel_reconnect_and_fail_closed() {
        let now = Instant::now();
        let mut budget = PassBBudget {
            deadline: now + Duration::from_secs(60),
            raw: 0,
            wire: 0,
            denied: 0,
            stopped: false,
        };
        // Repeated chunks are still reserved; cancellation/control consumes wire.
        assert!(budget.reserve(32_768, 44_000, now));
        assert!(budget.reserve(32_768, 44_000, now));
        assert!(budget.reserve(0, 200, now));
        assert_eq!((budget.raw, budget.wire), (65_536, 88_200));
        budget.raw = 1024 * 1024 * 1024;
        assert!(!budget.reserve(1, 1, now));
        assert_eq!(budget.raw, 1024 * 1024 * 1024);
        assert!(!budget.reserve(0, 1, now)); // reconnect cannot reset budget
    }
    #[test]
    fn pass_b_wire_deadline_and_overflow_stop_before_send() {
        let now = Instant::now();
        let mut budget = PassBBudget {
            deadline: now,
            raw: 0,
            wire: 0,
            denied: 0,
            stopped: false,
        };
        assert!(!budget.reserve(0, 1, now));
        budget.deadline = now + Duration::from_secs(10);
        budget.stopped = false;
        budget.wire = 2 * 1024 * 1024 * 1024;
        assert!(!budget.reserve(0, 1, now));
        budget.stopped = false;
        assert!(!budget.reserve(u64::MAX, u64::MAX, now));
    }
}
