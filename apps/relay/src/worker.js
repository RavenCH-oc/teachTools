import { DurableObject } from "cloudflare:workers";
import {
  MAX_ENVELOPE_BYTES, REMOTE_PROTOCOL_VERSION, SECRET_PATTERN,
  SESSION_ID_PATTERN, UUID_PATTERN, clientRealtime, control, encodeEnvelope,
  hasKeys, participantAuth, readEnvelope, serverRealtime, transportError,
} from "./contract.js";
import { disconnectTeacher, ensureTeacherDeadline, expireRelay, expireTeacher, invalidateStudents } from "./lifecycle.js";

const encoder = new TextEncoder();
const REMOTE_SESSION_BYTES = 24;
const CREDENTIAL_BYTES = 32;
const MAX_CONTROL_BODY_BYTES = 4096;
const AUTH_TIMEOUT_MS = 5000;
const JOIN_TIMEOUT_MS = 8000;
const MAX_PENDING_JOINS = 128;
const MAX_STUDENT_SOCKETS = 512;
// Existing Teacher CONTROL ping cadence is 20 seconds. Three missed intervals
// bound silent network loss even when Cloudflare has not observed a TCP close.
const TEACHER_HEARTBEAT_TIMEOUT_MS = 60000;

function randomToken(bytes) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff" },
  });
}

function error(code, status) {
  return json({ code }, status);
}

function bearer(request) {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

async function bodyJson(request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_CONTROL_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_CONTROL_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

async function installation(request, env) {
  const credential = bearer(request);
  if (!credential || !SECRET_PATTERN.test(credential)) return null;
  const hash = await sha256(credential);
  return env.INSTALLATIONS.prepare(
    "SELECT id FROM installations WHERE credential_hash = ? AND status = 'ACTIVE'",
  ).bind(hash).first();
}

function stubFor(env, remoteSessionId) {
  return env.CLASSROOM_SESSION.getByName(remoteSessionId);
}

function internal(path, method, body, headers = {}) {
  return new Request(`https://relay.internal${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function integerSetting(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

async function operatorActivation(request, env) {
  const token = bearer(request);
  if (!env.OPERATOR_TOKEN || !equalSecret(token, env.OPERATOR_TOKEN)) {
    return error("AUTH_REJECTED", 403);
  }
  const body = await bodyJson(request);
  const ttlSeconds = body?.ttlSeconds ?? 600;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) {
    return error("MALFORMED_MESSAGE", 400);
  }
  const activationCode = randomToken(CREDENTIAL_BYTES);
  const expiresAt = Date.now() + ttlSeconds * 1000;
  await env.INSTALLATIONS.prepare(
    "INSERT INTO activation_codes(code_hash, expires_at, consumed_at) VALUES (?, ?, NULL)",
  ).bind(await sha256(activationCode), expiresAt).run();
  return json({ activationCode, expiresAt }, 201);
}

async function operatorRevoke(request, env, installationId) {
  const token = bearer(request);
  if (!env.OPERATOR_TOKEN || !equalSecret(token, env.OPERATOR_TOKEN)) {
    return error("AUTH_REJECTED", 403);
  }
  if (!/^[0-9a-f-]{36}$/i.test(installationId)) return error("MALFORMED_MESSAGE", 400);
  const result = await env.INSTALLATIONS.prepare(
    "UPDATE installations SET status = 'REVOKED', revoked_at = ? WHERE id = ? AND status = 'ACTIVE' RETURNING id",
  ).bind(Date.now(), installationId).first();
  return result ? new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
    : error("AUTH_REJECTED", 404);
}

async function enroll(request, env) {
  const body = await bodyJson(request);
  if (!body || !SECRET_PATTERN.test(body.activationCode ?? "")) {
    return error("AUTH_REJECTED", 403);
  }
  const now = Date.now();
  const consumed = await env.INSTALLATIONS.prepare(
    "UPDATE activation_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING code_hash",
  ).bind(now, await sha256(body.activationCode), now).first();
  if (!consumed) return error("AUTH_REJECTED", 403);
  const installationId = crypto.randomUUID();
  const installationCredential = randomToken(CREDENTIAL_BYTES);
  await env.INSTALLATIONS.prepare(
    "INSERT INTO installations(id, credential_hash, status, created_at, revoked_at) VALUES (?, ?, 'ACTIVE', ?, NULL)",
  ).bind(installationId, await sha256(installationCredential), now).run();
  return json({ installationId, installationCredential }, 201);
}

async function createSession(request, env) {
  const identity = await installation(request, env);
  if (!identity) return error("AUTH_REJECTED", 403);
  const body = await bodyJson(request);
  if (body?.remoteProtocolVersion !== REMOTE_PROTOCOL_VERSION) {
    return error("PROTOCOL_MISMATCH", 409);
  }
  if (typeof body.teacherAppVersion !== "string"
    || !/^[A-Za-z0-9.+-]{1,40}$/.test(body.teacherAppVersion)) {
    return error("MALFORMED_MESSAGE", 400);
  }
  const remoteSessionId = randomToken(REMOTE_SESSION_BYTES);
  const expiresAt = Date.now() + integerSetting(env.RELAY_MAX_LIFETIME_SECONDS, 43200, 3600, 86400) * 1000;
  const response = await stubFor(env, remoteSessionId).fetch(internal("/create", "POST", {
    remoteSessionId, installationId: identity.id,
    remoteProtocolVersion: REMOTE_PROTOCOL_VERSION, expiresAt,
  }));
  if (!response.ok) return error("REMOTE_SERVICE_UNAVAILABLE", 503);
  return json({ remoteSessionId, remoteProtocolVersion: REMOTE_PROTOCOL_VERSION, expiresAt }, 201);
}

async function issueTicket(request, env, remoteSessionId) {
  const identity = await installation(request, env);
  if (!identity) return error("AUTH_REJECTED", 403);
  const ticket = randomToken(CREDENTIAL_BYTES);
  const ticketExpiresAt = Date.now()
    + integerSetting(env.CONNECT_TICKET_TTL_SECONDS, 60, 15, 300) * 1000;
  const response = await stubFor(env, remoteSessionId).fetch(internal("/ticket", "POST", {
    installationId: identity.id, ticketHash: await sha256(ticket), ticketExpiresAt,
  }));
  if (!response.ok) return response;
  return json({ ticket, ticketExpiresAt });
}

async function teacherSocket(request, env, remoteSessionId) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return error("MALFORMED_MESSAGE", 426);
  }
  const ticket = bearer(request);
  if (!ticket || !SECRET_PATTERN.test(ticket)) return error("AUTH_REQUIRED", 401);
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("x-relay-ticket-hash");
  headers.set("x-relay-ticket-hash", await sha256(ticket));
  return stubFor(env, remoteSessionId).fetch(new Request(request, { headers }));
}

async function closeSession(request, env, remoteSessionId) {
  const identity = await installation(request, env);
  if (!identity) return error("AUTH_REJECTED", 403);
  const response = await stubFor(env, remoteSessionId).fetch(internal("/close", "POST", {
    installationId: identity.id,
  }));
  if (!response.ok) return response;
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function bootstrap(env, remoteSessionId) {
  return stubFor(env, remoteSessionId).fetch(internal("/bootstrap", "GET"));
}

async function studentJoin(request, env, remoteSessionId) {
  const body = await bodyJson(request);
  if (body?.remoteProtocolVersion !== REMOTE_PROTOCOL_VERSION) return error("PROTOCOL_MISMATCH", 409);
  if (!hasKeys(body, ["remoteProtocolVersion", "joinAttemptId", "seatNumber", "name"])
    || !UUID_PATTERN.test(body.joinAttemptId) || !Number.isSafeInteger(body.seatNumber) || body.seatNumber <= 0
    || typeof body.name !== "string" || !body.name.trim() || body.name.length > 200) {
    return error("MALFORMED_MESSAGE", 400);
  }
  return stubFor(env, remoteSessionId).fetch(internal("/join", "POST", body));
}

async function studentSocket(request, env, remoteSessionId) {
  const url = new URL(request.url);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return error("MALFORMED_MESSAGE", 426);
  if (url.search || (request.headers.has("origin") && request.headers.get("origin") !== url.origin)) {
    return error("AUTH_REJECTED", 403);
  }
  return stubFor(env, remoteSessionId).fetch(internal("/student-ws", "GET", undefined,
    { upgrade: "websocket" }));
}

function staticHeaders(response, request) {
  const headers = new Headers(response.headers);
  const url = new URL(request.url);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (url.protocol === "https:") headers.set("strict-transport-security", "max-age=31536000");
  if (headers.get("content-type")?.includes("text/html")) {
    headers.set("cache-control", "no-store");
    headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' wss://" + url.host + "; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  }
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/v1/operator/activation-codes" && request.method === "POST") {
        return operatorActivation(request, env);
      }
      const revoke = /^\/v1\/operator\/installations\/([^/]+)\/revoke$/.exec(path);
      if (revoke && request.method === "POST") return operatorRevoke(request, env, revoke[1]);
      if (path === "/v1/enroll" && request.method === "POST") return enroll(request, env);
      if (path === "/v1/teacher/sessions" && request.method === "POST") {
        return createSession(request, env);
      }
      const teacher = /^\/v1\/teacher\/sessions\/([^/]+)(?:\/(tickets|ws))?$/.exec(path);
      if (teacher) {
        const remoteSessionId = teacher[1];
        if (!SESSION_ID_PATTERN.test(remoteSessionId)) return error("MALFORMED_MESSAGE", 400);
        if (teacher[2] === "tickets" && request.method === "POST") {
          return issueTicket(request, env, remoteSessionId);
        }
        if (teacher[2] === "ws" && request.method === "GET") {
          return teacherSocket(request, env, remoteSessionId);
        }
        if (!teacher[2] && request.method === "DELETE") {
          return closeSession(request, env, remoteSessionId);
        }
      }
      const student = /^\/v1\/sessions\/([^/]+)\/(bootstrap|join|ws)$/.exec(path);
      if (student) {
        if (!SESSION_ID_PATTERN.test(student[1])) return error("MALFORMED_MESSAGE", 400);
        if (student[2] === "bootstrap" && request.method === "GET") return bootstrap(env, student[1]);
        if (student[2] === "join" && request.method === "POST") return studentJoin(request, env, student[1]);
        if (student[2] === "ws" && request.method === "GET") return studentSocket(request, env, student[1]);
      }
      if (path.startsWith("/v1/")) return error("MALFORMED_MESSAGE", 404);
      if (request.method !== "GET" && request.method !== "HEAD") return error("MALFORMED_MESSAGE", 405);
      if (path.startsWith("/join/") && !SESSION_ID_PATTERN.test(path.slice(6))) {
        return error("MALFORMED_MESSAGE", 404);
      }
      return staticHeaders(await env.ASSETS.fetch(request), request);
    } catch {
      return error("REMOTE_SERVICE_UNAVAILABLE", 503);
    }
  },
};

export class ClassroomSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pendingJoins = new Map();
    // Determine liveness before a wake-up re-auth broadcast, so a silent dead
    // Teacher cannot cause an AUTH attempt toward its obsolete connection.
    const before = this.meta();
    const now = Date.now();
    const current = expireTeacher(expireRelay(ensureTeacherDeadline(before, now, TEACHER_HEARTBEAT_TIMEOUT_MS), now), now);
    if (current !== before) {
      this.put(current);
    }
    if (current?.status === "EXPIRED" || current?.status === "CLOSED") {
      for (const socket of ctx.getWebSockets()) {
        try { socket.close(1008, "Session unavailable"); } catch { /* already closed */ }
      }
      return;
    }
    if (current?.status === "TEACHER_OFFLINE" && before?.status === "OPEN") {
      for (const teacher of ctx.getWebSockets("teacher")) {
        try { teacher.close(1008, "Teacher unavailable"); } catch { /* already closed */ }
      }
    }
    // Hibernation attachments contain only routing metadata. A fresh instance
    // revalidates every remaining Student through Rust instead of restoring trust.
    const students = invalidateStudents(ctx, this.meta(), now, AUTH_TIMEOUT_MS);
    if (students || current?.status === "OPEN") ctx.waitUntil(this.scheduleAlarm());
  }

  meta() {
    return this.ctx.storage.kv.get("relay");
  }

  put(meta) {
    this.ctx.storage.kv.put("relay", meta);
  }

  checkedMeta() {
    const meta = this.meta();
    const now = Date.now();
    const next = expireTeacher(expireRelay(meta, now), now);
    if (next !== meta) {
      this.put(next);
      if (next.status === "EXPIRED") {
        for (const socket of this.ctx.getWebSockets()) socket.close(1008, "Session expired");
      } else {
        this.failPendingJoins("TEACHER_UNAVAILABLE");
        invalidateStudents(this.ctx, next, now, AUTH_TIMEOUT_MS);
        for (const teacher of this.ctx.getWebSockets("teacher")) {
          try { teacher.close(1008, "Teacher unavailable"); } catch { /* already closed */ }
        }
      }
    }
    return next;
  }

  teacher(meta) {
    if (meta?.status !== "OPEN") return null;
    return this.ctx.getWebSockets("teacher").find((socket) => {
      const attachment = socket.deserializeAttachment();
      return attachment?.authState === "AUTHENTICATED" && attachment.generation === meta.teacherGeneration;
    }) ?? null;
  }

  async scheduleAlarm() {
    const meta = this.meta();
    if (!meta || ["CLOSED", "EXPIRED"].includes(meta.status)) return;
    const deadlines = [meta.expiresAt];
    if (meta.status === "OPEN" && Number.isFinite(meta.teacherHeartbeatDeadline)) {
      deadlines.push(meta.teacherHeartbeatDeadline);
    }
    for (const socket of this.ctx.getWebSockets("student")) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.authDeadline) deadlines.push(attachment.authDeadline);
    }
    for (const pending of this.pendingJoins.values()) deadlines.push(pending.deadline);
    await this.ctx.storage.setAlarm(Math.max(Date.now(), Math.min(...deadlines)));
  }

  failPendingJoins(code) {
    for (const pending of this.pendingJoins.values()) pending.resolve(error(code, 503));
    this.pendingJoins.clear();
  }

  markTeacherOffline(socket) {
    const attachment = socket.deserializeAttachment();
    const offline = this.ctx.storage.transactionSync(() => {
      const meta = this.checkedMeta();
      const next = disconnectTeacher(meta, attachment);
      if (next === meta) return false;
      this.put(next);
      return true;
    });
    if (offline) {
      this.failPendingJoins("TEACHER_UNAVAILABLE");
      invalidateStudents(this.ctx, this.meta(), Date.now(), AUTH_TIMEOUT_MS);
    }
  }

  sendToTeacher(socket, raw) {
    try { socket.send(raw); return true; } catch {
      this.markTeacherOffline(socket);
      try { socket.close(1011, "Connection unavailable"); } catch { /* already closed */ }
      this.ctx.waitUntil(this.scheduleAlarm());
      return false;
    }
  }

  rejectSocket(socket, code, id = null) {
    socket.send(transportError(code, id));
    socket.close(1008, "Invalid transport operation");
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/create" && request.method === "POST") {
      const body = await request.json();
      if (this.meta() || !SESSION_ID_PATTERN.test(body.remoteSessionId ?? "")
        || body.remoteProtocolVersion !== REMOTE_PROTOCOL_VERSION
        || typeof body.installationId !== "string"
        || !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now()) {
        return error("MALFORMED_MESSAGE", 409);
      }
      this.put({ remoteSessionId: body.remoteSessionId,
        remoteProtocolVersion: REMOTE_PROTOCOL_VERSION, installationId: body.installationId,
        status: "CREATING", createdAt: Date.now(), expiresAt: body.expiresAt,
        teacherGeneration: 0, ticketHash: null, ticketExpiresAt: null });
      await this.ctx.storage.setAlarm(body.expiresAt);
      return json({ created: true }, 201);
    }
    if (path === "/bootstrap" && request.method === "GET") {
      const meta = this.checkedMeta();
      if (!meta) return error("SESSION_CLOSED", 404);
      return json({ reachable: true, remoteProtocolVersion: meta.remoteProtocolVersion,
        status: meta.status === "OPEN" ? "available" : "unavailable" });
    }
    if (path === "/join" && request.method === "POST") {
      const meta = this.checkedMeta();
      const teacher = this.teacher(meta);
      if (!teacher) return error("TEACHER_UNAVAILABLE", 503);
      if (this.pendingJoins.size >= MAX_PENDING_JOINS) return error("REMOTE_SERVICE_UNAVAILABLE", 503);
      const body = await request.json();
      const id = crypto.randomUUID();
      const raw = encodeEnvelope("CONTROL", id, { op: "join", generation: meta.teacherGeneration,
        joinAttemptId: body.joinAttemptId, seatNumber: body.seatNumber, name: body.name });
      if (!raw) return error("MESSAGE_TOO_LARGE", 413);
      const response = new Promise((resolve) => this.pendingJoins.set(id,
        { resolve, generation: meta.teacherGeneration, deadline: Date.now() + JOIN_TIMEOUT_MS }));
      this.sendToTeacher(teacher, raw);
      await this.scheduleAlarm();
      return response;
    }
    if (path === "/student-ws" && request.method === "GET") {
      const meta = this.checkedMeta();
      if (!this.teacher(meta)) return error("TEACHER_UNAVAILABLE", 503);
      if (this.ctx.getWebSockets("student").length >= MAX_STUDENT_SOCKETS) {
        return error("REMOTE_SERVICE_UNAVAILABLE", 503);
      }
      const [client, server] = Object.values(new WebSocketPair());
      server.serializeAttachment({ role: "student", connectionId: crypto.randomUUID(),
        authState: "UNAUTHENTICATED", generation: meta.teacherGeneration,
        authDeadline: Date.now() + AUTH_TIMEOUT_MS, authRequestId: null });
      this.ctx.acceptWebSocket(server, ["student"]);
      await this.scheduleAlarm();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === "/ticket" && request.method === "POST") {
      const body = await request.json();
      const result = this.ctx.storage.transactionSync(() => {
        const meta = this.checkedMeta();
        if (!meta) return error("SESSION_CLOSED", 404);
        if (meta.status === "CLOSED") return error("SESSION_CLOSED", 410);
        if (meta.status === "EXPIRED") return error("SESSION_EXPIRED", 410);
        if (meta.installationId !== body.installationId) return error("AUTH_REJECTED", 403);
        if (typeof body.ticketHash !== "string" || !/^[0-9a-f]{64}$/.test(body.ticketHash)
          || !Number.isFinite(body.ticketExpiresAt)
          || body.ticketExpiresAt <= Date.now()
          || body.ticketExpiresAt > meta.expiresAt) return error("MALFORMED_MESSAGE", 400);
        meta.ticketHash = body.ticketHash;
        meta.ticketExpiresAt = body.ticketExpiresAt;
        this.put(meta);
        return json({ issued: true });
      });
      return result;
    }
    if (path.endsWith("/ws") && request.method === "GET") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return error("MALFORMED_MESSAGE", 426);
      }
      const ticketHash = request.headers.get("x-relay-ticket-hash");
      const result = this.ctx.storage.transactionSync(() => {
        const meta = this.checkedMeta();
        if (!meta) return { response: error("SESSION_CLOSED", 404) };
        if (meta.status === "CLOSED") return { response: error("SESSION_CLOSED", 410) };
        if (meta.status === "EXPIRED") return { response: error("SESSION_EXPIRED", 410) };
        if (!ticketHash || meta.ticketHash !== ticketHash
          || !meta.ticketExpiresAt || Date.now() >= meta.ticketExpiresAt) {
          return { response: error("AUTH_REJECTED", 403) };
        }
        meta.ticketHash = null;
        meta.ticketExpiresAt = null;
        meta.teacherGeneration += 1;
        meta.status = "OPEN";
        meta.teacherHeartbeatDeadline = Date.now() + TEACHER_HEARTBEAT_TIMEOUT_MS;
        this.put(meta);
        return { generation: meta.teacherGeneration };
      });
      if (result.response) return result.response;
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({ role: "teacher", connectionId: crypto.randomUUID(),
        authState: "AUTHENTICATED", generation: result.generation });
      this.ctx.acceptWebSocket(server, ["teacher"]);
      this.failPendingJoins("TEACHER_UNAVAILABLE");
      for (const old of this.ctx.getWebSockets("teacher")) {
        if (old !== server && old.deserializeAttachment()?.generation !== result.generation) {
          old.close(1008, "Stale teacher generation");
        }
      }
      invalidateStudents(this.ctx, this.meta(), Date.now(), AUTH_TIMEOUT_MS);
      server.send(control("teacher_attached", crypto.randomUUID(), { generation: result.generation }));
      await this.scheduleAlarm();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === "/close" && request.method === "POST") {
      const body = await request.json();
      const result = this.ctx.storage.transactionSync(() => {
        const meta = this.checkedMeta();
        if (!meta) return error("SESSION_CLOSED", 404);
        if (meta.installationId !== body.installationId) return error("AUTH_REJECTED", 403);
        if (meta.status === "EXPIRED") return error("SESSION_EXPIRED", 410);
        meta.status = "CLOSED";
        meta.ticketHash = null;
        meta.ticketExpiresAt = null;
        meta.teacherHeartbeatDeadline = null;
        this.put(meta);
        return json({ closed: true });
      });
      for (const socket of this.ctx.getWebSockets()) socket.close(1000, "Session closed");
      this.failPendingJoins("SESSION_CLOSED");
      return result;
    }
    return error("MALFORMED_MESSAGE", 404);
  }

  async alarm() {
    const meta = this.checkedMeta();
    if (!meta || ["CLOSED", "EXPIRED"].includes(meta.status)) {
      this.failPendingJoins("SESSION_CLOSED");
      return;
    }
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets("student")) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.authDeadline && attachment.authDeadline <= now) {
        socket.serializeAttachment({ ...attachment, authDeadline: null });
        // Relay latency cannot declare an existing Rust credential invalid.
        // Close the socket, but let Student reconnect with the same credential.
        this.rejectSocket(socket, "TEACHER_UNAVAILABLE");
      }
    }
    for (const [id, pending] of this.pendingJoins) {
      if (pending.deadline <= now) {
        this.pendingJoins.delete(id);
        pending.resolve(error("TEACHER_UNAVAILABLE", 504));
      }
    }
    await this.scheduleAlarm();
  }

  async webSocketMessage(socket, raw) {
    const attachment = socket.deserializeAttachment();
    const meta = this.checkedMeta();
    if (!attachment || !meta || ["CLOSED", "EXPIRED"].includes(meta.status)
      || attachment.generation !== meta.teacherGeneration) {
      socket.close(1008, "Stale connection");
      return;
    }
    const parsed = readEnvelope(raw);
    if (parsed.error) {
      this.rejectSocket(socket, parsed.error);
      return;
    }
    const { value } = parsed;
    if (attachment.role === "student") {
      const teacher = this.teacher(meta);
      if (!teacher) {
        socket.send(transportError("TEACHER_UNAVAILABLE", value.id));
        return;
      }
      if (attachment.authState !== "AUTHENTICATED") {
        if (!attachment.authDeadline || attachment.authDeadline <= Date.now()) {
          this.rejectSocket(socket, "TEACHER_UNAVAILABLE", value.id);
          return;
        }
        if (attachment.authState !== "UNAUTHENTICATED") {
          this.rejectSocket(socket, "AUTH_REJECTED", value.id);
          return;
        }
        if (value.type !== "AUTH") {
          this.rejectSocket(socket, "AUTH_REQUIRED", value.id);
          return;
        }
        if (!hasKeys(value.payload, ["message"]) || !participantAuth(value.payload.message)) {
          this.rejectSocket(socket, value.payload.message?.protocolVersion === 1
            ? "MALFORMED_MESSAGE" : "PROTOCOL_MISMATCH", value.id);
          return;
        }
        const forwarded = encodeEnvelope("AUTH", value.id, { connectionId: attachment.connectionId,
          generation: meta.teacherGeneration, message: value.payload.message });
        if (!forwarded) { this.rejectSocket(socket, "MESSAGE_TOO_LARGE", value.id); return; }
        socket.serializeAttachment({ ...attachment, authState: "PENDING_AUTH", authRequestId: value.id });
        this.sendToTeacher(teacher, forwarded);
        return;
      }
      if (value.type !== "REALTIME" || !hasKeys(value.payload, ["message"])
        || !clientRealtime(value.payload.message)) {
        this.rejectSocket(socket, "MALFORMED_MESSAGE", value.id);
        return;
      }
      const forwarded = encodeEnvelope("REALTIME", value.id, { connectionId: attachment.connectionId,
        generation: meta.teacherGeneration, message: value.payload.message });
      if (!forwarded) { this.rejectSocket(socket, "MESSAGE_TOO_LARGE", value.id); return; }
      this.sendToTeacher(teacher, forwarded);
      return;
    }
    if (attachment.role !== "teacher" || this.teacher(meta) !== socket) {
      socket.close(1008, "Stale teacher generation");
      return;
    }
    const payload = value.payload;
    if (value.type === "CONTROL") {
      if (hasKeys(payload, ["op"]) && payload.op === "ping") {
        meta.teacherHeartbeatDeadline = Date.now() + TEACHER_HEARTBEAT_TIMEOUT_MS;
        this.put(meta);
        socket.send(control("pong", value.id, { generation: meta.teacherGeneration }));
        await this.scheduleAlarm();
        return;
      }
      if (payload.op === "join_result" && payload.generation === meta.teacherGeneration
        && ((hasKeys(payload, ["op", "generation", "result"]) && hasKeys(payload.result, ["info", "participant"]))
          || (hasKeys(payload, ["op", "generation", "error"]) && hasKeys(payload.error, ["code", "message"])
            && typeof payload.error.code === "string" && typeof payload.error.message === "string"))) {
        const pending = this.pendingJoins.get(value.id);
        if (pending?.generation === meta.teacherGeneration && pending.deadline > Date.now()) {
          this.pendingJoins.delete(value.id);
          pending.resolve(payload.result ? json(payload.result) : json(payload.error, 400));
          await this.scheduleAlarm();
        }
        return;
      }
      this.rejectSocket(socket, "MALFORMED_MESSAGE", value.id);
      return;
    }
    if (!UUID_PATTERN.test(payload.connectionId ?? "") || payload.generation !== meta.teacherGeneration) {
      this.rejectSocket(socket, "MALFORMED_MESSAGE", value.id);
      return;
    }
    const student = this.ctx.getWebSockets("student").find((candidate) => {
      const details = candidate.deserializeAttachment();
      return details?.connectionId === payload.connectionId && details.generation === meta.teacherGeneration;
    });
    if (!student) return; // A disconnected recipient cannot be rebound to another socket.
    const details = student.deserializeAttachment();
    if (value.type === "AUTH" && hasKeys(payload, ["connectionId", "generation", "accepted", "message"])
      && typeof payload.accepted === "boolean" && payload.message?.protocolVersion === 1
      && payload.message.type === (payload.accepted ? "participant_authenticated" : "error")) {
      if (details.authState !== "PENDING_AUTH" || details.authRequestId !== value.id
        || !details.authDeadline || details.authDeadline <= Date.now()) return;
      const response = encodeEnvelope("AUTH", value.id, { accepted: payload.accepted, message: payload.message });
      if (!response) { this.rejectSocket(student, "MESSAGE_TOO_LARGE", value.id); return; }
      student.serializeAttachment({ ...details, authState: payload.accepted ? "AUTHENTICATED" : "REJECTED",
        authRequestId: null, authDeadline: null });
      student.send(response);
      if (!payload.accepted) student.close(1008, "Authentication rejected");
      await this.scheduleAlarm();
      return;
    }
    if (value.type === "REALTIME" && hasKeys(payload, ["connectionId", "generation", "message"])
      && serverRealtime(payload.message)) {
      if (details.authState !== "AUTHENTICATED") return;
      const response = encodeEnvelope("REALTIME", value.id, { message: payload.message });
      if (!response) { this.rejectSocket(student, "MESSAGE_TOO_LARGE", value.id); return; }
      student.send(response);
      return;
    }
    if (value.type === "ERROR" && hasKeys(payload, ["connectionId", "generation", "kind", "code", "retryable"])
      && payload.kind === "transport" && payload.code === "MESSAGE_TOO_LARGE" && payload.retryable === false) {
      if (details.authState === "AUTHENTICATED") student.send(transportError(payload.code, value.id));
      return;
    }
    this.rejectSocket(socket, "MALFORMED_MESSAGE", value.id);
  }

  async webSocketClose(socket, code = 1000, reason = "") {
    const attachment = socket.deserializeAttachment();
    if (attachment?.role === "teacher") {
      this.markTeacherOffline(socket);
    } else if (attachment?.role === "student") {
      const meta = this.checkedMeta();
      const teacher = this.teacher(meta);
      if (teacher && attachment.generation === meta.teacherGeneration) {
        this.sendToTeacher(teacher, control("participant_disconnected", crypto.randomUUID(), {
          connectionId: attachment.connectionId, generation: meta.teacherGeneration }));
      }
    }
    // Complete the close handshake for hibernating sockets. Error callbacks use
    // a generic reason and never expose the underlying network error.
    try { socket.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason); }
    catch { /* the peer may already have closed */ }
    await this.scheduleAlarm();
  }

  webSocketError(socket) {
    return this.webSocketClose(socket, 1011, "Connection unavailable");
  }
}
