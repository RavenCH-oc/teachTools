import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import WebSocket from "ws";
import { encodeEnvelope } from "./contract.js";

const base = process.env.TEST_RELAY_URL ?? "http://127.0.0.1:8787";
const operator = /^OPERATOR_TOKEN=(.+)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
assert.ok(operator, "Local operator token is required");
const sockets = [];
after(() => { for (const socket of sockets) socket.terminate(); });

async function request(path, method = "GET", body, token) {
  const response = await fetch(new URL(path, base), { method,
    headers: { ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}

function connect(path, ticket) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, ticket ? { headers: { authorization: `Bearer ${ticket}` } } : {});
    sockets.push(socket);
    socket.messages = [];
    socket.on("message", (raw) => socket.messages.push(JSON.parse(raw.toString())));
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_request, response) => {
      response.resume(); reject(new Error(`WebSocket rejected: ${response.statusCode}`));
    });
    socket.once("error", reject);
  });
}

async function next(socket, predicate = () => true, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const index = socket.messages.findIndex(predicate);
    if (index >= 0) return socket.messages.splice(index, 1)[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected relay message did not arrive");
}

async function closed(socket) {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (socket.readyState !== WebSocket.OPEN) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected socket closure did not arrive");
}

function send(socket, type, payload, id = randomUUID()) {
  socket.send(JSON.stringify({ v: 1, type, id, payload }));
  return id;
}

async function fixture() {
  const activation = await request("/v1/operator/activation-codes", "POST", {}, operator);
  assert.equal(activation.status, 201);
  const enrolled = await request("/v1/enroll", "POST", { activationCode: activation.data.activationCode });
  const created = await request("/v1/teacher/sessions", "POST",
    { teacherAppVersion: "0.1.0", remoteProtocolVersion: 1 }, enrolled.data.installationCredential);
  assert.equal(created.status, 201);
  const id = created.data.remoteSessionId;
  const attach = async () => {
    const ticket = await request(`/v1/teacher/sessions/${id}/tickets`, "POST", undefined,
      enrolled.data.installationCredential);
    const teacher = await connect(`/v1/teacher/sessions/${id}/ws`, ticket.data.ticket);
    const attached = await next(teacher);
    return { teacher, generation: attached.payload.generation };
  };
  const { teacher, generation } = await attach();
  return { id, teacher, generation, attach, student: () => connect(`/v1/sessions/${id}/ws`) };
}

const sessionId = randomUUID();
const participantId = randomUUID();
const participant = { participantId, sessionId, seatNumber: 1, displayName: "Remote test" };
const authMessage = () => ({ protocolVersion: 1, type: "participant_auth", requestId: randomUUID(),
  sessionId, participantId, credential: "A".repeat(43) });
const authenticatedMessage = { protocolVersion: 1, type: "participant_authenticated", participant,
  classroomName: "Remote test", sessionState: "LOBBY" };

async function authenticate(f, student) {
  const id = send(student, "AUTH", { message: authMessage() });
  const forwarded = await next(f.teacher, (message) => message.type === "AUTH");
  assert.equal(forwarded.id, id);
  assert.equal(forwarded.payload.generation, f.generation);
  send(f.teacher, "AUTH", { connectionId: forwarded.payload.connectionId, generation: f.generation,
    accepted: true, message: authenticatedMessage }, id);
  assert.equal((await next(student)).payload.accepted, true);
  return forwarded.payload.connectionId;
}

test("minimal join is forwarded privately and only the correlated generation may reply", async () => {
  const f = await fixture();
  const joinAttemptId = randomUUID();
  const response = request(`/v1/sessions/${f.id}/join`, "POST",
    { remoteProtocolVersion: 1, joinAttemptId, seatNumber: 1, name: "Remote test" });
  const forwarded = await next(f.teacher);
  assert.equal(forwarded.payload.op, "join");
  assert.equal(forwarded.payload.joinAttemptId, joinAttemptId);
  const result = { info: { sessionId, classroomName: "Remote test", state: "LOBBY", joinMode: "roster_match",
    serverInstanceId: `remote:${f.id}`, protocolVersion: 1 },
  participant: { sessionId, participantId, credential: "A".repeat(43), participant,
    serverInstanceId: `remote:${f.id}` } };
  send(f.teacher, "CONTROL", { op: "join_result", generation: 1, result }, randomUUID());
  send(f.teacher, "CONTROL", { op: "join_result", generation: 1, result }, forwarded.id);
  assert.deepEqual(await response, { status: 200, data: result });
  assert.deepEqual((await request(`/v1/sessions/${f.id}/bootstrap`)).data,
    { reachable: true, remoteProtocolVersion: 1, status: "available" });
});

test("join protocol and shape are allowlisted; unanswered join is bounded by timeout", async () => {
  const f = await fixture();
  const join = { remoteProtocolVersion: 1, joinAttemptId: randomUUID(), seatNumber: 1, name: "Test" };
  assert.equal((await request(`/v1/sessions/${f.id}/join`, "POST", { ...join, remoteProtocolVersion: 2 })).data.code,
    "PROTOCOL_MISMATCH");
  assert.equal((await request(`/v1/sessions/${f.id}/join`, "POST", { ...join, path: "/arbitrary" })).status, 400);
  const missing = await request(`/v1/sessions/${f.id}/join`, "POST", join);
  assert.equal(missing.status, 504);
  assert.equal(missing.data.code, "TEACHER_UNAVAILABLE");
});

test("Student cannot receive personalized state before Rust confirms AUTH; routing is per connection", async () => {
  const f = await fixture();
  const student = await f.student();
  const authId = send(student, "AUTH", { message: authMessage() });
  const forwarded = await next(f.teacher);
  const connectionId = forwarded.payload.connectionId;
  const sync = { protocolVersion: 1, type: "session_sync", sync: { sessionState: "LOBBY",
    currentQuestion: null, ownLatestSubmission: null, reveal: null } };
  send(f.teacher, "REALTIME", { connectionId, generation: 1, message: sync });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(student.messages.length, 0);
  send(f.teacher, "AUTH", { connectionId, generation: 1, accepted: true, message: authenticatedMessage }, randomUUID());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(student.messages.length, 0);
  send(f.teacher, "AUTH", { connectionId, generation: 1, accepted: true, message: authenticatedMessage }, authId);
  assert.equal((await next(student)).payload.accepted, true);
  const second = await f.student();
  send(f.teacher, "REALTIME", { connectionId, generation: 1, message: sync });
  assert.deepEqual((await next(student)).payload.message, sync);
  assert.equal(second.messages.length, 0);
  second.terminate();
});

test("wrong credential rejection comes from Teacher and closes the unauthenticated socket", async () => {
  const f = await fixture();
  const student = await f.student();
  const id = send(student, "AUTH", { message: authMessage() });
  const forwarded = await next(f.teacher);
  send(f.teacher, "AUTH", { connectionId: forwarded.payload.connectionId, generation: 1,
    accepted: false, message: { protocolVersion: 1, type: "error", code: "AUTH_FAILED", message: "驗證失敗" } }, id);
  assert.equal((await next(student)).payload.accepted, false);
  await closed(student);
});

test("silent Student expires after the shared earliest auth deadline", async () => {
  const f = await fixture();
  const student = await f.student();
  const started = Date.now();
  assert.deepEqual((await next(student)).payload,
    { kind: "transport", code: "TEACHER_UNAVAILABLE", retryable: true });
  assert.ok(Date.now() - started >= 4500);
  await closed(student);
});

test("delayed Rust AUTH expires retryably and the same credential can authenticate a fresh socket", async () => {
  const f = await fixture();
  const delayed = await f.student();
  const credential = authMessage();
  const expiredId = send(delayed, "AUTH", { message: credential });
  const forwarded = await next(f.teacher, (message) => message.type === "AUTH");
  assert.deepEqual((await next(delayed)).payload,
    { kind: "transport", code: "TEACHER_UNAVAILABLE", retryable: true });
  await closed(delayed);
  const replacement = await f.student();
  send(f.teacher, "AUTH", { connectionId: forwarded.payload.connectionId, generation: 1,
    accepted: true, message: authenticatedMessage }, expiredId);
  const currentId = send(replacement, "AUTH", { message: credential });
  const current = await next(f.teacher, (message) => message.type === "AUTH");
  assert.notEqual(current.payload.connectionId, forwarded.payload.connectionId);
  assert.deepEqual(current.payload.message, credential);
  send(f.teacher, "AUTH", { connectionId: current.payload.connectionId, generation: 1,
    accepted: true, message: authenticatedMessage }, currentId);
  assert.equal((await next(replacement)).payload.accepted, true);
});

test("mutation before AUTH, repeated AUTH, malformed AUTH and oversized AUTH fail closed", async () => {
  const f = await fixture();
  const unauthenticated = await f.student();
  send(unauthenticated, "REALTIME", { message: { protocolVersion: 1, type: "ping", requestId: randomUUID() } });
  assert.equal((await next(unauthenticated)).payload.code, "AUTH_REQUIRED");
  await closed(unauthenticated);
  const repeat = await f.student();
  send(repeat, "AUTH", { message: authMessage() });
  await next(f.teacher, (message) => message.type === "AUTH");
  send(repeat, "AUTH", { message: authMessage() });
  assert.equal((await next(repeat)).payload.code, "AUTH_REJECTED");
  await closed(repeat);
  const malformed = await f.student();
  send(malformed, "AUTH", { message: { ...authMessage(), credential: "bad" } });
  assert.equal((await next(malformed)).payload.code, "MALFORMED_MESSAGE");
  const huge = await f.student();
  huge.send("x".repeat(64 * 1024 + 1));
  assert.equal((await next(huge)).payload.code, "MESSAGE_TOO_LARGE");
  const mismatch = await f.student();
  mismatch.send(JSON.stringify({ v: 2, type: "AUTH", id: randomUUID(), payload: { message: authMessage() } }));
  assert.equal((await next(mismatch)).payload.code, "PROTOCOL_MISMATCH");
});

test("Teacher disconnect blocks mutations; new generation requires another Rust AUTH", async () => {
  const f = await fixture();
  const student = await f.student();
  await authenticate(f, student);
  f.teacher.terminate();
  assert.equal((await next(student)).payload.op, "teacher_offline");
  send(student, "REALTIME", { message: { protocolVersion: 1, type: "ping", requestId: randomUUID() } });
  assert.equal((await next(student)).payload.code, "TEACHER_UNAVAILABLE");
  const attached = await f.attach();
  assert.equal(attached.generation, 2);
  assert.deepEqual((await next(student)).payload, { op: "REAUTH_REQUIRED", generation: 2 });
  const connectionId = await authenticate({ ...f, ...attached }, student);
  const sync = { protocolVersion: 1, type: "session_sync", sync: { sessionState: "LOBBY",
    currentQuestion: null, ownLatestSubmission: null, reveal: null } };
  send(attached.teacher, "REALTIME", { connectionId, generation: 2, message: sync });
  assert.equal((await next(student)).payload.message.type, "session_sync");
});

test("old Teacher generation is detached and cannot continue routing", async () => {
  const f = await fixture();
  const student = await f.student();
  const connectionId = await authenticate(f, student);
  const newer = await f.attach();
  assert.equal(newer.generation, 2);
  await closed(f.teacher);
  assert.equal((await next(student)).payload.op, "REAUTH_REQUIRED");
  assert.equal(student.messages.length, 0);
  assert.ok(connectionId);
});

test("F2 graceful Teacher close proactively notifies completely idle Students", async () => {
  const f = await fixture();
  const students = [await f.student(), await f.student()];
  for (const student of students) await authenticate(f, student);
  f.teacher.close(1000, "Teacher closed");
  for (const student of students) {
    assert.deepEqual((await next(student)).payload, { op: "teacher_offline", generation: 1 });
    assert.equal(student.readyState, WebSocket.OPEN);
  }
});

test("F2 ungraceful observed disconnect pushes offline; F3 idle socket re-auths and syncs after replacement", async () => {
  const f = await fixture();
  const student = await f.student();
  await authenticate(f, student);
  f.teacher.terminate();
  assert.deepEqual((await next(student)).payload, { op: "teacher_offline", generation: 1 });
  const replacement = await f.attach();
  assert.deepEqual((await next(student)).payload, { op: "REAUTH_REQUIRED", generation: 2 });
  const connectionId = await authenticate({ ...f, ...replacement }, student);
  const sync = { protocolVersion: 1, type: "session_sync", sync: { sessionState: "LOBBY",
    currentQuestion: null, ownLatestSubmission: null, reveal: null } };
  send(replacement.teacher, "REALTIME", { connectionId, generation: 2, message: sync });
  assert.deepEqual((await next(student)).payload.message, sync);
});

test("F4 replacement stays online and cannot receive late control/data from old Teacher generation", async () => {
  const f = await fixture();
  const student = await f.student();
  const oldConnectionId = await authenticate(f, student);
  const replacement = await f.attach();
  assert.deepEqual((await next(student)).payload, { op: "REAUTH_REQUIRED", generation: 2 });
  // Race late frames against the old socket's replacement close. ws may have
  // already received that close, so consume its send callback error as well.
  for (const [type, payload] of [
    ["CONTROL", { op: "ping" }],
    ["REALTIME", { connectionId: oldConnectionId, generation: 1,
      message: { protocolVersion: 1, type: "session_state_changed", sessionId, state: "ENDED" } }],
  ]) {
    try { f.teacher.send(JSON.stringify({ v: 1, type, id: randomUUID(), payload }), () => {}); }
    catch { /* the old transport may already have closed */ }
  }
  await closed(f.teacher);
  const connectionId = await authenticate({ ...f, ...replacement }, student);
  const pingId = send(replacement.teacher, "CONTROL", { op: "ping" });
  assert.deepEqual((await next(replacement.teacher, (message) => message.id === pingId)).payload,
    { op: "pong", generation: 2 });
  const sync = { protocolVersion: 1, type: "session_sync", sync: { sessionState: "LOBBY",
    currentQuestion: null, ownLatestSubmission: null, reveal: null } };
  send(replacement.teacher, "REALTIME", { connectionId, generation: 2, message: sync });
  assert.deepEqual((await next(student)).payload.message, sync);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(student.messages.length, 0);
  assert.equal((await request(`/v1/sessions/${f.id}/bootstrap`)).data.status, "available");
});

test("Teacher heartbeat silence proactively marks an idle Student offline without a TCP close", async () => {
  const f = await fixture();
  const student = await f.student();
  await authenticate(f, student);
  const started = Date.now();
  assert.deepEqual((await next(student, () => true, 65000)).payload,
    { op: "teacher_offline", generation: 1 });
  assert.ok(Date.now() - started >= 55000);
  assert.ok(Date.now() - started < 65000);
  await closed(f.teacher);
  assert.equal(student.readyState, WebSocket.OPEN);
});

test("authenticated Quiz, Grouping, Peer Review and presence use unchanged messages", async () => {
  const f = await fixture();
  const student = await f.student();
  const connectionId = await authenticate(f, student);
  const messages = [
    { protocolVersion: 1, type: "ping", requestId: randomUUID() },
    { protocolVersion: 1, type: "submit_answer", requestId: randomUUID(), submissionId: randomUUID(),
      sessionQuestionId: randomUUID(), answer: { type: "true_false", value: true } },
    { protocolVersion: 1, type: "select_group", requestId: randomUUID(), draftId: randomUUID(), groupId: randomUUID() },
    { protocolVersion: 1, type: "submit_peer_review", requestId: randomUUID(), reviewSubmissionId: randomUUID(),
      assignmentId: randomUUID(), expectedBaseRevision: 0, body: "Bounded review" },
  ];
  for (const message of messages) {
    const id = send(student, "REALTIME", { message });
    const forwarded = await next(f.teacher, (value) => value.type === "REALTIME");
    assert.deepEqual(forwarded, { v: 1, type: "REALTIME", id,
      payload: { connectionId, generation: 1, message } });
  }
  const pong = { protocolVersion: 1, type: "pong", requestId: messages[0].requestId };
  send(f.teacher, "REALTIME", { connectionId, generation: 1, message: pong });
  assert.deepEqual((await next(student)).payload.message, pong);
  const changed = { protocolVersion: 1, type: "peer_review_changed" };
  send(f.teacher, "REALTIME", { connectionId, generation: 1, message: changed });
  assert.deepEqual((await next(student)).payload.message, changed);
});

test("full rewritten envelope ceiling includes routing metadata and routed size errors stay private", async () => {
  const f = await fixture();
  const student = await f.student();
  const connectionId = await authenticate(f, student);
  const id = randomUUID();
  const message = { protocolVersion: 1, type: "submit_answer", requestId: randomUUID(), submissionId: randomUUID(),
    sessionQuestionId: randomUUID(), answer: { type: "essay", text: "" } };
  const empty = JSON.stringify({ v: 1, type: "REALTIME", id, payload: { message } });
  message.answer.text = "x".repeat(64 * 1024 - new TextEncoder().encode(empty).byteLength);
  assert.ok(encodeEnvelope("REALTIME", id, { message }));
  assert.equal(encodeEnvelope("REALTIME", id, { connectionId, generation: 1, message }), null);
  send(student, "REALTIME", { message }, id);
  assert.equal((await next(student)).payload.code, "MESSAGE_TOO_LARGE");
  await closed(student);
  const other = await f.student();
  const otherId = await authenticate(f, other);
  send(f.teacher, "ERROR", { connectionId: otherId, generation: 1, kind: "transport",
    code: "MESSAGE_TOO_LARGE", retryable: false });
  assert.deepEqual((await next(other)).payload, { kind: "transport", code: "MESSAGE_TOO_LARGE", retryable: false });
});

test("credentials in WebSocket URLs and generic HTTP relay remain unavailable", async () => {
  const f = await fixture();
  await assert.rejects(connect(`/v1/sessions/${f.id}/ws?credential=${"A".repeat(43)}`), /403/);
  assert.equal((await request(`/v1/sessions/${f.id}/http`, "POST", { url: "http://localhost/" })).status, 404);
  const student = await f.student();
  await authenticate(f, student);
  send(student, "HTTP_RELAY", { url: "http://localhost/" });
  assert.equal((await next(student)).payload.code, "MALFORMED_MESSAGE");
});
