// Import-safe protocol workload. The supervisor owns authorization, source
// attestation, the native process and the whole-run deadline/cleanup reserve.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

const canonical = "https://classroom-relay.ryanaddy1102.workers.dev/";
const loopback = "http://127.0.0.1:8794/";
const moduleRoot = fileURLToPath(new URL("../../teacher/src-tauri/target/phase16f-pass-b/", import.meta.url));
const maxImageBytes = 20 * 1024 * 1024;
const maxDetailBytes = 16 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hashPattern = /^[0-9a-f]{64}$/;
let workloadActive = false;

function failure(code) { return Object.assign(new Error(code), { code }); }

export function readerStages(students) {
  if (!Number.isInteger(students) || students < 1 || students > 30) throw failure("INVALID_STUDENTS");
  return [...new Set([1, 4, 5, 10, 20, 30].filter(n => n <= students).concat(students))];
}

export function quantiles(values) {
  if (!values.length) return { n: 0 };
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw failure("INVALID_MEASUREMENT");
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: sorted[Math.ceil(0.5 * sorted.length) - 1],
    p95: sorted[Math.ceil(0.95 * sorted.length) - 1], max: sorted.at(-1) };
}

function verifiedModule(modulePath, expectedHash) {
  if (typeof modulePath !== "string" || !path.isAbsolute(modulePath) || !hashPattern.test(expectedHash ?? "")) {
    throw failure("INVALID_CLIENT_IDENTITY");
  }
  const root = realpathSync(moduleRoot);
  const actual = realpathSync(modulePath);
  const relative = path.relative(root, actual);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(actual) !== ".mjs") {
    throw failure("CLIENT_PATH_ESCAPE");
  }
  if (createHash("sha256").update(readFileSync(actual)).digest("hex") !== expectedHash) {
    throw failure("CLIENT_IDENTITY_MISMATCH");
  }
  return actual;
}

// This helper bounds waits without leaving losing timers or abort listeners.
// The passed promise must itself use the run signal for owned I/O cancellation.
export async function boundedWait(promise, { signal, timeoutMs, remainingMs, code = "WAIT_DEADLINE" }) {
  const remaining = remainingMs();
  if (!Number.isFinite(remaining) || remaining <= 0 || signal?.aborted) throw failure("WORK_STOPPED");
  const duration = Math.min(timeoutMs, remaining);
  if (!Number.isFinite(duration) || duration <= 0) throw failure("WORK_STOPPED");
  let timer;
  let onAbort;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(failure(code)), duration);
    onAbort = () => reject(failure("WORK_STOPPED"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([promise, deadline]); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
}

function gateStatus(pass) { return pass ? "PASS" : "FAIL"; }
function allAcks(rows, limit) {
  return rows.length > 0 && rows.every(row => row.accepted === true && row.censored !== true)
    && quantiles(rows.map(row => row.ms)).p95 <= limit;
}

export async function runWorkload({ origin, remoteSessionId, students, clientModule,
  clientModuleHash, imageHash, control, fetchImpl, WebSocketImpl = WebSocket,
  signal, remainingMs }) {
  const stages = readerStages(students);
  if (![canonical, loopback].includes(origin) || !/^[A-Za-z0-9_-]{32}$/.test(remoteSessionId ?? "")
    || !hashPattern.test(imageHash ?? "") || typeof control !== "function"
    || typeof fetchImpl !== "function" || typeof remainingMs !== "function") throw failure("INVALID_WORKLOAD_CONFIG");
  if (workloadActive) throw failure("WORKLOAD_ALREADY_ACTIVE");
  const modulePath = verifiedModule(clientModule, clientModuleHash);
  if (signal?.aborted || !Number.isFinite(remainingMs()) || remainingMs() <= 0) throw failure("WORK_STOPPED");
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.studentHttpRead !== "function") throw failure("INVALID_CLIENT_MODULE");
  if (workloadActive) throw failure("WORKLOAD_ALREADY_ACTIVE");
  workloadActive = true;
  const started = performance.now();
  const now = () => performance.now() - started;
  const runAbort = new AbortController();
  const onExternalAbort = () => runAbort.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (signal?.aborted) runAbort.abort();
  const originalFetch = globalThis.fetch;
  const attempts = new Map();
  const clients = [];
  const activeReads = new Set();
  const bodyReads = new Set();
  const pendingReads = new Set();
  const pendingCancels = new Set();
  let cancellationFailures = 0;
  const observations = [];
  const gates = [];
  const transport = { joins: 0, authenticated: 0, syncs: 0, reauth: 0,
    unexpectedOffline: 0, socketErrors: 0, protocolErrors: 0, pongs: 0 };
  let plannedRecovery = false;
  let closing = false;
  let details;
  const report = { runnerCompleted: false, workloadCompleted: false, productGatesPass: false,
    stopReason: null, scope: "SYNTHETIC_PROTOCOL_ONLY", mobileRender: "NOT_VERIFIED", installedQa: "NOT_VERIFIED",
    participantAdmission: "ALL_JOIN_AUTH_SYNC_IN_LOBBY_BEFORE_MEDIA_LADDER", students, readerStages: stages,
    thresholds: { textAckP95Ms: 2000, mediaAckP95Ms: 3000, image95PercentMs: 30000, imageAllMs: 60000 },
    observations, gates, transport, cleanup: { complete: false } };
  const wait = (promise, timeoutMs, code) => boundedWait(promise,
    { signal: runAbort.signal, remainingMs, timeoutMs, code });
  const ensureRunning = () => {
    if (runAbort.signal.aborted || remainingMs() <= 0) throw failure("WORK_STOPPED");
  };
  function cancelOwnedBody(body) {
    if (!body) return;
    let cancellation;
    try { cancellation = Promise.resolve(body.cancel()); }
    catch { cancellationFailures++; return; }
    pendingCancels.add(cancellation);
    cancellation.catch(() => { cancellationFailures++; }).finally(() => pendingCancels.delete(cancellation));
  }
  const pause = ms => new Promise((resolve, reject) => {
    if (runAbort.signal.aborted) { reject(failure("WORK_STOPPED")); return; }
    const onAbort = () => { clearTimeout(timer); reject(failure("WORK_STOPPED")); };
    const timer = setTimeout(() => { runAbort.signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    runAbort.signal.addEventListener("abort", onAbort, { once: true });
  });
  async function until(predicate, timeoutMs = 15000) {
    const beginning = performance.now();
    while (!predicate()) {
      ensureRunning();
      if (clients.some(client => client.fatal)) throw failure("STUDENT_TRANSPORT_FAILED");
      if (performance.now() - beginning >= Math.min(timeoutMs, remainingMs())) throw failure("STATE_WAIT_DEADLINE");
      await pause(10);
    }
  }
  async function native(name, extra = {}) {
    ensureRunning();
    return wait(control(name, extra), 30000, "NATIVE_CONTROL_DEADLINE");
  }
  async function joinJson(response) {
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !response.body) {
      cancelOwnedBody(response.body);
      throw failure("INVALID_JOIN_RESPONSE");
    }
    const reader = response.body.getReader();
    const parts = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await wait(reader.read(), 15000, "JOIN_BODY_DEADLINE");
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 65536) throw failure("JOIN_RESPONSE_LIMIT");
        parts.push(part.value);
      }
      return JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch (error) {
      cancelOwnedBody(reader);
      throw error;
    }
  }
  function gate(name, status) { gates.push({ name, status: typeof status === "boolean" ? gateStatus(status) : status }); }
  function stopIfFailed() {
    if (gates.some(row => row.status !== "PASS")) throw failure("PRODUCT_GATE_STOP");
  }
  globalThis.fetch = async (input, init = {}) => {
    ensureRunning();
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, origin);
    if (url.origin !== new URL(origin).origin || url.username || url.password || url.hash) throw failure("CROSS_ORIGIN");
    const headers = new Headers(init.headers);
    const key = `${headers.get("x-classroom-participant")}:${url.pathname}`;
    const history = attempts.get(key) ?? [];
    if (history.length >= 128) throw failure("ATTEMPT_RECORD_LIMIT");
    const attempt = { status: "PENDING", atMs: now() };
    history.push(attempt);
    attempts.set(key, history);
    try {
      const response = await fetchImpl(url, { ...init, redirect: "error", signal: init.signal ?? runAbort.signal });
      attempt.status = response.status;
      attempt.completedAtMs = now();
      if ((response.status >= 300 && response.status < 400) || response.redirected
        || (response.url && new URL(response.url).origin !== url.origin)) {
        cancelOwnedBody(response.body);
        throw failure("REDIRECT_REJECTED");
      }
      return response;
    } catch (error) {
      if (attempt.status === "PENDING") attempt.status = "NETWORK_ERROR";
      attempt.completedAtMs = now();
      throw error;
    }
  };

  class Student {
    constructor(index, participant) {
      if (!participant || !uuidPattern.test(participant.sessionId ?? "") || !uuidPattern.test(participant.participantId ?? "")
        || !/^[A-Za-z0-9_-]{43}$/.test(participant.credential ?? "")
        || participant.serverInstanceId !== `remote:${remoteSessionId}`) throw failure("INVALID_JOIN_RESPONSE");
      this.index = index;
      this.participant = participant;
      this.ready = false;
      this.synced = false;
      this.authCount = 0;
      this.syncCount = 0;
      this.pending = new Map();
      this.pings = new Map();
      this.states = new Map();
      this.reveals = new Set();
      this.fatal = false;
    }
    send(type, message) {
      ensureRunning();
      if (this.socket.readyState !== 1) throw failure("STUDENT_SOCKET_CLOSED");
      const raw = JSON.stringify({ v: 1, type, id: randomUUID(), payload: { message } });
      if (Buffer.byteLength(raw) > 65536) throw failure("ENVELOPE_LIMIT");
      this.socket.send(raw);
    }
    auth() {
      this.ready = false;
      this.synced = false;
      this.send("AUTH", { protocolVersion: 1, type: "participant_auth", requestId: randomUUID(),
        sessionId: this.participant.sessionId, participantId: this.participant.participantId, credential: this.participant.credential });
    }
    rejectPending(code) {
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(failure(code)); }
      this.pending.clear();
    }
    fail() {
      if (!closing) this.fatal = true;
      this.ready = false;
      this.synced = false;
      this.rejectPending("STUDENT_TRANSPORT_FAILED");
    }
    receive(raw) {
      try {
        if (Buffer.byteLength(raw) > 65536) throw failure("FRAME_LIMIT");
        const envelope = JSON.parse(raw.toString());
        if (envelope.v !== 1 || !envelope.payload || typeof envelope.payload !== "object") throw failure("INVALID_FRAME");
        const payload = envelope.payload;
        if (envelope.type === "CONTROL") {
          if (payload.op === "teacher_offline") {
            this.ready = false; this.synced = false;
            if (!plannedRecovery) transport.unexpectedOffline++;
          }
          if (payload.op === "REAUTH_REQUIRED") { transport.reauth++; this.auth(); }
          return;
        }
        if (envelope.type === "AUTH") {
          if (payload.accepted !== true) { this.fail(); return; }
          this.ready = true; this.authCount++; transport.authenticated++;
          return;
        }
        if (envelope.type === "ERROR") { transport.protocolErrors++; this.fail(); return; }
        const message = payload.message;
        if (!message) return;
        if (message.type === "session_sync") { this.synced = true; this.syncCount++; transport.syncs++; }
        if (message.type === "question_state_changed") this.states.set(message.question.sessionQuestionId, message.question.state);
        if (message.type === "question_revealed") this.reveals.add(message.reveal.sessionQuestionId);
        if (message.type === "pong" && this.pings.delete(message.requestId)) transport.pongs++;
        if (message.type === "error") { transport.protocolErrors++; this.fail(); return; }
        if (message.type === "submission_acknowledged") {
          const acknowledgement = message.acknowledgement;
          const entry = this.pending.get(acknowledgement.submissionId);
          if (entry) {
            clearTimeout(entry.timer); this.pending.delete(acknowledgement.submissionId);
            entry.resolve({ client: this.index, ms: performance.now() - entry.started, accepted: acknowledgement.accepted === true });
          }
        }
      } catch { transport.protocolErrors++; this.fail(); }
    }
    async open() {
      const url = new URL(`/v1/sessions/${remoteSessionId}/ws`, origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      this.socket = new WebSocketImpl(url, { origin: new URL(origin).origin, followRedirects: false, maxPayload: 65536 });
      this.socket.on("message", raw => this.receive(raw));
      this.socket.on("error", () => { if (!closing) transport.socketErrors++; this.fail(); });
      this.socket.on("close", () => this.fail());
      const opened = new Promise((resolve, reject) => {
        this.socket.once("open", resolve);
        this.socket.once("error", () => reject(failure("SOCKET_OPEN_FAILED")));
        this.socket.once("close", () => reject(failure("SOCKET_OPEN_FAILED")));
      });
      await wait(opened, 15000, "SOCKET_OPEN_DEADLINE");
      this.auth();
      await until(() => this.ready && this.synced);
      this.pingTimer = setInterval(() => {
        if (!this.ready || !this.synced || closing || runAbort.signal.aborted) return;
        try {
          for (const [id, at] of this.pings) if (performance.now() - at > 15000) this.pings.delete(id);
          const requestId = randomUUID(); this.pings.set(requestId, performance.now());
          this.send("REALTIME", { protocolVersion: 1, type: "ping", requestId });
        } catch { this.fail(); }
      }, 3000);
    }
    submit(questionId) {
      if (!this.ready || !this.synced) return Promise.reject(failure("AUTH_SYNC_REQUIRED"));
      const submissionId = randomUUID();
      const promise = new Promise((resolve, reject) => {
        const entry = { started: performance.now(), resolve, reject,
          timer: setTimeout(() => {
            this.pending.delete(submissionId);
            resolve({ client: this.index, ms: 10000, accepted: false, censored: true });
          }, 10000) };
        this.pending.set(submissionId, entry);
        try {
          this.send("REALTIME", { protocolVersion: 1, type: "submit_answer", requestId: randomUUID(), submissionId,
            sessionQuestionId: questionId, answer: { type: "true_false", value: true } });
        } catch { clearTimeout(entry.timer); this.pending.delete(submissionId); reject(failure("SUBMIT_FAILED")); }
      });
      return wait(promise, 10001, "ACK_DEADLINE");
    }
    async close() {
      clearInterval(this.pingTimer);
      this.rejectPending("WORK_STOPPED");
      this.pings.clear();
      if (!this.socket || this.socket.readyState === 3) return true;
      return new Promise(resolve => {
        const timer = setTimeout(() => { this.socket.terminate(); resolve(false); }, 1000);
        this.socket.once("close", () => { clearTimeout(timer); resolve(true); });
        if (this.socket.readyState === 0) this.socket.terminate(); else this.socket.close();
      });
    }
  }

  function read(client, { detail = false, cancel = false, onFirstByte } = {}) {
    const promise = readBody(client, { detail, cancel, onFirstByte });
    pendingReads.add(promise);
    promise.finally(() => pendingReads.delete(promise)).catch(() => {});
    return promise;
  }
  async function readBody(client, { detail, cancel, onFirstByte }) {
    ensureRunning();
    const operation = detail ? "PEER_REVIEW_ACTIVITIES_LIST" : "SESSION_ASSET_GET";
    const request = detail ? { operation, arguments: { page: { limit: 10 } } }
      : { operation, arguments: { assetId: details.imageId } };
    const key = `${client.participant.participantId}:/v1/sessions/${remoteSessionId}/http/${operation}`;
    const attemptStart = (attempts.get(key) ?? []).length;
    const began = performance.now();
    const abort = new AbortController();
    const cancelRead = () => abort.abort();
    runAbort.signal.addEventListener("abort", cancelRead, { once: true });
    activeReads.add(abort);
    const timer = setTimeout(cancelRead, Math.min(detail ? 15000 : 60000, remainingMs()));
    let reader;
    let responseBody;
    let terminalRead = false;
    let bytes = 0;
    const row = { client: client.index, startedAtMs: now(), firstByteAtMs: null, completedAtMs: null,
      status: "FETCH_ERROR", bytes: 0 };
    try {
      const response = await wait(module.studentHttpRead(client.participant, request, abort.signal),
        detail ? 15000 : 60000, "HTTP_DEADLINE");
      responseBody = response.body;
      row.status = response.status;
      if (!response.ok) {
        cancelOwnedBody(response.body);
        return row;
      }
      row.mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? null;
      if (row.mime !== (detail ? "application/json" : "image/png") || !response.body) throw failure("HTTP_SHAPE");
      const hash = createHash("sha256");
      reader = response.body.getReader();
      while (true) {
        let part;
        try { part = await wait(reader.read(), detail ? 15000 : 60000, "BODY_DEADLINE"); }
        catch (error) {
          // A reader rejection means the stream is already terminal. A losing
          // deadline race still needs explicit cancellation of the pending read.
          terminalRead = !["BODY_DEADLINE", "WORK_STOPPED"].includes(error?.code);
          throw error;
        }
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > (detail ? maxDetailBytes : maxImageBytes)) throw failure("HTTP_SIZE_LIMIT");
        hash.update(part.value);
        if (row.firstByteAtMs === null) {
          row.firstByteAtMs = now();
          if (!detail) bodyReads.add(abort);
          onFirstByte?.();
        }
        if (cancel) {
          cancelOwnedBody(reader);
          abort.abort();
          row.status = "CANCELLED";
          return row;
        }
      }
      row.hashOk = detail || hash.digest("hex") === imageHash;
      if (!row.hashOk) row.status = "INTEGRITY_FAILED";
      return row;
    } catch {
      row.status = row.firstByteAtMs === null ? "FETCH_ERROR" : "INTERRUPTED";
      if (!terminalRead) cancelOwnedBody(reader ?? responseBody);
      abort.abort();
      return row;
    } finally {
      clearTimeout(timer);
      runAbort.signal.removeEventListener("abort", cancelRead);
      activeReads.delete(abort); bodyReads.delete(abort);
      row.bytes = bytes;
      row.completedAtMs = now();
      row.totalMs = performance.now() - began;
      row.attempts = (attempts.get(key) ?? []).slice(attemptStart);
      row.firstAttemptStatus = row.attempts[0]?.status ?? null;
    }
  }
  async function resourcesReleased() {
    let snapshot;
    const began = performance.now();
    do {
      snapshot = await native("metrics");
      if (snapshot.activeReaders === 0 && snapshot.activeMedia === 0 && snapshot.creditWaiters === 0) return snapshot;
      await pause(20);
    } while (performance.now() - began < 5000);
    return snapshot;
  }
  const released = snapshot => snapshot.activeReaders === 0 && snapshot.activeMedia === 0
    && snapshot.creditWaiters === 0 && snapshot.budgetStopped === false;

  try {
    for (let seat = 1; seat <= students; seat++) {
      ensureRunning();
      // Join exactly once: no runner-private retry. The per-attempt UUID is kept
      // only in memory and is not confused with an extra classroom admission.
      const response = await wait(globalThis.fetch(new URL(`/v1/sessions/${remoteSessionId}/join`, origin),
        { method: "POST", headers: { "content-type": "application/json" }, signal: runAbort.signal,
          body: JSON.stringify({ remoteProtocolVersion: 1, joinAttemptId: randomUUID(), seatNumber: seat, name: `Fixture ${seat}` }) }),
      15000, "JOIN_DEADLINE");
      if (response.status !== 200) throw failure("JOIN_REJECTED");
      const joined = await joinJson(response);
      transport.joins++;
      const student = new Student(seat, joined.participant);
      clients.push(student);
      await student.open();
    }
    observations.push({ label: "lobby_admission", connected: clients.length,
      authenticated: clients.filter(client => client.ready).length,
      personalizedSync: clients.filter(client => client.synced).length,
      status: "PASS", socketLadder: false });
    details = await native("start", { participantIds: clients.map(client => client.participant.participantId) });
    const textAcks = await Promise.all(clients.map(client => client.submit(details.questionId)));
    const textProgress = await native("progress");
    observations.push({ label: "text_ack", rows: textAcks, summary: quantiles(textAcks.map(row => row.ms)),
      authoritativeAnsweredCount: textProgress.answeredCount });
    gate("text_ack", allAcks(textAcks, 2000));
    gate("text_authoritative_answers", textProgress.answeredCount === students);
    stopIfFailed();

    for (const readers of stages) {
      details = await native("publish");
      let first;
      const firstByte = new Promise(resolve => { first = resolve; });
      const media = Promise.all(clients.slice(0, readers).map(client => read(client, { onFirstByte: first })));
      await wait(firstByte, 30000, "FIRST_BYTE_DEADLINE");
      const timing = { probeStartedAtMs: now(), activeMediaBodiesAtProbe: bodyReads.size,
        connectedParticipants: students, concurrentReaders: readers };
      const ackPromise = Promise.all(clients.map(client => client.submit(details.questionId)));
      const detailPromise = read(clients.at(-1), { detail: true });
      const presencePromise = native("presence");
      const [acks, detail, presence, rows] = await Promise.all([ackPromise, detailPromise, presencePromise, media]);
      timing.controlCompletedAtMs = now();
      const progress = await native("progress");
      const metrics = await resourcesReleased();
      observations.push({ label: "image_readers", ...timing, rows, acks,
        ack: quantiles(acks.map(row => row.ms)), detail, presence: { online: presence.online },
        authoritativeAnsweredCount: progress.answeredCount, native: metrics,
        firstAttemptRejected: rows.filter(row => row.firstAttemptStatus !== 200).length });
      gate(`image_completion_${readers}`, rows.length === readers && rows.every(row => row.status === 200 && row.hashOk && row.totalMs <= 60000)
        && rows.filter(row => row.totalMs <= 30000).length >= Math.ceil(readers * 0.95));
      gate(`media_overlap_${readers}`, timing.activeMediaBodiesAtProbe > 0 ? "PASS" : "NOT_OBSERVED");
      gate(`media_ack_${readers}`, allAcks(acks, 3000));
      gate(`media_detail_${readers}`, detail.status === 200);
      gate(`media_answers_presence_${readers}`, progress.answeredCount === students && presence.online === students);
      gate(`media_release_${readers}`, released(metrics));
      stopIfFailed();
    }

    // Lock/reveal is measured on its own image read. If the image finishes first,
    // the active counts say so; only the observed ACK overlap is a capacity gate.
    let firstLock;
    const lockFirstByte = new Promise(resolve => { firstLock = resolve; });
    const lockMedia = read(clients[0], { onFirstByte: firstLock });
    await wait(lockFirstByte, 30000, "FIRST_BYTE_DEADLINE");
    const lock = { startedAtMs: now(), activeMediaBodiesAtStart: bodyReads.size };
    await native("lock");
    await until(() => clients.every(client => client.states.get(details.questionId) === "LOCKED"), 5000);
    lock.completedAtMs = now();
    const reveal = { startedAtMs: now(), activeMediaBodiesAtStart: bodyReads.size };
    await native("reveal");
    await until(() => clients.every(client => client.reveals.has(details.questionId)), 5000);
    reveal.completedAtMs = now();
    observations.push({ label: "lock_reveal", lock, reveal, media: await lockMedia });
    gate("lock_reveal", true);

    const cancelled = await read(clients[0], { cancel: true });
    const afterCancel = await resourcesReleased();
    const replacement = await read(clients[0]);
    observations.push({ label: "cancel_release", cancelled, nativeAfterCancel: afterCancel, replacement });
    gate("cancel_release", cancelled.status === "CANCELLED" && released(afterCancel) && replacement.status === 200 && replacement.hashOk);
    stopIfFailed();

    details = await native("publish");
    let recoveryFirst;
    const recoveryFirstByte = new Promise(resolve => { recoveryFirst = resolve; });
    const inFlight = read(clients[0], { onFirstByte: recoveryFirst });
    await wait(recoveryFirstByte, 30000, "FIRST_BYTE_DEADLINE");
    const recovery = { startedAtMs: now(), activeMediaBodiesAtStart: bodyReads.size };
    const old = clients.map(client => ({ auth: client.authCount, sync: client.syncCount }));
    plannedRecovery = true;
    await native("reconnect");
    await until(() => clients.every((client, index) => client.ready && client.synced
      && client.authCount > old[index].auth && client.syncCount > old[index].sync), 30000);
    recovery.authSyncCompletedAtMs = now();
    plannedRecovery = false;
    const interrupted = await inFlight;
    const recoveryAcks = await Promise.all(clients.map(client => client.submit(details.questionId)));
    const recoveredImage = await read(clients[0]);
    const recoveryProgress = await native("progress");
    const finalMetrics = await resourcesReleased();
    const finalPresence = await native("presence");
    observations.push({ label: "generation_recovery", ...recovery, interrupted,
      interruptedBodyReplayed: false, generationsCombined: false,
      acks: recoveryAcks, authoritativeAnsweredCount: recoveryProgress.answeredCount,
      recoveredImage, native: finalMetrics, presence: { online: finalPresence.online } });
    gate("generation_auth_sync", true);
    // A fast image may complete before replacement reaches the relay; never
    // mislabel that observation as an interrupted-stream verification.
    gate("generation_inflight_interruption", interrupted.status === "INTERRUPTED" ? "PASS" : "NOT_OBSERVED");
    gate("generation_answers", allAcks(recoveryAcks, 2000) && recoveryProgress.answeredCount === students);
    gate("generation_image", recoveredImage.status === 200 && recoveredImage.hashOk);
    gate("final_release", released(finalMetrics));
    gate("final_liveness", finalPresence.online === students && transport.unexpectedOffline === 0
      && transport.socketErrors === 0 && transport.protocolErrors === 0 && clients.every(client => client.ready && client.synced && !client.fatal));
    report.runnerCompleted = true;
    report.workloadCompleted = true;
    report.productGatesPass = gates.every(row => row.status === "PASS");
    if (!report.productGatesPass) report.stopReason = "PRODUCT_GATES_NOT_ALL_PASS";
  } catch (error) {
    report.runnerCompleted = error?.code === "PRODUCT_GATE_STOP";
    report.stopReason = ["PRODUCT_GATE_STOP", "WORK_STOPPED", "NATIVE_CONTROL_DEADLINE", "FIRST_BYTE_DEADLINE",
      "STUDENT_TRANSPORT_FAILED", "JOIN_REJECTED"].includes(error?.code) ? error.code : "WORKLOAD_FAILED";
  } finally {
    closing = true;
    runAbort.abort();
    for (const readAbort of activeReads) readAbort.abort();
    // All reads use bounded waits and abortable transports. Do not leave a
    // late Student-policy fetch running after global fetch is restored.
    let readCleanupTimer;
    const readsSettled = await Promise.race([Promise.allSettled([...pendingReads]).then(async () => {
      await Promise.allSettled([...pendingCancels]);
      return true;
    }),
      new Promise(resolve => { readCleanupTimer = setTimeout(() => resolve(false), 1000); })]);
    clearTimeout(readCleanupTimer);
    const closed = await Promise.all(clients.map(client => client.close().catch(() => false)));
    globalThis.fetch = originalFetch;
    workloadActive = false;
    signal?.removeEventListener("abort", onExternalAbort);
    const cancellationConfirmed = cancellationFailures === 0 && pendingCancels.size === 0;
    report.cleanup = { complete: readsSettled && closed.every(Boolean) && cancellationConfirmed,
      ownedSocketsClosed: closed.every(Boolean), httpCancellationConfirmed: cancellationConfirmed,
      cancellationFailures, pendingOperationsCleared: clients.every(client => client.pending.size === 0)
        && pendingReads.size === 0 && pendingCancels.size === 0, timersCleared: true };
    report.elapsedMs = now();
  }
  return report;
}
