import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { boundedWait, quantiles, readerStages, runWorkload } from "./pass-b-workload.js";

const target = fileURLToPath(new URL("../../teacher/src-tauri/target/phase16f-pass-b/", import.meta.url));
const origin = "http://127.0.0.1:8794/";
const remoteSessionId = "r".repeat(32);
const fixtureBytes = Buffer.alloc(256, 42);
const imageHash = createHash("sha256").update(fixtureBytes).digest("hex");

// These are adapter tests, not native/domain integration evidence. The separate
// loopback smoke loads the pinned bundle built from actual studentHttpRead.
function mockFixture(t, overrides = {}) {
  mkdirSync(target, { recursive: true });
  const directory = mkdtempSync(path.join(target, "workload-test-"));
  t.after(() => {
    const resolved = realpathSync(directory);
    assert.ok(resolved.startsWith(realpathSync(target) + path.sep));
    rmSync(resolved, { recursive: true });
  });
  const clientModule = path.join(directory, "mock-client.mjs");
  const mockPolicy = `export async function studentHttpRead(participant, request, signal) {
    const query = new URLSearchParams(request.arguments.assetId ? {assetId:request.arguments.assetId} : {});
    for(let attempt=0;attempt<2;attempt++) {
      const response = await fetch('/v1/sessions/${remoteSessionId}/http/'+request.operation+'?'+query,
        {signal,headers:{authorization:'Bearer '+participant.credential,'x-classroom-participant':participant.participantId}});
      if(response.status!==429 || attempt===1) return response;
      await response.body.cancel();
    }
  }`;
  writeFileSync(clientModule, mockPolicy);
  const sockets = [];
  const streams = new Set();
  const participants = new Map();
  const attemptsByParticipant = new Map();
  const sessionId = randomUUID();
  let questionId = randomUUID();
  let imageId = randomUUID();
  let active = false;
  let answered = new Set();
  const effects = { fetches: 0, joins: 0, lateJoins: 0, controls: [], terminated: 0, socketDestinations: [], mediaReads: 0 };
  class MockSocket extends EventEmitter {
    constructor(url, options) {
      super();
      effects.socketDestinations.push({ url: String(url), options });
      this.readyState = 0;
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.emit("open"); });
    }
    message(type, payload) { this.emit("message", Buffer.from(JSON.stringify({ v: 1, type, payload }))); }
    send(raw) {
      const value = JSON.parse(raw);
      const message = value.payload.message;
      if (value.type === "AUTH") {
        this.participant = message.participantId;
        queueMicrotask(() => {
          this.message("AUTH", { accepted: true });
          this.message("REALTIME", { message: { type: "session_sync" } });
        });
      } else if (message.type === "submit_answer") {
        assert.equal(active, true);
        assert.equal(message.sessionQuestionId, questionId);
        answered.add(this.participant);
        if (overrides.dropAck) return;
        if (overrides.closeOnSubmit) { this.close(); return; }
        queueMicrotask(() => this.message("REALTIME", { message: { type: "submission_acknowledged",
          acknowledgement: { submissionId: message.submissionId, accepted: true } } }));
      } else if (message.type === "ping") {
        queueMicrotask(() => this.message("REALTIME", { message: { type: "pong", requestId: message.requestId } }));
      }
    }
    close() { this.readyState = 3; queueMicrotask(() => this.emit("close")); }
    terminate() { effects.terminated++; this.close(); }
  }
  async function fetchImpl(url, init) {
    effects.fetches++;
    assert.equal(init.redirect, "error");
    assert.equal(url.origin, new URL(origin).origin);
    if (overrides.redirect) return new Response(null, { status: 302, headers: { location: "https://invalid.example/" } });
    if (url.pathname.endsWith("/join")) {
      effects.joins++;
      if (active) effects.lateJoins++;
      const body = JSON.parse(init.body);
      const participant = { participantId: randomUUID(), sessionId, credential: "x".repeat(43),
        serverInstanceId: `remote:${remoteSessionId}`, seatNumber: body.seatNumber, name: body.name };
      participants.set(participant.participantId, participant);
      return Response.json({ participant });
    }
    if (url.pathname.endsWith("PEER_REVIEW_ACTIVITIES_LIST")) return Response.json({ items: [] });
    effects.mediaReads++;
    const participantId = new Headers(init.headers).get("x-classroom-participant");
    const previous = attemptsByParticipant.get(participantId) ?? 0;
    attemptsByParticipant.set(participantId, previous + 1);
    if (overrides.firstMedia429 && previous === 0) return Response.json({ code: "REMOTE_SERVICE_UNAVAILABLE" }, { status: 429 });
    let timer;
    let controller;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      streams.delete(stream);
      init.signal?.removeEventListener("abort", abort);
    };
    const abort = () => { if (!finished) { finish(); controller.error(new Error("synthetic interruption")); } };
    const stream = { interrupt: abort };
    const body = new ReadableStream({
      start(value) {
        controller = value;
        streams.add(stream);
        controller.enqueue(fixtureBytes.subarray(0, 64));
        timer = setTimeout(() => {
          if (finished) return;
          controller.enqueue(fixtureBytes.subarray(64));
          controller.close(); finish();
        }, 20);
        init.signal?.addEventListener("abort", abort, { once: true });
      },
      cancel() { finish(); if (overrides.cancelFails) throw new Error("synthetic cleanup failure"); },
    });
    return new Response(body, { headers: { "content-type": "image/png" } });
  }
  async function control(name, extra) {
    effects.controls.push(name);
    if (overrides.controlCrash === name) throw new Error("SENSITIVE child raw error credential=" + "x".repeat(43));
    switch (name) {
      case "start":
        assert.equal(extra.participantIds.length, participants.size);
        active = true;
        return { questionId, imageId };
      case "publish":
        questionId = randomUUID(); imageId = randomUUID(); answered = new Set();
        return { questionId, imageId };
      case "progress": return { answeredCount: overrides.badCount ? 0 : answered.size };
      case "presence": return { online: sockets.filter(socket => socket.readyState === 1).length };
      case "metrics": return { activeReaders: streams.size, activeMedia: streams.size, creditWaiters: 0, budgetStopped: false };
      case "lock":
        for (const socket of sockets) socket.message("REALTIME", { message: { type: "question_state_changed", question: { sessionQuestionId: questionId, state: "LOCKED" } } });
        return {};
      case "reveal":
        for (const socket of sockets) socket.message("REALTIME", { message: { type: "question_revealed", reveal: { sessionQuestionId: questionId } } });
        return {};
      case "reconnect":
        for (const stream of [...streams]) stream.interrupt();
        for (const socket of sockets) socket.message("CONTROL", { op: "REAUTH_REQUIRED", generation: 2 });
        return {};
      default: throw new Error("Unknown mocked control");
    }
  }
  return { options: { origin, remoteSessionId, students: 2, clientModule,
    clientModuleHash: createHash("sha256").update(mockPolicy).digest("hex"), imageHash, control, fetchImpl,
    WebSocketImpl: MockSocket, remainingMs: () => 10000 }, effects, sockets, streams };
}

// In the two-client fixture, the third publish starts generation recovery.
// Only that first response is replaced; subsequent recovery reads stay normal.
function recoveryFixture(t, mode) {
  const f = mockFixture(t);
  const originalFetch = f.options.fetchImpl;
  let replaced = false;
  f.effects.recoveryAborts = 0;
  f.options.fetchImpl = async (url, init) => {
    if (!url.pathname.endsWith("SESSION_ASSET_GET") || replaced
      || f.effects.controls.filter(name => name === "publish").length !== 3) return originalFetch(url, init);
    replaced = true;
    let controller;
    let finished = false;
    const finish = () => {
      finished = true;
      f.streams.delete(stream);
      init.signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (finished) return;
      f.effects.recoveryAborts++;
      finish();
      controller.error(new DOMException("Synthetic client cancellation", "AbortError"));
    };
    const stream = { interrupt() {
      // Model a successful reconnect/reauth that fails to interrupt the old
      // response. A size-limit variant returns excess data at that point.
      if (mode !== "size-limit" || finished) return;
      controller.enqueue(Buffer.alloc(20 * 1024 * 1024));
      controller.close();
      finish();
    } };
    const body = new ReadableStream({
      start(value) {
        controller = value;
        f.streams.add(stream);
        controller.enqueue(fixtureBytes.subarray(0, 64));
        init.signal.addEventListener("abort", abort, { once: true });
        if (mode === "complete") {
          controller.enqueue(fixtureBytes.subarray(64));
          controller.close();
          finish();
        }
      },
      cancel() { finish(); },
    });
    return new Response(body, { headers: { "content-type": "image/png" } });
  };
  return f;
}

test("30-student media ladder includes 30 and never changes socket admission", () => {
  assert.deepEqual(readerStages(30), [1, 4, 5, 10, 20, 30]);
  assert.deepEqual(readerStages(2), [1, 2]);
  assert.deepEqual(readerStages(5), [1, 4, 5]);
  for (const value of [0, 31, 40, 1.5, NaN, Infinity, "30"]) assert.throws(() => readerStages(value));
});

test("import has no transport, timer or workload effects", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("Import must not fetch"); };
  try {
    await import(new URL("./pass-b-workload.js?import-safety", import.meta.url));
    assert.equal(calls, 0);
    assert.notEqual(globalThis.fetch, previousFetch);
  } finally { globalThis.fetch = previousFetch; }
});

test("percentiles preserve nearest-rank candidate gates and reject non-finite values", () => {
  assert.equal(quantiles(Array.from({ length: 30 }, (_, i) => i + 1)).p95, 29);
  assert.throws(() => quantiles([Infinity]));
});

test("invalid student, target, module identity and path fail before network", async t => {
  const f = mockFixture(t);
  for (const change of [{ students: 31 }, { origin: "https://invalid.example/" },
    { origin: origin + "?bad=1" }, { clientModuleHash: "0".repeat(64) },
    { clientModule: fileURLToPath(new URL("./pass-b-workload.js", import.meta.url)) }]) {
    await assert.rejects(runWorkload({ ...f.options, ...change }));
  }
  assert.equal(f.effects.fetches, 0);
  assert.equal(f.effects.controls.length, 0);
});

test("full mocked 30-client flow distinguishes all LOBBY sockets from media readers", async t => {
  const f = mockFixture(t, { firstMedia429: true });
  const previousFetch = globalThis.fetch;
  const report = await runWorkload({ ...f.options, students: 30 });
  assert.equal(report.runnerCompleted, true);
  assert.equal(report.workloadCompleted, true);
  assert.equal(report.productGatesPass, true, JSON.stringify(report.gates));
  assert.equal(report.cleanup.complete, true);
  assert.equal(f.effects.joins, 30);
  assert.equal(f.effects.lateJoins, 0);
  assert.deepEqual(report.observations.filter(row => row.label === "image_readers").map(row => row.concurrentReaders), [1, 4, 5, 10, 20, 30]);
  assert.ok(report.observations.filter(row => row.label === "image_readers").every(row => row.connectedParticipants === 30 && row.activeMediaBodiesAtProbe > 0));
  const reads = report.observations.filter(row => row.label === "image_readers").flatMap(row => row.rows);
  assert.ok(reads.some(row => row.attempts[0].status === 429 && row.attempts[1].status === 200));
  assert.ok(reads.every(row => row.firstByteAtMs <= row.completedAtMs));
  for (const stage of report.observations.filter(row => row.label === "image_readers")) {
    assert.ok(stage.detail.completedAtMs <= stage.controlCompletedAtMs);
    assert.ok(stage.controlCompletedAtMs < Math.min(...stage.rows.map(row => row.completedAtMs)),
      "Control completion must not wait for the deliberately slower media response");
  }
  const recovery = report.observations.find(row => row.label === "generation_recovery");
  assert.equal(recovery.interrupted.terminationCause, "STREAM_INTERRUPTED");
  assert.equal(recovery.interruptionObservedAfterTrigger, true);
  assert.equal(recovery.interruptionAttribution, "TEMPORAL_CORRELATION_ONLY");
  assert.ok(recovery.interrupted.firstByteAtMs <= recovery.reconnectTriggeredAtMs);
  assert.ok(recovery.reconnectTriggeredAtMs <= recovery.interrupted.completedAtMs);
  assert.equal(globalThis.fetch, previousFetch);
  assert.equal(f.streams.size, 0);
  assert.ok(f.sockets.every(socket => socket.readyState === 3));
  assert.ok(f.effects.socketDestinations.every(row => row.url.startsWith("ws://127.0.0.1:8794/") && row.options.followRedirects === false));
  assert.equal(JSON.stringify(report).includes("x".repeat(43)), false);
});

test("client read timeout after successful reauth cannot pass generation interruption", async t => {
  const f = recoveryFixture(t, "stall");
  f.options.remainingMs = () => 100000;
  const schedule = globalThis.setTimeout;
  // Exercise the real deadline callback without waiting a minute. No runtime
  // option or production CLI can change the actual 60-second read limit.
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds, ...args) => schedule(callback,
    milliseconds === 60000 && f.effects.controls.filter(name => name === "publish").length === 3
      ? 100 : milliseconds, ...args));
  const report = await runWorkload(f.options);
  const recovery = report.observations.find(row => row.label === "generation_recovery");
  assert.equal(f.effects.recoveryAborts, 1);
  assert.equal(recovery.activeMediaBodiesAtStart, 1);
  assert.equal(recovery.interrupted.status, "TIMED_OUT");
  assert.equal(recovery.interrupted.terminationCause, "TOTAL_READ_DEADLINE");
  assert.equal(recovery.interruptionObservedAfterTrigger, false);
  assert.equal(report.gates.find(row => row.name === "generation_auth_sync").status, "PASS");
  assert.equal(report.gates.find(row => row.name === "generation_inflight_interruption").status, "FAIL");
  assert.equal(report.productGatesPass, false);
  assert.equal(report.cleanup.complete, true);
});

test("body size guard cannot pass generation interruption after successful reauth", async t => {
  const f = recoveryFixture(t, "size-limit");
  const report = await runWorkload(f.options);
  const recovery = report.observations.find(row => row.label === "generation_recovery");
  assert.equal(recovery.interrupted.status, "SIZE_LIMIT");
  assert.equal(recovery.interrupted.terminationCause, "HTTP_SIZE_LIMIT");
  assert.equal(recovery.interruptionObservedAfterTrigger, false);
  assert.equal(report.gates.find(row => row.name === "generation_auth_sync").status, "PASS");
  assert.equal(report.gates.find(row => row.name === "generation_inflight_interruption").status, "FAIL");
  assert.equal(report.productGatesPass, false);
  assert.equal(report.cleanup.complete, true);
});

test("a completed recovery image is not evidence of generation interruption", async t => {
  const f = recoveryFixture(t, "complete");
  const report = await runWorkload(f.options);
  const recovery = report.observations.find(row => row.label === "generation_recovery");
  assert.equal(recovery.interrupted.status, 200);
  assert.equal(recovery.interrupted.terminationCause, "COMPLETED");
  assert.equal(recovery.interruptionObservedAfterTrigger, false);
  assert.equal(report.gates.find(row => row.name === "generation_inflight_interruption").status, "NOT_OBSERVED");
  assert.equal(report.productGatesPass, false);
  assert.equal(report.cleanup.complete, true);
});

test("run abort during a stalled recovery read cannot pass generation interruption", async t => {
  const f = recoveryFixture(t, "stall");
  const abort = new AbortController();
  const control = f.options.control;
  let timer;
  f.options.control = async (name, extra) => {
    const result = await control(name, extra);
    if (name === "reconnect") timer = setTimeout(() => abort.abort(), 10);
    return result;
  };
  const report = await runWorkload({ ...f.options, signal: abort.signal });
  clearTimeout(timer);
  assert.equal(f.effects.recoveryAborts, 1);
  assert.equal(report.stopReason, "WORK_STOPPED");
  assert.equal(report.gates.some(row => row.name === "generation_inflight_interruption" && row.status === "PASS"), false);
  assert.equal(report.productGatesPass, false);
  assert.equal(report.cleanup.complete, true);
});

test("authoritative answer failure stops before any media stage", async t => {
  const f = mockFixture(t, { badCount: true });
  const report = await runWorkload(f.options);
  assert.equal(report.workloadCompleted, false);
  assert.equal(report.productGatesPass, false);
  assert.equal(report.stopReason, "PRODUCT_GATE_STOP");
  assert.equal(f.effects.mediaReads, 0);
  assert.equal(f.effects.controls.includes("publish"), false);
  assert.equal(report.cleanup.complete, true);
});

test("native control crash is sanitized and closes owned sockets", async t => {
  const f = mockFixture(t, { controlCrash: "publish" });
  const report = await runWorkload(f.options);
  assert.equal(report.runnerCompleted, false);
  assert.equal(report.cleanup.complete, true);
  assert.equal(JSON.stringify(report).includes("SENSITIVE"), false);
  assert.equal(JSON.stringify(report).includes("x".repeat(43)), false);
});

test("socket crash rejects pending ACK immediately without waiting for timeout", async t => {
  const f = mockFixture(t, { closeOnSubmit: true });
  const start = performance.now();
  const report = await runWorkload(f.options);
  assert.equal(report.workloadCompleted, false);
  assert.equal(report.cleanup.pendingOperationsCleared, true);
  assert.ok(performance.now() - start < 1000);
});

test("redirect response fails before Student admission or native workload", async t => {
  const f = mockFixture(t, { redirect: true });
  const report = await runWorkload(f.options);
  assert.equal(report.workloadCompleted, false);
  assert.equal(f.effects.joins, 0);
  assert.equal(f.effects.controls.length, 0);
});

test("abort cancels pending ACK, releases timer and restores global fetch", async t => {
  const f = mockFixture(t, { dropAck: true });
  const abort = new AbortController();
  const previousFetch = globalThis.fetch;
  const timer = setTimeout(() => abort.abort(), 30);
  const report = await runWorkload({ ...f.options, signal: abort.signal });
  clearTimeout(timer);
  assert.equal(report.stopReason, "WORK_STOPPED");
  assert.equal(report.cleanup.pendingOperationsCleared, true);
  assert.equal(report.cleanup.timersCleared, true);
  assert.equal(globalThis.fetch, previousFetch);
});

test("HTTP cancellation error is reported and cannot imply complete cleanup", async t => {
  const f = mockFixture(t, { cancelFails: true });
  const report = await runWorkload(f.options);
  assert.equal(report.cleanup.complete, false);
  assert.equal(report.cleanup.httpCancellationConfirmed, false);
  assert.ok(report.cleanup.cancellationFailures > 0);
});

test("bounded waits reject exhausted setup budget and abort pending controls", async () => {
  await assert.rejects(boundedWait(Promise.resolve(), { timeoutMs: 100, remainingMs: () => 0 }), /WORK_STOPPED/);
  const abort = new AbortController();
  const pending = boundedWait(new Promise(() => {}), { signal: abort.signal, timeoutMs: 10000, remainingMs: () => 10000 });
  abort.abort();
  await assert.rejects(pending, /WORK_STOPPED/);
});
