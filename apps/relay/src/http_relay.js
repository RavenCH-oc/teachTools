import { encodeEnvelope, hasKeys, SECRET_PATTERN, UUID_PATTERN } from "./contract.js";

export const HTTP_CHUNK_BYTES = 32 * 1024;
export const HTTP_WINDOW = 4;
export const HTTP_LIMITS = Object.freeze({ requests: 64, participantRequests: 4, media: 4, participantMedia: 1,
  detailTimeout: 15000, mediaTimeout: 600000, mediaIdle: 20000, detailBytes: 16 * 1024 * 1024, mediaBytes: 100 * 1024 * 1024 });
const specs = Object.freeze({
  PEER_REVIEW_ACTIVITIES_LIST: { page: true },
  PEER_REVIEW_ACTIVITY_GET: { id: "activityId" },
  PEER_REVIEW_CANDIDATES_LIST: { id: "activityId", page: true },
  PEER_REVIEW_ESSAYS_LIST: { id: "assignmentId", page: true },
  PEER_REVIEW_FEEDBACK_LIST: { optionalId: "activityId", page: true },
  PEER_REVIEW_FEEDBACK_GET: { id: "assignmentId" },
  PEER_REVIEW_OWN_REVIEW_GET: { id: "assignmentId" },
  SESSION_ASSET_GET: { id: "assetId" },
});
export const HTTP_OPERATIONS = Object.freeze(Object.keys(specs));

export function validHttpOperation(request) {
  if (!hasKeys(request, ["operation", "arguments"])) return false;
  const spec = typeof request.operation === "string" && Object.hasOwn(specs, request.operation) ? specs[request.operation] : null;
  if (!spec || !request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments)) return false;
  const args = request.arguments;
  const allowed = [spec.id, spec.optionalId, spec.page ? "page" : null].filter(Boolean);
  if (Object.keys(args).some(key => !allowed.includes(key))) return false;
  if (spec.id && !UUID_PATTERN.test(args[spec.id] ?? "")) return false;
  if (spec.optionalId && args[spec.optionalId] !== undefined && !UUID_PATTERN.test(args[spec.optionalId])) return false;
  if (spec.page) {
    const page = args.page;
    if (!page || typeof page !== "object" || Array.isArray(page) || Object.keys(page).some(key => !["limit", "cursor"].includes(key))) return false;
    if (page.limit !== undefined && (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100)) return false;
    if (page.cursor !== undefined && (typeof page.cursor !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(page.cursor))) return false;
  }
  return true;
}

export function publicHttpRequest(url, headers, operation) {
  const spec = typeof operation === "string" && Object.hasOwn(specs, operation) ? specs[operation] : null;
  if (!spec || headers.has("range")) return null;
  const allowed = [spec.id, spec.optionalId, ...(spec.page ? ["limit", "cursor"] : [])].filter(Boolean);
  const args = {};
  const page = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return null;
    if (key === "limit") { if (!/^[1-9][0-9]{0,2}$/.test(value)) return null; page.limit = Number(value); }
    else if (key === "cursor") page.cursor = value;
    else args[key] = value;
  }
  if (spec.page) args.page = page;
  const credential = headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  const sessionId = headers.get("x-classroom-session");
  const participantId = headers.get("x-classroom-participant");
  const request = { operation, arguments: args };
  if (!credential || !UUID_PATTERN.test(sessionId ?? "") || !UUID_PATTERN.test(participantId ?? "") || !validHttpOperation(request)) return null;
  return { identity: { sessionId, participantId, credential }, request };
}

export function httpError(code, status = 503) {
  const message = code === "TEACHER_UNAVAILABLE" ? "教師端暫時離線，請稍後重試。"
    : code === "REQUEST_TIMEOUT" ? "讀取逾時，請稍後重試。"
    : code === "AUTH_REQUIRED" ? "請重新連線課堂。" : "遠端服務暫時無法使用，請稍後重試。";
  return new Response(JSON.stringify({ code, message }), { status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

// Nothing in this map is durable. No credential, request body or domain result is
// stored in attachments/KV/SQLite. Pending responses keep at most one credit window.
export class HttpRelay {
  constructor(send, schedule, now = Date.now, keepAlive = () => {}) { this.pending = new Map(); this.send = send; this.schedule = schedule; this.now = now; this.keepAlive = keepAlive; }

  open(request, body, generation, teacher) {
    if (!hasKeys(body, ["identity", "request"]) || !hasKeys(body.identity, ["sessionId", "participantId", "credential"])
      || !UUID_PATTERN.test(body.identity.sessionId ?? "") || !UUID_PATTERN.test(body.identity.participantId ?? "")
      || !SECRET_PATTERN.test(body.identity.credential ?? "") || !validHttpOperation(body.request)) {
      return httpError("MALFORMED_MESSAGE", 400);
    }
    const media = body.request.operation === "SESSION_ASSET_GET";
    const owner = body.identity.sessionId + ":" + body.identity.participantId;
    const owned = [...this.pending.values()].filter(p => p.owner === owner);
    if (this.pending.size >= HTTP_LIMITS.requests || owned.length >= HTTP_LIMITS.participantRequests
      || (media && (owned.some(p => p.media) || [...this.pending.values()].filter(p => p.media).length >= HTTP_LIMITS.media))) {
      return httpError("REMOTE_SERVICE_UNAVAILABLE", 429);
    }
    const id = crypto.randomUUID();
    const now = this.now();
    let resolve;
    const response = new Promise(done => { resolve = done; });
    const entry = { id, owner, generation, teacher, media, resolve, started: false, queue: [], waiting: false,
      received: 0, chunks: 0, credits: 0, ended: false,
      deadline: now + (media ? HTTP_LIMITS.mediaTimeout : HTTP_LIMITS.detailTimeout), idle: now + HTTP_LIMITS.mediaIdle };
    entry.stream = new ReadableStream({
      start: controller => { entry.controller = controller; },
      pull: () => this.pull(entry),
      cancel: () => this.fail(entry, "REQUEST_CANCELLED"),
    }, { highWaterMark: 0 });
    this.pending.set(id, entry);
    entry.abort = () => this.fail(entry, "REQUEST_CANCELLED");
    request.signal.addEventListener("abort", entry.abort, { once: true });
    entry.signal = request.signal;
    if (request.signal.aborted) { this.fail(entry, "REQUEST_CANCELLED"); return response; }
    const raw = encodeEnvelope("HTTP_RELAY", id, { op: "HTTP_REQUEST", generation, ...body });
    if (!raw || !this.send(teacher, raw)) this.fail(entry, "TEACHER_UNAVAILABLE");
    this.schedule();
    return response;
  }

  credit(entry, count) {
    if (entry.ended || !this.pending.has(entry.id)) return;
    entry.credits += count;
    const raw = encodeEnvelope("HTTP_RELAY", entry.id, { op: "HTTP_CREDIT", generation: entry.generation, credits: count });
    if (!this.send(entry.teacher, raw)) this.fail(entry, "TEACHER_UNAVAILABLE");
  }

  pull(entry) {
    if (!this.pending.has(entry.id)) return;
    if (entry.queue.length) {
      entry.controller.enqueue(entry.queue.shift());
      this.credit(entry, 1);
      if (entry.ended && entry.queue.length === 0) this.finish(entry);
    } else if (entry.ended) this.finish(entry);
    else entry.waiting = true;
  }

  remove(entry) {
    this.pending.delete(entry.id);
    entry.signal.removeEventListener("abort", entry.abort);
    entry.queue.length = 0;
    this.schedule();
  }

  finish(entry) { this.remove(entry); entry.controller.close(); }

  fail(entry, code) {
    if (!this.pending.has(entry.id)) return;
    this.remove(entry);
    if (entry.started) entry.controller.error(new Error("Remote response interrupted"));
    else { entry.controller.close(); entry.resolve(httpError(code, code === "REQUEST_TIMEOUT" ? 504 : 503)); }
    const raw = encodeEnvelope("HTTP_RELAY", entry.id, { op: "HTTP_CANCEL", generation: entry.generation });
    try { this.send(entry.teacher, raw); } catch { /* transport may already be closed */ }
  }

  failAll(code = "TEACHER_UNAVAILABLE") { for (const entry of [...this.pending.values()]) this.fail(entry, code); }
  deadlines() { return [...this.pending.values()].flatMap(p => p.media ? [p.deadline, p.idle] : [p.deadline]); }
  expire() { const now = this.now(); for (const entry of [...this.pending.values()]) if (now >= entry.deadline || (entry.media && now >= entry.idle)) this.fail(entry, "REQUEST_TIMEOUT"); }

  handle(value, teacher) {
    const payload = value.payload;
    const entry = this.pending.get(value.id);
    if (!entry) {
      // A reconstructed DO cannot recover the old HTTP stream. Stop native work.
      const cancel = encodeEnvelope("HTTP_RELAY", value.id, { op: "HTTP_CANCEL", generation: payload.generation });
      if (cancel) this.send(teacher, cancel);
      return;
    }
    if (entry.generation !== payload.generation || entry.teacher !== teacher) return;
    const bad = () => this.fail(entry, "RESPONSE_INVALID");
    if (payload.op === "HTTP_RESPONSE_START") {
      const types = entry.media ? ["application/json", "application/pdf", "image/png", "image/jpeg", "image/webp"] : ["application/json"];
      const max = entry.media ? HTTP_LIMITS.mediaBytes : HTTP_LIMITS.detailBytes;
      if (entry.started || !hasKeys(payload, ["op", "generation", "status", "contentType", "contentLength"])
        || ![200, 400, 401, 404, 500].includes(payload.status) || !types.includes(payload.contentType)
        || !Number.isSafeInteger(payload.contentLength) || payload.contentLength < 0 || payload.contentLength > max) { bad(); return; }
      entry.started = true;
      entry.length = payload.contentLength;
      // Workers ignores a manually set Content-Length on an arbitrary stream.
      // FixedLengthStream makes interrupted/truncated output fail at HTTP level.
      const fixed = new FixedLengthStream(payload.contentLength);
      this.keepAlive(entry.stream.pipeTo(fixed.writable).catch(() => this.fail(entry, "REQUEST_CANCELLED")));
      entry.resolve(new Response(fixed.readable, { status: payload.status, headers: {
        "content-type": payload.contentType, "content-length": String(payload.contentLength),
        "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      } }));
      this.credit(entry, HTTP_WINDOW);
    } else if (payload.op === "HTTP_RESPONSE_CHUNK") {
      if (!entry.started || entry.ended || entry.credits <= 0 || !hasKeys(payload, ["op", "generation", "sequence", "data"])
        || payload.sequence !== entry.chunks || typeof payload.data !== "string" || payload.data.length > Math.ceil(HTTP_CHUNK_BYTES / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.data)) { bad(); return; }
      let bytes;
      try { bytes = Uint8Array.from(atob(payload.data), c => c.charCodeAt(0)); } catch { bad(); return; }
      if (!bytes.length || bytes.length > HTTP_CHUNK_BYTES || entry.received + bytes.length > entry.length || entry.queue.length >= HTTP_WINDOW) { bad(); return; }
      entry.credits -= 1; entry.chunks += 1; entry.received += bytes.length; entry.idle = this.now() + HTTP_LIMITS.mediaIdle;
      if (entry.waiting) { entry.waiting = false; entry.controller.enqueue(bytes); this.credit(entry, 1); }
      else entry.queue.push(bytes);
    } else if (payload.op === "HTTP_RESPONSE_END") {
      if (!entry.started || entry.ended || !hasKeys(payload, ["op", "generation", "chunks", "bytes"])
        || payload.chunks !== entry.chunks || payload.bytes !== entry.received || entry.received !== entry.length) { bad(); return; }
      entry.ended = true;
      if (!entry.queue.length) this.finish(entry);
    } else if (payload.op === "HTTP_ERROR") {
      if (!hasKeys(payload, ["op", "generation", "code"]) || !["REQUEST_TIMEOUT", "REMOTE_SERVICE_UNAVAILABLE", "RESPONSE_INVALID"].includes(payload.code)) { bad(); return; }
      this.fail(entry, payload.code);
    } else bad();
    // The earlier armed alarm is safe when idle deadlines move later. Avoid a
    // storage alarm write for every media chunk; alarm() re-arms after checking.
  }
}
