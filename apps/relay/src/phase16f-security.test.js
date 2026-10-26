import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionAdmission } from "./admission.js";

// Use Wrangler's existing local workerd/D1 runtime, never a network relay URL.
const require = createRequire(import.meta.url);
const wranglerDirectory = dirname(require.resolve("wrangler/package.json"));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require(require.resolve("miniflare", { paths: [wranglerDirectory] }));
const hash = value => createHash("sha256").update(value).digest("hex");
const fixtureOperator = "synthetic-local-operator-only";
const baselineWorker = process.env.PHASE16F_AUDIT_BASELINE === "1"
  ? execFileSync("git", ["show", "c5285196a08e412732eb2246efd78e3c9644d15a:apps/relay/src/worker.js"],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" }) : undefined;
const schema = readFileSync(new URL("../migrations/0001_installations.sql", import.meta.url), "utf8");
async function fixture(operatorEnabled = true) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: ["worker.js", "http_relay.js", "contract.js", "lifecycle.js", "admission.js"].map(name => ({
      type: "ESModule", path: fileURLToPath(new URL("./" + name, import.meta.url)),
      ...(name === "worker.js" && baselineWorker ? { contents: baselineWorker } : {}),
    })),
    compatibilityDate: "2026-09-24", host: "127.0.0.1", port: 0,
    log: new Log(LogLevel.NONE), d1Databases: { INSTALLATIONS: randomUUID() },
    durableObjects: { CLASSROOM_SESSION: { className: "ClassroomSession", useSQLite: true } },
    bindings: { ...(operatorEnabled ? { OPERATOR_TOKEN: fixtureOperator } : {}),
      CONNECT_TICKET_TTL_SECONDS: "15", RELAY_MAX_LIFETIME_SECONDS: "3600" },
    serviceBindings: { ASSETS: () => new Response("<!doctype html><title>Synthetic</title>",
      { headers: { "content-type": "text/html" } }) },
  }));
  let db;
  try { db = await mf.getD1Database("INSTALLATIONS"); for (const statement of schema.split(";").filter(value => value.trim())) await db.prepare(statement).run(); }
  catch (error) { await mf.dispose(); throw error; }
  const request = async (path, method = "GET", body, token) => mf.dispatchFetch("http://local.test" + path, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const issue = async () => {
    const response = await request("/v1/operator/activation-codes", "POST", {}, fixtureOperator);
    assert.equal(response.status, 201); return (await response.json()).activationCode;
  };
  const enroll = async () => {
    const response = await request("/v1/enroll", "POST", { activationCode: await issue() });
    assert.equal(response.status, 201); return response.json();
  };
  const create = async installation => {
    const response = await request("/v1/teacher/sessions", "POST", { teacherAppVersion: "synthetic", remoteProtocolVersion: 1 }, installation.installationCredential);
    assert.equal(response.status, 201); return response.json();
  };
  const ticket = async (installation, session) => {
    const response = await request("/v1/teacher/sessions/" + session.remoteSessionId + "/tickets", "POST", undefined, installation.installationCredential);
    assert.equal(response.status, 200); return response.json();
  };
  const connect = async (session, value) => {
    const response = await mf.dispatchFetch("http://local.test/v1/teacher/sessions/" + session.remoteSessionId + "/ws", {
      headers: { upgrade: "websocket", authorization: "Bearer " + value.ticket },
    });
    if (response.status === 101) response.webSocket.accept();
    return response;
  };
  return { mf, db, request, issue, enroll, create, ticket, connect };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test("enrollment insert failure rolls back activation consumption and returns a sanitized error", async () => {
  const f = await fixture();
  try {
    const code = await f.issue();
    await f.db.prepare("CREATE TRIGGER fail_synthetic_insert BEFORE INSERT ON installations BEGIN SELECT RAISE(ABORT, 'synthetic storage error'); END").run();
    let response;
    try { response = await f.request("/v1/enroll", "POST", { activationCode: code }); } catch { /* compare persisted state even if old Worker leaked rejection */ }
    const activation = await f.db.prepare("SELECT consumed_at FROM activation_codes WHERE code_hash = ?").bind(hash(code)).first();
    assert.equal(activation.consumed_at, null, "failed installation insertion must not burn the activation code");
    assert.equal(response?.status, 503);
    assert.deepEqual(await response.json(), { code: "REMOTE_SERVICE_UNAVAILABLE" });
    await f.db.prepare("DROP TRIGGER fail_synthetic_insert").run();
    assert.equal((await f.request("/v1/enroll", "POST", { activationCode: code })).status, 201);
  } finally { await f.mf.dispose(); }
});

test("concurrent activation redemption creates exactly one installation", async () => {
  const f = await fixture();
  try {
    const code = await f.issue();
    const responses = await Promise.all(Array.from({ length: 8 }, () => f.request("/v1/enroll", "POST", { activationCode: code })));
    assert.deepEqual(responses.map(response => response.status).sort(), [201,403,403,403,403,403,403,403]);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM installations").first()).count, 1);
  } finally { await f.mf.dispose(); }
});

test("a non-owner installation cannot close another Teacher's active relay", async () => {
  const f = await fixture(); let socket;
  try {
    const owner = await f.enroll(); const intruder = await f.enroll(); const session = await f.create(owner);
    const connected = await f.connect(session, await f.ticket(owner, session));
    assert.equal(connected.status, 101); socket = connected.webSocket;
    let closed = false; socket.addEventListener("close", () => { closed = true; });
    const denied = await f.request("/v1/teacher/sessions/" + session.remoteSessionId, "DELETE", undefined, intruder.installationCredential);
    assert.equal(denied.status, 403); await pause(50);
    assert.equal(closed, false, "denied close must not terminate owner sockets");
    assert.equal((await (await f.request("/v1/sessions/" + session.remoteSessionId + "/bootstrap")).json()).status, "available");
    assert.equal((await f.request("/v1/teacher/sessions/" + session.remoteSessionId, "DELETE", undefined, owner.installationCredential)).status, 204);
    assert.equal((await (await f.request("/v1/sessions/" + session.remoteSessionId + "/bootstrap")).json()).status, "unavailable");
  } finally { if (socket) try { socket.close(); } catch {} await f.mf.dispose(); }
});

test("concurrent ticket redemption accepts one Teacher generation only", async () => {
  const f = await fixture(); const sockets = [];
  try {
    const owner = await f.enroll(); const session = await f.create(owner); const value = await f.ticket(owner, session);
    const responses = await Promise.all(Array.from({ length: 6 }, () => f.connect(session, value)));
    for (const response of responses) if (response.webSocket) sockets.push(response.webSocket);
    assert.deepEqual(responses.map(response => response.status).sort(), [101,403,403,403,403,403]);
  } finally { for (const socket of sockets) try { socket.close(); } catch {} await f.mf.dispose(); }
});

test("operator endpoint without secret and unknown API/ID are fail-closed", async () => {
  const f = await fixture(false);
  try {
    assert.equal((await f.request("/v1/operator/activation-codes", "POST", {}, fixtureOperator)).status, 403);
    const unknown = await f.request("/v1/unknown"); assert.equal(unknown.status, 404);
    assert.match(unknown.headers.get("content-type"), /application\/json/);
    assert.equal((await f.request("/v1/sessions/invalid/bootstrap")).status, 400);
    const page = await f.request("/join/" + "a".repeat(32));
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(page.headers.get("content-security-policy"), /img-src 'self' blob: data:/);
    assert.equal(page.headers.get("cache-control"), "no-store");
  } finally { await f.mf.dispose(); }
});


test("close racing a delayed join body rejects promptly without leaving a pending join", async () => {
  const f = await fixture(); let socket; let release;
  try {
    const owner = await f.enroll(); const session = await f.create(owner);
    socket = (await f.connect(session, await f.ticket(owner, session))).webSocket;
    const namespace = await f.mf.getDurableObjectNamespace("CLASSROOM_SESSION");
    const stub = namespace.getByName(session.remoteSessionId);
    const body = new ReadableStream({ start(controller) { release = () => {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ remoteProtocolVersion: 1, joinAttemptId: randomUUID(), seatNumber: 1, name: "Synthetic" })));
      controller.close();
    }; } });
    const pending = stub.fetch("http://relay.internal/join", { method: "POST", body, duplex: "half" });
    await pause(40);
    assert.equal((await f.request("/v1/teacher/sessions/" + session.remoteSessionId, "DELETE", undefined, owner.installationCredential)).status, 204);
    release(); release = null;
    const result = await Promise.race([pending, pause(1500).then(() => null)]);
    assert.ok(result, "closed Session must not keep the join until the old deadline");
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { code: "TEACHER_UNAVAILABLE" });
  } finally { release?.(); if (socket) try { socket.close(); } catch {} await f.mf.dispose(); }
});

test("revocation blocks new control requests but an already issued ticket retains its bounded lifetime", async () => {
  const f = await fixture(); let socket;
  try {
    const owner = await f.enroll(); const session = await f.create(owner); const value = await f.ticket(owner, session);
    assert.equal((await f.request("/v1/operator/installations/" + owner.installationId + "/revoke", "POST", undefined, fixtureOperator)).status, 204);
    assert.equal((await f.request("/v1/teacher/sessions", "POST", { teacherAppVersion: "synthetic", remoteProtocolVersion: 1 }, owner.installationCredential)).status, 403);
    assert.equal((await f.request("/v1/teacher/sessions/" + session.remoteSessionId + "/tickets", "POST", undefined, owner.installationCredential)).status, 403);
    const connected = await f.connect(session, value); assert.equal(connected.status, 101); socket = connected.webSocket;
    assert.equal((await f.request("/v1/teacher/sessions/" + session.remoteSessionId, "DELETE", undefined, owner.installationCredential)).status, 403);
    assert.equal((await (await f.request("/v1/sessions/" + session.remoteSessionId + "/bootstrap")).json()).status, "available");
  } finally { if (socket) try { socket.close(); } catch {} await f.mf.dispose(); }
});


async function workerWithHostShim() {
  // Execute the actual source under Node for a deterministic await-body barrier.
  // Only the platform base class/import locations change; route code is untouched.
  let source = baselineWorker ?? readFileSync(new URL("./worker.js", import.meta.url), "utf8");
  source = source.replace('"cloudflare:workers"', '"data:text/javascript,export class DurableObject {}"')
    .replace(/from "(\.\/[^"]+)"/g, (_match, path) => "from " + JSON.stringify(new URL(path, import.meta.url).href));
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
}

test("async control storage errors stay inside the Worker's sanitized error boundary", async () => {
  const { default: worker } = await workerWithHostShim();
  const env = { INSTALLATIONS: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("synthetic raw storage failure"); } }) }) } };
  let response;
  try {
    response = await worker.fetch(new Request("http://local.test/v1/teacher/sessions", {
      method: "POST", headers: { authorization: "Bearer " + "A".repeat(43) }, body: "{}",
    }), env);
  } catch { /* Assert the missing sanitized response without dumping a data-URL stack. */ }
  assert.ok(response, "async route rejection must be sanitized");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: "REMOTE_SERVICE_UNAVAILABLE" });
});

for (const race of ["closed Session", "filled join quota"]) {
  test("join rechecks " + race + " after its asynchronous body read", async () => {
    const { ClassroomSession } = await workerWithHostShim();
    const relay = Object.create(ClassroomSession.prototype);
    relay.admission = new SessionAdmission();
    let meta = { status: "OPEN", teacherGeneration: 1 };
    const teacher = {}; let sent = 0; let release;
    relay.pendingJoins = new Map(); relay.checkedMeta = () => meta;
    relay.teacher = current => current.status === "OPEN" ? teacher : null;
    relay.sendToTeacher = () => { sent += 1; return true; };
    relay.scheduleAlarm = async () => {};
    const body = new Promise(resolve => { release = resolve; });
    const pending = relay.fetch({ url: "http://relay.internal/join", method: "POST", json: () => body });
    if (race === "closed Session") meta = { status: "CLOSED", teacherGeneration: 1 };
    else for (let i = 0; i < 128; i += 1) relay.pendingJoins.set(String(i), {});
    release({ joinAttemptId: randomUUID(), seatNumber: 1, name: "Synthetic" });
    const response = await Promise.race([pending, pause(100).then(() => null)]);
    assert.ok(response, "request must be rejected at the updated lifecycle/quota boundary");
    assert.equal(response.status, 503); assert.equal(sent, 0);
    assert.equal(relay.pendingJoins.size, race === "closed Session" ? 0 : 128);
  });
}

for (const race of ["closed Session", "replacement Teacher generation"]) {
  test("HTTP read rechecks " + race + " after its asynchronous body read", async () => {
    const { ClassroomSession } = await workerWithHostShim();
    const relay = Object.create(ClassroomSession.prototype);
    relay.admission = new SessionAdmission();
    let meta = { status: "OPEN", teacherGeneration: 1 };
    const teachers = [{}, {}]; let routed; let release;
    relay.checkedMeta = () => meta;
    relay.teacher = current => current.status === "OPEN" ? teachers[current.teacherGeneration - 1] : null;
    relay.http = { open: (_request, _body, generation, teacher) => {
      routed = { generation, teacher }; return new Response(null, { status: 200 });
    } };
    const body = new Promise(resolve => { release = resolve; });
    const pending = relay.fetch({ url: "http://relay.internal/http-read", method: "POST", json: () => body });
    meta = race === "closed Session" ? { status: "CLOSED", teacherGeneration: 1 } : { status: "OPEN", teacherGeneration: 2 };
    release({ identity: { sessionId: randomUUID(), participantId: randomUUID(), credential: "A".repeat(43) },
      request: { operation: "SESSION_ASSET_GET", arguments: { assetId: randomUUID() } } });
    const response = await pending;
    if (race === "closed Session") { assert.equal(response.status, 503); assert.equal(routed, undefined); }
    else { assert.equal(response.status, 200); assert.deepEqual(routed, { generation: 2, teacher: teachers[1] }); }
  });
}

test("A2 unverified HTTP identity cannot reserve another credential's owner quota", async () => {
  const { HttpRelay, httpQuotaOwner } = await import("./http_relay.js");
  const relay = new HttpRelay(() => true, () => {});
  const identity = { sessionId: randomUUID(), participantId: randomUUID(), credential: "A".repeat(43) };
  const request = { operation: "SESSION_ASSET_GET", arguments: { assetId: randomUUID() } };
  const forged = { identity: { ...identity, credential: "B".repeat(43) }, request };
  const legitimate = { identity, request };
  const attacker = relay.open(new Request("http://local.test/"), forged, 1, {}, await httpQuotaOwner(forged));
  const victim = relay.open(new Request("http://local.test/"), legitimate, 1, {}, await httpQuotaOwner(legitimate));
  assert.equal(relay.pending.size, 2);
  assert.equal(victim instanceof Promise, true);
  relay.failAll(); await Promise.all([attacker, victim]);
  assert.equal(relay.pending.size, 0);
});
