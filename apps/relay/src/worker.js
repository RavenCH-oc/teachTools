import { DurableObject } from "cloudflare:workers";
import {
  MAX_ENVELOPE_BYTES, REMOTE_PROTOCOL_VERSION, SECRET_PATTERN,
  SESSION_ID_PATTERN, control, readEnvelope, transportError,
} from "./contract.js";
import { expireRelay } from "./lifecycle.js";

const encoder = new TextEncoder();
const REMOTE_SESSION_BYTES = 24;
const CREDENTIAL_BYTES = 32;
const MAX_CONTROL_BODY_BYTES = 4096;

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
      const student = /^\/v1\/sessions\/([^/]+)\/bootstrap$/.exec(path);
      if (student && request.method === "GET") {
        return SESSION_ID_PATTERN.test(student[1])
          ? bootstrap(env, student[1]) : error("MALFORMED_MESSAGE", 400);
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
  }

  meta() {
    return this.ctx.storage.kv.get("relay");
  }

  put(meta) {
    this.ctx.storage.kv.put("relay", meta);
  }

  checkedMeta() {
    const meta = this.meta();
    const next = expireRelay(meta, Date.now());
    if (next !== meta) {
      this.put(next);
      for (const socket of this.ctx.getWebSockets()) socket.close(1008, "Session expired");
    }
    return next;
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
        this.put(meta);
        return { generation: meta.teacherGeneration };
      });
      if (result.response) return result.response;
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({ role: "teacher", connectionId: crypto.randomUUID(),
        authState: "AUTHENTICATED", generation: result.generation });
      this.ctx.acceptWebSocket(server, ["teacher"]);
      for (const old of this.ctx.getWebSockets("teacher")) {
        if (old !== server && old.deserializeAttachment()?.generation !== result.generation) {
          old.close(1008, "Stale teacher generation");
        }
      }
      for (const student of this.ctx.getWebSockets("student")) {
        const attachment = student.deserializeAttachment();
        if (attachment) {
          student.serializeAttachment({ ...attachment, authState: "UNAUTHENTICATED",
            generation: result.generation });
          student.send(control("REAUTH_REQUIRED", crypto.randomUUID()));
        }
      }
      server.send(control("teacher_attached", crypto.randomUUID(), { generation: result.generation }));
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
        this.put(meta);
        return json({ closed: true });
      });
      for (const socket of this.ctx.getWebSockets()) socket.close(1000, "Session closed");
      return result;
    }
    return error("MALFORMED_MESSAGE", 404);
  }

  async alarm() {
    const meta = this.checkedMeta();
    if (meta && meta.status !== "CLOSED" && meta.status !== "EXPIRED") {
      await this.ctx.storage.setAlarm(meta.expiresAt);
    }
  }

  webSocketMessage(socket, raw) {
    const attachment = socket.deserializeAttachment();
    const meta = this.checkedMeta();
    if (!attachment || attachment.role !== "teacher" || !meta
      || attachment.generation !== meta.teacherGeneration
      || meta.status !== "OPEN") {
      socket.close(1008, "Stale connection");
      return;
    }
    const parsed = readEnvelope(raw);
    if (parsed.error) {
      socket.send(transportError(parsed.error));
      socket.close(1008, "Invalid transport envelope");
      return;
    }
    const { value } = parsed;
    if (value.type !== "CONTROL" || !value.payload
      || Object.keys(value.payload).length !== 1 || value.payload.op !== "ping") {
      socket.send(transportError("MALFORMED_MESSAGE", value.id));
      socket.close(1008, "Unsupported transport operation");
      return;
    }
    socket.send(control("pong", value.id, { generation: meta.teacherGeneration }));
  }

  webSocketClose(socket) {
    const attachment = socket.deserializeAttachment();
    if (attachment?.role === "teacher") {
      this.ctx.storage.transactionSync(() => {
        const meta = this.checkedMeta();
        if (meta?.status === "OPEN" && meta.teacherGeneration === attachment.generation) {
          meta.status = "TEACHER_OFFLINE";
          this.put(meta);
        }
      });
    }
  }

  webSocketError(socket) {
    this.webSocketClose(socket);
  }
}
