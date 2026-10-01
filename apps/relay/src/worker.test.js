import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import WebSocket from "ws";

const base = process.env.TEST_RELAY_URL ?? "http://127.0.0.1:8787";
const operator = /^OPERATOR_TOKEN=(.+)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
assert.ok(operator, "Local operator token is required");
const sockets = [];
after(() => { for (const socket of sockets) socket.terminate(); });

async function request(path, method = "GET", body, token) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, data };
}

function wsConnect(path, ticket) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${ticket}` } });
    sockets.push(socket);
    socket.testMessages = [];
    socket.on("message", (raw) => { socket.testMessages.push(JSON.parse(raw.toString())); });
    socket.once("open", () => resolve(socket));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`WebSocket rejected: ${response.statusCode}`));
    });
    socket.once("error", reject);
  });
}

function nextMessage(socket) {
  if (socket.testMessages.length > 0) return Promise.resolve(socket.testMessages.shift());
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (socket.testMessages.length > 0) {
        clearTimeout(timer); clearInterval(poll); resolve(socket.testMessages.shift());
      }
    }, 10);
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error("WebSocket message timeout")); }, 5000);
  });
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("State did not converge");
}

test("authenticated relay lifecycle and one-use Teacher tickets", async () => {
  const denied = await request("/v1/operator/activation-codes", "POST", {}, "bad-token");
  assert.equal(denied.status, 403);
  const issued = await request("/v1/operator/activation-codes", "POST", {}, operator);
  assert.equal(issued.status, 201);
  const invalid = await request("/v1/enroll", "POST", { activationCode: "x".repeat(43) });
  assert.equal(invalid.status, 403);
  const enrolled = await request("/v1/enroll", "POST", { activationCode: issued.data.activationCode });
  assert.equal(enrolled.status, 201);
  assert.equal(enrolled.data.installationCredential.length, 43);
  assert.notEqual(createHash("sha256").update(enrolled.data.installationCredential).digest("hex"),
    enrolled.data.installationCredential);
  const replay = await request("/v1/enroll", "POST", { activationCode: issued.data.activationCode });
  assert.equal(replay.status, 403);

  const createBody = { teacherAppVersion: "0.1.0", remoteProtocolVersion: 1 };
  const wrongVersion = await request("/v1/teacher/sessions", "POST",
    { ...createBody, remoteProtocolVersion: 2 }, enrolled.data.installationCredential);
  assert.equal(wrongVersion.data.code, "PROTOCOL_MISMATCH");
  const invalidAuth = await request("/v1/teacher/sessions", "POST", createBody, "x".repeat(43));
  assert.equal(invalidAuth.status, 403);
  const created = await request("/v1/teacher/sessions", "POST", createBody, enrolled.data.installationCredential);
  assert.equal(created.status, 201);
  const id = created.data.remoteSessionId;
  assert.equal(id.length, 32);
  assert.deepEqual(await request(`/v1/sessions/${id}/bootstrap`), { status: 200,
    data: { reachable: true, remoteProtocolVersion: 1, status: "unavailable" } });
  const ticketPath = `/v1/teacher/sessions/${id}/tickets`;
  const wsPath = `/v1/teacher/sessions/${id}/ws`;
  const expiring = await request(ticketPath, "POST", undefined, enrolled.data.installationCredential);
  assert.equal(expiring.status, 200);
  await new Promise((resolve) => setTimeout(resolve,
    Math.max(0, expiring.data.ticketExpiresAt - Date.now() + 50)));
  await assert.rejects(wsConnect(wsPath, expiring.data.ticket), /403/);
  const ticketA = await request(ticketPath, "POST", undefined, enrolled.data.installationCredential);
  assert.equal(ticketA.status, 200);
  const socketA = await wsConnect(wsPath, ticketA.data.ticket);
  const attachedA = await nextMessage(socketA);
  assert.equal(attachedA.payload.op, "teacher_attached");
  assert.equal(attachedA.payload.generation, 1);
  await assert.rejects(wsConnect(wsPath, ticketA.data.ticket), /403/);
  assert.equal((await request(`/v1/sessions/${id}/bootstrap`)).data.status, "available");

  const ticketB = await request(ticketPath, "POST", undefined, enrolled.data.installationCredential);
  const socketB = await wsConnect(wsPath, ticketB.data.ticket);
  const attachedB = await nextMessage(socketB);
  assert.equal(attachedB.payload.generation, 2);
  await eventually(async () => socketA.readyState !== WebSocket.OPEN);
  const pingId = "00000000-0000-4000-8000-000000000000";
  socketB.send(JSON.stringify({ v: 1, type: "CONTROL", id: pingId, payload: { op: "ping" } }));
  const pong = await nextMessage(socketB);
  assert.equal(pong.payload.op, "pong");
  assert.equal(pong.payload.generation, 2);
  socketB.terminate();
  await eventually(async () => (await request(`/v1/sessions/${id}/bootstrap`)).data.status === "unavailable");

  const ticketC = await request(ticketPath, "POST", undefined, enrolled.data.installationCredential);
  const socketC = await wsConnect(wsPath, ticketC.data.ticket);
  assert.equal((await nextMessage(socketC)).payload.generation, 3);
  socketC.send(JSON.stringify({ v: 2, type: "CONTROL", id: pingId, payload: { op: "ping" } }));
  assert.equal((await nextMessage(socketC)).payload.code, "PROTOCOL_MISMATCH");
  await eventually(async () => socketC.readyState !== WebSocket.OPEN);
  const ticketD = await request(ticketPath, "POST", undefined, enrolled.data.installationCredential);
  const socketD = await wsConnect(wsPath, ticketD.data.ticket);
  assert.equal((await nextMessage(socketD)).payload.generation, 4);
  socketD.send("x".repeat(64 * 1024 + 1));
  assert.equal((await nextMessage(socketD)).payload.code, "MESSAGE_TOO_LARGE");
  await eventually(async () => socketD.readyState !== WebSocket.OPEN);
  const ticketMalformed = await request(ticketPath, "POST", undefined, enrolled.data.installationCredential);
  const socketMalformed = await wsConnect(wsPath, ticketMalformed.data.ticket);
  assert.equal((await nextMessage(socketMalformed)).payload.generation, 5);
  socketMalformed.send("{");
  assert.equal((await nextMessage(socketMalformed)).payload.code, "MALFORMED_MESSAGE");
  await eventually(async () => socketMalformed.readyState !== WebSocket.OPEN);
  const ticketE = await request(ticketPath, "POST", undefined, enrolled.data.installationCredential);
  const socketE = await wsConnect(wsPath, ticketE.data.ticket);
  assert.equal((await nextMessage(socketE)).payload.generation, 6);
  const closedSession = await request(`/v1/teacher/sessions/${id}`, "DELETE", undefined,
    enrolled.data.installationCredential);
  assert.equal(closedSession.status, 204);
  await eventually(async () => socketE.readyState !== WebSocket.OPEN);
  const afterClose = await request(ticketPath, "POST", undefined, enrolled.data.installationCredential);
  assert.equal(afterClose.data.code, "SESSION_CLOSED");
  assert.equal((await request(`/v1/sessions/${id}/bootstrap`)).data.status, "unavailable");

  const revoked = await request(`/v1/operator/installations/${enrolled.data.installationId}/revoke`,
    "POST", undefined, operator);
  assert.equal(revoked.status, 204);
  const rejected = await request("/v1/teacher/sessions", "POST", createBody,
    enrolled.data.installationCredential);
  assert.equal(rejected.status, 403);

  const staticPage = await fetch(new URL(`/join/${id}`, base));
  assert.equal(staticPage.status, 200);
  assert.match(staticPage.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.equal(staticPage.headers.get("x-content-type-options"), "nosniff");
  const apiNotHtml = await fetch(new URL("/v1/unknown", base));
  assert.equal(apiNotHtml.status, 404);
  assert.match(apiNotHtml.headers.get("content-type") ?? "", /application\/json/);
});
