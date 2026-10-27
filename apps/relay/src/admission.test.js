import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PublicAdmission, SessionAdmission } from "./admission.js";

const remoteId = "r".repeat(32);
const request = (suffix, ip = "203.0.113.1", extra = {}) => new Request(
  "https://local.test/v1/sessions/" + remoteId + suffix,
  { headers: { "cf-connecting-ip": ip, ...extra } },
);
const consume = (gate, req) => { const release = gate.acquire(req); release?.(); return !!release; };

test("40 same-NAT participants can join, retry join, connect and reconnect without per-IP false rejection", () => {
  const gate = new PublicAdmission(() => 0);
  for (let i = 0; i < 80; i += 1) assert.equal(consume(gate, request("/join")), true);
  for (let i = 0; i < 120; i += 1) assert.equal(consume(gate, request("/ws")), true);
  for (let i = 0; i < 240; i += 1) assert.equal(consume(gate, request("/http/SESSION_ASSET_GET")), true);
  assert.equal(gate.pending, 0);
});

test("HTTP retries refill at a bounded rate while exhaustion in one route does not consume another route", () => {
  let now = 0; const gate = new PublicAdmission(() => now);
  for (let i = 0; i < 256; i += 1) assert.equal(consume(gate, request("/http/SESSION_ASSET_GET")), true);
  assert.equal(consume(gate, request("/http/SESSION_ASSET_GET")), false);
  assert.equal(consume(gate, request("/bootstrap")), true);
  now = 1000;
  for (let i = 0; i < 64; i += 1) assert.equal(consume(gate, request("/http/SESSION_ASSET_GET")), true);
  assert.equal(consume(gate, request("/http/SESSION_ASSET_GET")), false);
  now = 0; assert.equal(consume(gate, request("/http/SESSION_ASSET_GET")), false);
});

test("untrusted X-Forwarded-For and participant headers cannot reset public admission", () => {
  const gate = new PublicAdmission(() => 0);
  for (let i = 0; i < 80; i += 1) assert.equal(consume(gate, request("/join", "203.0.113.1")), true);
  assert.equal(consume(gate, request("/join", "203.0.113.1", {
    "x-forwarded-for": "198.51.100.2", "x-participant-id": randomUUID(),
  })), false);
  assert.equal(gate.ips.size, 1);
});

test("per-isolate admission bounds requests even when trusted addresses differ", () => {
  const gate = new PublicAdmission(() => 0); let admitted = 0;
  for (let i = 0; i < 300; i += 1) admitted += Number(consume(gate, request("/join", "203.0." + (i >> 8) + "." + (i & 255))));
  assert.equal(admitted, 256);
});

test("pending public work has both per-IP and isolate caps; release is idempotent", () => {
  const gate = new PublicAdmission(() => 0); const releases = [];
  for (let i = 0; i < 64; i += 1) { const release = gate.acquire(request("/bootstrap")); assert.ok(release); releases.push(release); }
  assert.equal(gate.acquire(request("/bootstrap")), null);
  for (let i = 0; i < 64; i += 1) { const release = gate.acquire(request("/bootstrap", "203.0.113.2")); assert.ok(release); releases.push(release); }
  assert.equal(gate.acquire(request("/bootstrap", "203.0.113.3")), null);
  for (const release of releases) { release(); release(); }
  assert.equal(gate.pending, 0); assert.ok(gate.acquire(request("/bootstrap", "203.0.113.3")));
});

test("bounded IP map rejects key churn until inactive entries have fully refilled", () => {
  let now = 0; const gate = new PublicAdmission(() => now);
  for (let i = 0; i < 1100; i += 1) consume(gate, request("/http/SESSION_ASSET_GET", "2001:db8::" + i.toString(16)));
  assert.equal(gate.ips.size, 1024);
  assert.equal(consume(gate, request("/join", "2001:db8::ffff")), false);
  assert.equal(gate.ips.has("2001:db8::0"), true);
  now = 600000; assert.equal(consume(gate, request("/join", "2001:db8::ffff")), true);
  assert.equal(gate.ips.size, 1);
});

test("public admission does not rate-limit static assets or existing authenticated WebSocket messages", () => {
  const gate = new PublicAdmission(() => 0);
  for (let i = 0; i < 2000; i += 1) assert.equal(consume(gate, new Request("https://local.test/assets/student.js")), true);
  assert.equal(gate.ips.size, 0); assert.equal(gate.pending, 0);
});

test("per-DO admission survives changing claimed participant identities within an instance", () => {
  let now = 0; const gate = new SessionAdmission(() => now);
  for (let i = 0; i < 80; i += 1) assert.equal(gate.allow("/join"), true);
  assert.equal(gate.allow("/join"), false);
  for (let i = 0; i < 128; i += 1) assert.equal(gate.allow("/student-ws"), true);
  assert.equal(gate.allow("/student-ws"), false);
  for (let i = 0; i < 256; i += 1) assert.equal(gate.allow("/http-read"), true);
  assert.equal(gate.allow("/http-read"), false);
  now = 1000;
  for (let i = 0; i < 4; i += 1) assert.equal(gate.allow("/join"), true);
  assert.equal(gate.allow("/join"), false);
  assert.equal(gate.allow("/ticket"), true);
});

async function actualWorker() {
  // Real route/DO code, with platform host and deterministic clock only replaced.
  // No external request, production D1 or Classroom domain data is used.
  let source = readFileSync(new URL("./worker.js", import.meta.url), "utf8");
  source = source.replace('"cloudflare:workers"', '"data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"')
    .replace(/from "(\.\/[^"]+)"/g, (_match, path) => "from " + JSON.stringify(new URL(path, import.meta.url).href))
    .replaceAll("new PublicAdmission()", "new PublicAdmission(() => 0)")
    .replaceAll("new SessionAdmission()", "new SessionAdmission(() => 0)");
  return import("data:text/javascript;base64," + Buffer.from(source + "\n// " + randomUUID()).toString("base64"));
}

function dispatchEnv() {
  const counts = { d1: 0, lookups: 0 };
  return { counts, env: {
    INSTALLATIONS: {
      prepare: () => ({ bind: () => ({ first: async () => { counts.d1 += 1; return null; } }) }),
      batch: async () => { counts.d1 += 1; return [{ meta: { changes: 0 } }, { meta: { changes: 0 } }]; },
    },
    CLASSROOM_SESSION: { getByName: () => { counts.lookups += 1; return { fetch: async () => new Response(null, { status: 404 }) }; } },
    ASSETS: { fetch: async () => new Response("synthetic") },
  } };
}

test("actual Worker bounds invalid activation D1 attempts before expensive dispatch", async () => {
  const { default: worker } = await actualWorker(); const { env, counts } = dispatchEnv(); const statuses = [];
  for (let i = 0; i < 20; i += 1) statuses.push((await worker.fetch(new Request("https://local.test/v1/enroll", {
    method: "POST", headers: { "cf-connecting-ip": "203.0.113.1" }, body: JSON.stringify({ activationCode: "A".repeat(43) }),
  }), env)).status);
  assert.equal(counts.d1, 8); assert.equal(statuses.filter(status => status === 429).length, 12);
});

test("actual Worker bounds valid-looking unknown IDs without creating metadata", async () => {
  const { default: worker } = await actualWorker(); const { env, counts } = dispatchEnv(); let rejected = 0;
  for (let i = 0; i < 200; i += 1) {
    const response = await worker.fetch(new Request("https://local.test/v1/sessions/" + i.toString(16).padStart(32, "0") + "/bootstrap", {
      headers: { "cf-connecting-ip": "203.0.113.1" },
    }), env); rejected += Number(response.status === 429);
  }
  assert.equal(counts.lookups, 160); assert.equal(counts.d1, 0); assert.equal(rejected, 40);
});

for (const [operation, attempts, expected] of [["join", 100, 80], ["ws", 160, 128]]) {
  test("actual Worker bounds unauthenticated " + operation + " dispatch and accepts a 40-person NAT burst", async () => {
    const { default: worker } = await actualWorker(); const { env, counts } = dispatchEnv(); const statuses = [];
    for (let i = 0; i < attempts; i += 1) {
      const response = await worker.fetch(new Request("https://local.test/v1/sessions/" + remoteId + "/" + operation, {
        method: operation === "join" ? "POST" : "GET",
        headers: { "cf-connecting-ip": "203.0.113.1", ...(operation === "ws" ? { upgrade: "websocket" } : {}) },
        ...(operation === "join" ? { body: JSON.stringify({ remoteProtocolVersion: 1, joinAttemptId: randomUUID(), seatNumber: i + 1, name: "Synthetic" }) } : {}),
      }), env);
      statuses.push(response.status);
    }
    assert.equal(statuses.slice(0, 40).includes(429), false);
    assert.equal(counts.lookups, expected); assert.equal(statuses.filter(status => status === 429).length, attempts - expected);
  });
}

test("actual Worker rejects malformed ID floods before DO dispatch with a bounded admission response", async () => {
  const { default: worker } = await actualWorker(); const { env, counts } = dispatchEnv(); let rejected = 0;
  for (let i = 0; i < 200; i += 1) rejected += Number((await worker.fetch(new Request("https://local.test/v1/sessions/invalid/bootstrap", {
    headers: { "cf-connecting-ip": "203.0.113.1" },
  }), env)).status === 429);
  assert.equal(counts.lookups, 0); assert.equal(rejected, 40);
});

test("actual DO dispatch has an independent per-instance join admission boundary", async () => {
  const { ClassroomSession } = await actualWorker();
  const ctx = { storage: { kv: { get: () => undefined } }, getWebSockets: () => [], waitUntil: () => {} };
  const relay = new ClassroomSession(ctx, {}); const statuses = [];
  for (let i = 0; i < 100; i += 1) statuses.push((await relay.fetch(new Request("https://relay.internal/join", { method: "POST", body: "{}" }))).status);
  assert.equal(statuses.filter(status => status === 429).length, 20);
  assert.equal(relay.pendingJoins.size, 0);
});

for (const oversized of [false, true]) {
  test("actual Worker bounded body read " + (oversized ? "does not wait for slow cancellation" : "rejects a slow body within its 5-second deadline"), async () => {
    const { default: worker } = await actualWorker(); const { env, counts } = dispatchEnv();
    let closeBody; let cancelCalls = 0;
    const body = new ReadableStream({
      start(controller) {
        closeBody = () => { try { controller.close(); } catch { /* already canceled */ } };
        if (oversized) controller.enqueue(new Uint8Array(4097));
      },
      cancel() { cancelCalls += 1; return new Promise(() => {}); },
    });
    const pending = worker.fetch(new Request("https://local.test/v1/enroll", {
      method: "POST", headers: { "cf-connecting-ip": "203.0.113.1" }, body, duplex: "half",
    }), env);
    let timer;
    try {
      const response = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), oversized ? 500 : 5500); })]);
      assert.ok(response, "body budget must release admission without waiting for client cancellation");
      assert.equal(response.status, 403); assert.equal(counts.d1, 0); assert.equal(cancelCalls, 1);
    } finally { clearTimeout(timer); closeBody(); }
  });
}

test("global rate-denied new IPs cannot allocate or evict admission records", () => {
  const gate = new PublicAdmission(() => 0);
  for (let i = 0; i < 256; i += 1) assert.equal(consume(gate, request("/join", "2001:db8::" + i.toString(16))), true);
  assert.equal(gate.ips.size, 256);
  for (let i = 256; i < 1600; i += 1) assert.equal(consume(gate, request("/join", "2001:db8::" + i.toString(16))), false);
  assert.equal(gate.ips.size, 256, "global denial must happen before attacker-controlled key allocation");
  assert.equal(gate.ips.has("2001:db8::0"), true);
  assert.equal(consume(gate, request("/bootstrap", "203.0.113.222")), true);
});

test("global pending-denied new IPs cannot allocate admission records", () => {
  const gate = new PublicAdmission(() => 0); const releases = [];
  for (const ip of ["203.0.113.1", "203.0.113.2"]) {
    for (let i = 0; i < 64; i += 1) { const release = gate.acquire(request("/bootstrap", ip)); assert.ok(release); releases.push(release); }
  }
  assert.equal(gate.ips.size, 2);
  for (let i = 0; i < 100; i += 1) assert.equal(gate.acquire(request("/bootstrap", "2001:db8::" + i.toString(16))), null);
  assert.equal(gate.ips.size, 2, "global pending denial must not retain new IP keys");
  for (const release of releases) release();
  assert.equal(consume(gate, request("/bootstrap", "203.0.113.222")), true);
});
