import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const relayDir = new URL("..", import.meta.url).pathname.replace(/^\/(.)\:/, "$1:");
const wrangler = join(relayDir, "node_modules", "wrangler", "bin", "wrangler.js");
const operator = /^OPERATOR_TOKEN=(.+)$/m.exec(readFileSync(join(relayDir, ".dev.vars"), "utf8"))?.[1];
assert.ok(operator, "Local operator token is required");
const base = "http://127.0.0.1:8788";
const temp = mkdtempSync(join(tmpdir(), "classroom-relay-restart-"));
assert.equal(dirname(realpathSync(temp)), realpathSync(tmpdir()));

function runWrangler(args) {
  execFileSync(process.execPath, [wrangler, ...args, "--persist-to", temp],
    { cwd: relayDir, stdio: "ignore", timeout: 30000 });
}

async function ready() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${base}/v1/unknown`);
      if (response.status === 404) return;
    } catch { /* startup in progress */ }
    await delay(100);
  }
  throw new Error("Local Wrangler did not start");
}

function start() {
  return spawn(process.execPath, [wrangler, "dev", "--port", "8788", "--persist-to", temp],
    { cwd: relayDir, stdio: "ignore" });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => child.once("exit", resolve));
}

async function post(path, body, token) {
  const response = await fetch(`${base}${path}`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body) });
  assert.ok(response.ok, `request failed: ${path} (${response.status})`);
  return response.json();
}

async function connect(id, ticket) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:8788/v1/teacher/sessions/${id}/ws`,
      { headers: { authorization: `Bearer ${ticket}` } });
    socket.once("message", (raw) => resolve({ socket, attached: JSON.parse(raw.toString()) }));
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume(); reject(new Error(`WebSocket rejected: ${response.statusCode}`));
    });
  });
}

runWrangler(["d1", "migrations", "apply", "INSTALLATIONS", "--local"]);
let child = start();
try {
  await ready();
  const { activationCode } = await post("/v1/operator/activation-codes", {}, operator);
  const installation = await post("/v1/enroll", { activationCode }, "");
  const created = await post("/v1/teacher/sessions",
    { teacherAppVersion: "0.1.0", remoteProtocolVersion: 1 }, installation.installationCredential);
  const { ticket } = await post(`/v1/teacher/sessions/${created.remoteSessionId}/tickets`,
    {}, installation.installationCredential);
  await stop(child);
  child = start();
  await ready();
  const { socket, attached } = await connect(created.remoteSessionId, ticket);
  assert.equal(attached.payload.generation, 1);
  socket.terminate();
  let offline = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${base}/v1/sessions/${created.remoteSessionId}/bootstrap`);
    const bootstrap = await response.json();
    if (bootstrap.status === "unavailable") { offline = true; break; }
    await delay(100);
  }
  assert.ok(offline, "Teacher disconnect must persist TEACHER_OFFLINE state");
  const { ticket: reconnectTicket } = await post(
    `/v1/teacher/sessions/${created.remoteSessionId}/tickets`, {}, installation.installationCredential);
  await stop(child);
  child = start();
  await ready();
  const { socket: reconnected, attached: secondAttach } = await connect(
    created.remoteSessionId, reconnectTicket);
  assert.equal(secondAttach.payload.generation, 2);
  reconnected.terminate();
  console.log("Durable Object persisted ticket, offline state, and generation across restarts: PASS");
} finally {
  await stop(child);
  assert.equal(dirname(realpathSync(temp)), realpathSync(tmpdir()));
  await delay(500);
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  } catch {
    console.warn("Temporary local Wrangler state could not be removed yet.");
  }
}
