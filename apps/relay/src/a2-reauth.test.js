import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { invalidateStudents } from "./lifecycle.js";

// Run the real Worker routing code with a minimal host shim. No network, D1,
// durable storage, real participant credential, or production endpoint is involved.
let source = readFileSync(new URL("./worker.js", import.meta.url), "utf8");
source = source.replace('"cloudflare:workers"',
  '"data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }"')
  .replace(/from "(\.\/[^"]+)"/g,
    (_match, path) => "from " + JSON.stringify(new URL(path, import.meta.url).href));
const { ClassroomSession } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

function fakeSocket(initial) {
  let attachment = initial;
  const socket = {
    frames: [], closed: false,
    deserializeAttachment: () => attachment,
    serializeAttachment: next => { attachment = next; },
    send: raw => {
      if (socket.closed) throw new Error("Synthetic already-closed socket");
      socket.frames.push(JSON.parse(raw));
    },
    close: () => { socket.closed = true; },
  };
  return socket;
}

function fixture(state = "AUTHENTICATED") {
  let meta = { status: "OPEN", teacherGeneration: 1, expiresAt: Date.now() + 3600000,
    teacherHeartbeatDeadline: Date.now() + 60000 };
  const teacher = fakeSocket({ role: "teacher", connectionId: randomUUID(), generation: 1, authState: "AUTHENTICATED" });
  const student = fakeSocket({ role: "student", connectionId: randomUUID(), generation: 1,
    authState: state, authDeadline: null, authRequestId: null });
  const pending = [];
  const ctx = {
    storage: { kv: { get: () => meta, put: (_key, value) => { meta = value; } },
      setAlarm: async () => {}, transactionSync: fn => fn() },
    getWebSockets: tag => tag === "student" ? [student] : tag === "teacher" ? [teacher] : [teacher, student],
    waitUntil: promise => { pending.push(promise); },
  };
  const relay = new ClassroomSession(ctx, {});
  return { relay, student, teacher, ctx, meta: () => meta,
    drain: async () => { await Promise.all(pending); } };
}

const realtime = (type = "ping") => JSON.stringify({ v: 1, id: randomUUID(), type: "REALTIME",
  payload: { message: { protocolVersion: 1, type, requestId: "synthetic-inflight",
    ...(type === "submit_answer" ? { submissionId: randomUUID(), sessionQuestionId: randomUUID(), answer: { type: "true_false", value: true } } : {}) } } });
const auth = () => ({ v: 1, id: randomUUID(), type: "AUTH", payload: { message: {
  protocolVersion: 1, type: "participant_auth", requestId: "synthetic-reauth",
  sessionId: randomUUID(), participantId: randomUUID(), credential: "A".repeat(43),
} } });

for (const type of ["ping", "submit_answer"]) {
  test("A2 reconstruction drops in-flight " + type + " without forwarding, ACK, or closing re-auth", async () => {
    const f = fixture();
    const deadline = f.student.deserializeAttachment().authDeadline;
    assert.equal(f.student.frames[0].payload.op, "REAUTH_REQUIRED");
    await f.relay.webSocketMessage(f.student, realtime(type));
    assert.equal(f.student.closed, false, "previously authenticated in-flight traffic must not kill re-auth");
    assert.equal(f.teacher.frames.length, 0, "unverified traffic must never reach Rust");
    assert.equal(f.student.frames.length, 1, "no fake ACK or repeated re-auth control");
    assert.equal(f.student.deserializeAttachment().authDeadline, deadline, "no timeout extension");
    assert.equal(f.student.deserializeAttachment().authState, "UNAUTHENTICATED");
    await f.drain();
  });
}

test("A2 pending re-auth drops old realtime and resumes only after the matching Rust AUTH result", async () => {
  const f = fixture();
  const request = auth();
  await f.relay.webSocketMessage(f.student, JSON.stringify(request));
  const deadline = f.student.deserializeAttachment().authDeadline;
  assert.equal(f.student.deserializeAttachment().authState, "PENDING_AUTH");
  assert.equal(f.teacher.frames.length, 1);
  assert.equal(f.teacher.frames[0].type, "AUTH");
  await f.relay.webSocketMessage(f.student, realtime("submit_answer"));
  assert.equal(f.student.closed, false);
  assert.equal(f.teacher.frames.length, 1, "old mutation not forwarded while AUTH pending");
  assert.equal(f.student.frames.length, 1, "no ACK while AUTH pending");
  assert.equal(f.student.deserializeAttachment().authDeadline, deadline);
  const routed = f.teacher.frames[0];
  const accepted = { v: 1, id: request.id, type: "AUTH", payload: {
    connectionId: routed.payload.connectionId, generation: 1, accepted: true,
    message: { protocolVersion: 1, type: "participant_authenticated", requestId: "synthetic-reauth" },
  } };
  await f.relay.webSocketMessage(f.teacher, JSON.stringify({ ...accepted, id: randomUUID() }));
  assert.equal(f.student.deserializeAttachment().authState, "PENDING_AUTH", "unmatched AUTH cannot restore trust");
  await f.relay.webSocketMessage(f.teacher, JSON.stringify(accepted));
  assert.equal(f.student.deserializeAttachment().authState, "AUTHENTICATED");
  assert.equal(f.student.deserializeAttachment().reauthPending, false);
  assert.equal(f.student.deserializeAttachment().authDeadline, null);
  assert.equal(f.student.frames.at(-1).type, "AUTH");
  await f.relay.webSocketMessage(f.student, realtime());
  assert.equal(f.teacher.frames.length, 2);
  assert.equal(f.teacher.frames.at(-1).type, "REALTIME");
  await f.drain();
});

for (const state of ["UNAUTHENTICATED", "PENDING_AUTH"]) {
  test("A2 initial " + state + " socket does not gain stale-message tolerance", async () => {
    const f = fixture("UNAUTHENTICATED");
    if (state === "PENDING_AUTH") await f.relay.webSocketMessage(f.student, JSON.stringify(auth()));
    const before = f.teacher.frames.length;
    await f.relay.webSocketMessage(f.student, realtime());
    assert.equal(f.student.closed, true);
    assert.equal(f.teacher.frames.length, before);
    assert.equal(f.student.frames.at(-1).type, "ERROR");
    await f.drain();
  });
}

for (const invalid of ["expired", "stale generation", "malformed", "oversized"]) {
  test("A2 re-auth tolerance never bypasses " + invalid + " rejection", async () => {
    const f = fixture();
    let raw = realtime();
    if (invalid === "expired") f.student.serializeAttachment({ ...f.student.deserializeAttachment(), authDeadline: Date.now() - 1 });
    if (invalid === "stale generation") f.student.serializeAttachment({ ...f.student.deserializeAttachment(), generation: 0 });
    if (invalid === "malformed") raw = realtime("unknown");
    if (invalid === "oversized") raw = "x".repeat(65537);
    await f.relay.webSocketMessage(f.student, raw);
    assert.equal(f.student.closed, true);
    assert.equal(f.teacher.frames.length, 0);
    await f.drain();
  });
}

test("A2 offline-to-new-generation retains only re-auth routing marker and never restores authority", async () => {
  const f = fixture();
  invalidateStudents(f.ctx, { ...f.meta(), status: "TEACHER_OFFLINE" }, Date.now());
  assert.equal(f.student.deserializeAttachment().authState, "TEACHER_OFFLINE");
  assert.equal(f.student.deserializeAttachment().reauthPending, true);
  assert.equal(f.student.deserializeAttachment().authDeadline, null);
  invalidateStudents(f.ctx, { ...f.meta(), teacherGeneration: 2 }, Date.now());
  assert.equal(f.student.deserializeAttachment().authState, "UNAUTHENTICATED");
  assert.equal(f.student.deserializeAttachment().generation, 2);
  assert.equal(f.student.deserializeAttachment().reauthPending, true);
  assert.ok(f.student.deserializeAttachment().authDeadline <= Date.now() + 5000);
  assert.equal("credential" in f.student.deserializeAttachment(), false);
  assert.equal(f.teacher.frames.length, 0);
  await f.drain();
});


test("A2 terminal reject tolerates an already-closed socket without uncaught errors", () => {
  const relay = Object.create(ClassroomSession.prototype);
  let sends = 0; let closes = 0;
  const closed = {
    send() { sends += 1; throw new Error("Synthetic send after close"); },
    close() { closes += 1; throw new Error("Synthetic already closed"); },
  };
  for (let i = 0; i < 3; i += 1) {
    let threw = false;
    try { relay.rejectSocket(closed, "AUTH_REQUIRED", randomUUID()); } catch { threw = true; }
    assert.equal(threw, false, "closed-socket rejection must not throw");
  }
  assert.equal(sends, 3);
  assert.equal(closes, 3, "close is attempted even if sending the rejection fails");
});

test("A2 terminal reject still sends the controlled error and closes an open invalid socket", () => {
  const relay = Object.create(ClassroomSession.prototype);
  const frames = []; const closes = [];
  const id = randomUUID();
  relay.rejectSocket({ send: raw => frames.push(JSON.parse(raw)), close: (...args) => closes.push(args) },
    "MALFORMED_MESSAGE", id);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "ERROR");
  assert.equal(frames[0].id, id);
  assert.deepEqual(frames[0].payload, { kind: "transport", code: "MALFORMED_MESSAGE", retryable: false });
  assert.deepEqual(closes, [[1008, "Invalid transport operation"]]);
});
