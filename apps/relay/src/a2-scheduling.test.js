import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";

// Component scheduling regression, NOT classroom capacity/authorization evidence.
// The real local Worker/DO/HttpRelay runs in workerd; only Teacher responses are
// synthetic. No network URL, production D1, credentials or 100 MiB fixture used.
const require = createRequire(import.meta.url);
const wrangler = dirname(require.resolve("wrangler/package.json"));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require(require.resolve("miniflare", { paths: [wrangler] }));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const baseline = process.env.A2_SCHEDULING_SOURCE === "pass-a";
const noPipeWait = process.env.A2_SCHEDULING_NO_PIPE_WAIT === "1";
const fairCredit = process.env.A2_SCHEDULING_FAIR_CREDIT === "1";
function moduleSource(name) {
  let source = baseline
    ? name === "worker.js"
      ? readFileSync(new URL("../../teacher/src-tauri/target/phase16f-a2-before/apps/relay/src/worker.js", import.meta.url), "utf8")
      : name === "admission.js" ? "export {};" : execFileSync("git", ["show", "c5285196a08e412732eb2246efd78e3c9644d15a:apps/relay/src/" + name], { cwd: repository, encoding: "utf8" })
    : readFileSync(new URL("./" + name, import.meta.url), "utf8");
  if (noPipeWait && name === "worker.js") {
    const target = "promise => this.ctx.waitUntil(promise)";
    assert.ok(source.includes(target), "diagnostic candidate must match the actual pipe callback");
    source = source.replace(target, "promise => { void promise; }");
  }
  if (fairCredit && name === "http_relay.js") {
    const target = "  credit(entry, count) {";
    assert.ok(source.includes(target));
    source = source.replace(target, `  credit(entry, count) {
    if (count === HTTP_WINDOW) { this.sendCredit(entry, count); return; }
    if (entry.ended || !this.pending.has(entry.id)) return;
    this.queuedCredits ??= new Map();
    this.queuedCredits.set(entry, (this.queuedCredits.get(entry) ?? 0) + count);
    if (this.creditFlush !== undefined) return;
    this.creditFlush = setTimeout(() => {
      this.creditFlush = undefined;
      const queued = this.queuedCredits; this.queuedCredits = new Map();
      for (const [pending, credits] of queued) this.sendCredit(pending, credits);
    }, 0);
  }

  sendCredit(entry, count) {`);
    source = source.replace("  remove(entry) {", "  remove(entry) {\n    this.queuedCredits?.delete(entry);");
  }
  return source;
}
function deadline(promise, message, ms = 1500) {
  let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
function inbox(socket) {
  const seen = []; const waiting = [];
  socket.addEventListener("message", event => {
    const value = JSON.parse(event.data); seen.push(value);
    for (const waiter of [...waiting]) if (waiter.matches(value)) { waiting.splice(waiting.indexOf(waiter), 1); waiter.resolve(value); }
  });
  return { seen, next(matches) { const value = seen.find(matches); return value ? Promise.resolve(value) : new Promise(resolve => waiting.push({ matches, resolve })); } };
}
const send = (socket, type, id, payload) => socket.send(JSON.stringify({ v: 1, type, id, payload }));

for (const continuous of [false, true]) test("four " + (continuous ? "flowing" : "held") + " media responses do not block Student AUTH/realtime or independent detail admission", { timeout: 20000 }, async t => {
  const timing=[];const began=performance.now();const mark=event=>timing.push({event,ms:performance.now()-began});
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: ["worker.js", "http_relay.js", "contract.js", "lifecycle.js", "admission.js"].map(name => ({ type: "ESModule", path: fileURLToPath(new URL("./" + name, import.meta.url)), contents: moduleSource(name) })),
    compatibilityDate: "2026-09-24", host: "127.0.0.1", port: 0,
    log: new Log(LogLevel.NONE), d1Databases: { INSTALLATIONS: randomUUID() },
    durableObjects: { CLASSROOM_SESSION: { className: "ClassroomSession", useSQLite: true } },
    bindings: { OPERATOR_TOKEN: "synthetic-component-only", CONNECT_TICKET_TTL_SECONDS: "15", RELAY_MAX_LIFETIME_SECONDS: "3600" },
    serviceBindings: { ASSETS: () => new Response("synthetic") },
  }));
  const sockets = []; const held = []; const aborts = []; const completed = []; const bodies = []; let closing = false;
  try {
    const db = await mf.getD1Database("INSTALLATIONS");
    const schema = readFileSync(new URL("../migrations/0001_installations.sql", import.meta.url), "utf8");
    for (const statement of schema.split(";").filter(value => value.trim())) await db.prepare(statement).run();
    const request = (path, method = "GET", body, token) => mf.dispatchFetch("http://local.test" + path, { method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const activation = await (await request("/v1/operator/activation-codes", "POST", {}, "synthetic-component-only")).json();
    const installation = await (await request("/v1/enroll", "POST", { activationCode: activation.activationCode })).json();
    const session = await (await request("/v1/teacher/sessions", "POST", { teacherAppVersion: "synthetic", remoteProtocolVersion: 1 }, installation.installationCredential)).json();
    const ticket = await (await request("/v1/teacher/sessions/" + session.remoteSessionId + "/tickets", "POST", undefined, installation.installationCredential)).json();
    const teacherResponse = await mf.dispatchFetch("http://local.test/v1/teacher/sessions/" + session.remoteSessionId + "/ws", { headers: { upgrade: "websocket", authorization: "Bearer " + ticket.ticket } });
    assert.equal(teacherResponse.status, 101);
    const teacher = teacherResponse.webSocket; sockets.push(teacher); const teacherInbox = inbox(teacher); teacher.accept();
    const attached = await deadline(teacherInbox.next(value => value.payload.op === "teacher_attached"), "Teacher attach");
    const generation = attached.payload.generation;
    const pending = new Map(); let mediaStarted = 0;
    teacher.addEventListener("message", event => {
      if (closing) return;
      const value = JSON.parse(event.data); const p = value.payload;
      if(value.type === "AUTH") mark("teacher_receives_AUTH");
      if(value.type === "REALTIME") mark("teacher_receives_realtime");
      if(p.op === "HTTP_REQUEST") mark("teacher_receives_" + p.request.operation);
      if (value.type === "AUTH") {
        send(teacher, "AUTH", value.id, { generation, connectionId: p.connectionId, accepted: true, message: { protocolVersion: 1, type: "participant_authenticated" } });
      } else if (value.type === "REALTIME") {
        send(teacher, "REALTIME", value.id, { generation, connectionId: p.connectionId, message: { protocolVersion: 1, type: "pong", requestId: p.message.requestId } });
      } else if (value.type === "HTTP_RELAY" && p.op === "HTTP_REQUEST") {
        const media = p.request.operation === "SESSION_ASSET_GET";
        pending.set(value.id, { media, initial: false, sequence: 0 }); if (media) mediaStarted += 1;
        send(teacher, "HTTP_RELAY", value.id, { op: "HTTP_RESPONSE_START", generation, status: 200, contentType: media ? "application/pdf" : "application/json", contentLength: media ? 32 * 1024 * (continuous ? 256 : 8) : 2 });
      } else if (value.type === "HTTP_RELAY" && p.op === "HTTP_CREDIT") {
        const entry = pending.get(value.id); if (!entry || (entry.initial && (!entry.media || !continuous))) return; entry.initial = true;
        if (entry.media) {
          for (let index = 0; index < p.credits && entry.sequence < (continuous ? 256 : 4); index += 1) send(teacher, "HTTP_RELAY", value.id, { op: "HTTP_RESPONSE_CHUNK", generation, sequence: entry.sequence++, data: Buffer.alloc(32 * 1024, 42).toString("base64") });
          if (continuous && entry.sequence === 256) { pending.delete(value.id); send(teacher, "HTTP_RELAY", value.id, { op: "HTTP_RESPONSE_END", generation, chunks: 256, bytes: 32 * 1024 * 256 }); }
        }
        else { send(teacher, "HTTP_RELAY", value.id, { op: "HTTP_RESPONSE_CHUNK", generation, sequence: 0, data: "e30=" }); send(teacher, "HTTP_RELAY", value.id, { op: "HTTP_RESPONSE_END", generation, chunks: 1, bytes: 2 }); }
      }
    });
    const localSessionId = randomUUID();
    const http = (participantId, operation) => {
      const abort = new AbortController(); aborts.push(abort);
      const query = operation === "SESSION_ASSET_GET" ? "?assetId=" + randomUUID() : "?activityId=" + randomUUID();
      return mf.dispatchFetch("http://local.test/v1/sessions/" + session.remoteSessionId + "/http/" + operation + query, { signal: abort.signal,
        headers: { authorization: "Bearer " + "A".repeat(43), "x-classroom-session": localSessionId, "x-classroom-participant": participantId } });
    };
    const media = await deadline(Promise.all(Array.from({ length: 4 }, () => http(randomUUID(), "SESSION_ASSET_GET"))), "four media headers");
    for (const response of media) { assert.equal(response.status, 200); held.push(response.body.getReader()); }
    const firstChunks = await deadline(Promise.all(held.map(reader => reader.read())), "all four first media chunks");
    assert.ok(firstChunks.every(first => first.value.byteLength > 0));
    assert.equal(mediaStarted, 4); mark("all_first_bytes");
    if (continuous) held.forEach((reader, index) => bodies.push((async () => {
      let bytes = firstChunks[index].value.byteLength;
      for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; }
      completed.push(bytes); mark("media_complete"); return bytes;
    })()));
    const studentResponse = await deadline(mf.dispatchFetch("http://local.test/v1/sessions/" + session.remoteSessionId + "/ws", { headers: { upgrade: "websocket", origin: "http://local.test" } }), "Student upgrade blocked by media");
    mark("Student_upgrade"); assert.equal(studentResponse.status, 101); const student = studentResponse.webSocket; sockets.push(student); const messages = inbox(student); student.accept();
    const authId = randomUUID();
    send(student, "AUTH", authId, { message: { protocolVersion: 1, type: "participant_auth", requestId: randomUUID(), sessionId: localSessionId, participantId: randomUUID(), credential: "B".repeat(43) } });
    assert.equal((await deadline(messages.next(value => value.id === authId && value.type === "AUTH"), "Student AUTH blocked by media")).payload.accepted, true);
    mark("Student_AUTH_complete"); const pingId = randomUUID(); send(student, "REALTIME", randomUUID(), { message: { protocolVersion: 1, type: "ping", requestId: pingId } });
    assert.equal((await deadline(messages.next(value => value.payload.message?.requestId === pingId), "Student realtime blocked by media")).payload.message.type, "pong");
    mark("pong_complete"); const detail = await deadline(http(randomUUID(), "PEER_REVIEW_ACTIVITY_GET"), "detail headers blocked by media");
    assert.equal(detail.status, 200); assert.deepEqual(await deadline(detail.json(), "detail body blocked by media"), {});
    mark("detail_complete"); t.diagnostic(JSON.stringify({baseline,noPipeWait,fairCredit,continuous,timing}));
    assert.equal(held.length, 4);
    assert.equal(completed.length, 0, "control checks must finish while media is still outstanding");
    if (continuous) assert.deepEqual(await deadline(Promise.all(bodies), "bounded 32 MiB component flow", 12000), Array(4).fill(8 * 1024 * 1024));
  } finally {
    closing = true;
    t.diagnostic(JSON.stringify({baseline,noPipeWait,fairCredit,continuous,finalTiming:timing}));
    for (const abort of aborts) abort.abort();
    for (const socket of sockets) try { socket.close(); } catch { /* already closed */ }
    await Promise.allSettled(held.map(reader => reader.cancel()));
    await Promise.allSettled(bodies);
    await mf.dispose();
  }
});
