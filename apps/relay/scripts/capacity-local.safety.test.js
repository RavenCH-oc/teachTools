import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

// Exercise the actual preflight / fetch guards, stopping before the Student
// module import or any workload. All process, transport and timer effects are
// injected fakes; no socket, D1, subprocess or real timer is started.
const source = readFileSync(new URL("./capacity-local.js", import.meta.url), "utf8");
const boundary = source.indexOf("const {studentHttpRead}");
assert.ok(boundary > 0, "harness preflight boundary must be recognizable");
const preflight = source.slice(0, boundary).replace(/^import .*;\r?\n/gm, "");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction("path", "randomUUID", "createInterface", "process", "globalThis", "setTimeout", "clearTimeout", "console",
  preflight + "\nreturn { fetch: globalThis.fetch, requestControl, counters };\n");
const target = path.resolve("apps/teacher/src-tauri/target");

async function fixture(overrides = {}) {
  const config = { origin: "http://127.0.0.1:8792/", students: 40,
    outputPath: path.join(target, "synthetic-safety-report.json"), ...overrides };
  const effects = { fetches: [], timers: [], exits: [], stderr: [], logs: [] };
  const fakeProcess = { stdin: {}, stderr: { write: value => effects.stderr.push(value) }, exit: code => effects.exits.push(code) };
  const fakeGlobal = { fetch: async (url, init) => { effects.fetches.push({ url: String(url), init }); return new Response(null, { status: 200 }); } };
  const guards = await execute(path, randomUUID,
    () => ({ on: (_event, handler) => queueMicrotask(() => handler(JSON.stringify(config))) }),
    fakeProcess, fakeGlobal, (callback, ms) => { effects.timers.push({ callback, ms }); return effects.timers.length; },
    () => {}, { log: value => effects.logs.push(value) });
  return { ...guards, effects };
}

for (const origin of ["https://production.invalid/", "http://production.invalid/", "https://127.0.0.1/", "http://127.0.0.1.production.invalid/"]) {
  test("local preflight rejects " + origin, async () => {
    await assert.rejects(fixture({ origin }), /Local-only harness/);
  });
}
for (const students of [0, 41, 1.5, "40"]) {
  test("local preflight rejects invalid student count " + JSON.stringify(students), async () => {
    await assert.rejects(fixture({ students }), /Invalid bounded client count/);
  });
}
test("local preflight permits boundary counts 1 and 40 on loopback only", async () => {
  for (const students of [1, 40]) {
    const f = await fixture({ students, origin: "http://localhost:8792/" });
    assert.equal(f.effects.fetches.length, 0);
  }
});
test("local output cannot traverse outside ignored target or use a sibling prefix", async () => {
  for (const outputPath of [path.join(target, "..", "escape.json"), target + "-sibling/report.json"]) {
    await assert.rejects(fixture({ outputPath }), /Report must stay in ignored target/);
  }
});
test("fetch rejects cross-origin input before transport invocation", async () => {
  const f = await fixture();
  await assert.rejects(f.fetch("https://production.invalid/v1/enroll"), /Cross-origin harness target forbidden/);
  await assert.rejects(f.fetch("http://127.0.0.1:8793/v1/enroll"), /Cross-origin harness target forbidden/);
  assert.equal(f.effects.fetches.length, 0);
});
test("fetch disables redirects even if a caller asks to follow them", async () => {
  const f = await fixture();
  await f.fetch("/v1/local-fixture", { redirect: "follow" });
  assert.equal(f.effects.fetches.length, 1);
  assert.equal(f.effects.fetches[0].init.redirect, "error");
  assert.equal(f.effects.fetches[0].url, "http://127.0.0.1:8792/v1/local-fixture");
});
test("preflight installs a 29 minute hard stop with a nonzero exit", async () => {
  const f = await fixture();
  assert.equal(f.effects.timers.length, 1);
  assert.equal(f.effects.timers[0].ms, 29 * 60 * 1000);
  f.effects.timers[0].callback();
  assert.deepEqual(f.effects.exits, [2]);
});
test("native control wait is bounded to 45 seconds", async () => {
  const f = await fixture();
  const pending = f.requestControl("metrics");
  const rejected = assert.rejects(pending, /Harness control deadline/);
  assert.equal(f.effects.timers.at(-1).ms, 45000);
  f.effects.timers.at(-1).callback();
  await rejected;
});
