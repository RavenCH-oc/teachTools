import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { CANONICAL_ORIGIN, LOOPBACK_ORIGIN, LIMITS, SafetyError, validateProfile, imageStages,
  assertNativeTarget, guardHttpTarget, guardWebSocketTarget, assertContainedPath,
  verifyFileIdentity, sourceSnapshot, createDeadline } from "./pass-b-safety.js";

const rejectsCode = (action, code) => assert.throws(action, error => error instanceof SafetyError && error.code === code);
function fixture(t) {
  const root = path.resolve("apps/teacher/src-tauri/target/phase16f-pass-b-safety", randomUUID());
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("default validation is a plan, with fixed scope and an explicit 30-reader endpoint", () => {
  const profile = validateProfile();
  assert.equal(profile.mode, "plan");
  assert.equal(profile.origin, CANONICAL_ORIGIN);
  assert.equal(profile.students, 30);
  assert.deepEqual(profile.stages, [1, 4, 5, 10, 20, 30]);
  assert.equal(profile.teachers, 1);
  assert.equal(profile.classrooms, 1);
  assert.equal(profile.rawBytes, 1024 ** 3);
  assert.equal(profile.teacherUtf8Bytes, 2 * 1024 ** 3);
  assert.ok(Object.isFrozen(profile));
  assert.ok(Object.isFrozen(profile.stages));
});

test("import and default plan call no fetch or spawn even if adapters would fail", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = () => { fetched = true; throw new Error("transport forbidden"); };
  try {
    const module = await import("./pass-b-safety.js?import-proof=" + randomUUID());
    module.validateProfile();
    assert.equal(fetched, false);
    const source = fs.readFileSync(new URL("./pass-b-safety.js", import.meta.url), "utf8");
    assert.equal(/child_process|\bspawn\(/.test(source), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("unknown modes, limits and scope overrides fail closed", () => {
  for (const input of [{ students: 31 }, { students: 0 }, { students: 1.5 }, { students: "30" },
    { students: NaN }, { students: Infinity }]) rejectsCode(() => validateProfile(input), "INVALID_STUDENT_COUNT");
  for (const input of [{ teachers: 2 }, { classrooms: 2 }, { teachers: "1" }, { classrooms: NaN }]) {
    rejectsCode(() => validateProfile(input), "INVALID_PILOT_SCOPE");
  }
  rejectsCode(() => validateProfile({ mode: "soak" }), "INVALID_MODE");
  for (const key of ["rawBytes", "teacherUtf8Bytes", "wallMs", "cleanupMs", "maxStudents", "url", "env", "extra"]) {
    rejectsCode(() => validateProfile({ [key]: LIMITS.wallMs * 2 }), "UNKNOWN_CONFIGURATION");
  }
  rejectsCode(() => validateProfile({ runId: "../../escape" }), "INVALID_RUN_ID");
});

test("explicit smaller profiles retain all configured readers without adding sockets during ACTIVE", () => {
  assert.deepEqual(imageStages(1), [1]);
  assert.deepEqual(imageStages(2), [1, 2]);
  assert.deepEqual(imageStages(5), [1, 4, 5]);
  assert.deepEqual(imageStages(21), [1, 4, 5, 10, 20, 21]);
  assert.deepEqual(imageStages(30), [1, 4, 5, 10, 20, 30]);
});

test("production target rejects URL normalization, userinfo, non-root paths and alternate origins", () => {
  for (const origin of ["https://production.invalid/", "http://classroom-relay.ryanaddy1102.workers.dev/",
    CANONICAL_ORIGIN + "?x=1", CANONICAL_ORIGIN + "#fragment", CANONICAL_ORIGIN + "v1/",
    CANONICAL_ORIGIN + "..", CANONICAL_ORIGIN.replace("https://", "https://user@"),
    CANONICAL_ORIGIN.replace(".dev/", ".dev:443/"), CANONICAL_ORIGIN.replace(".dev/", ".dev:8443/"),
    " " + CANONICAL_ORIGIN, CANONICAL_ORIGIN.slice(0, -1), LOOPBACK_ORIGIN]) {
    rejectsCode(() => validateProfile({ mode: "production", origin }), "NON_CANONICAL_TARGET");
  }
});

test("loopback mode only accepts its fixed address and effective native URL must match", () => {
  const profile = validateProfile({ mode: "loopback", origin: LOOPBACK_ORIGIN });
  assertNativeTarget(profile, LOOPBACK_ORIGIN);
  for (const origin of [CANONICAL_ORIGIN, "http://localhost:8794/", "http://127.0.0.1:8793/", "http://127.0.0.1:8794/?x=1"]) {
    rejectsCode(() => validateProfile({ mode: "loopback", origin }), "NON_CANONICAL_TARGET");
    rejectsCode(() => assertNativeTarget(profile, origin), "NATIVE_TARGET_MISMATCH");
  }
});

test("HTTP and WS effective destinations share the approved origin, allowing typed HTTP query args", () => {
  const profile = validateProfile({ mode: "production" });
  const pathName = "/v1/sessions/" + "s".repeat(32) + "/http/SESSION_ASSET_GET?assetId=" + randomUUID();
  assert.equal(guardHttpTarget(profile, pathName).origin, new URL(CANONICAL_ORIGIN).origin);
  assert.equal(guardWebSocketTarget(profile, CANONICAL_ORIGIN.replace("https:", "wss:") + "v1/sessions/" + "s".repeat(32) + "/ws").protocol, "wss:");
  for (const destination of ["https://other.invalid/path", "//other.invalid/path", "http://classroom-relay.ryanaddy1102.workers.dev/path",
    CANONICAL_ORIGIN.replace("https://", "https://user@"), CANONICAL_ORIGIN + "#fragment"]) {
    rejectsCode(() => guardHttpTarget(profile, destination), "CROSS_ORIGIN_DESTINATION");
  }
  rejectsCode(() => guardHttpTarget(profile, "https:\\other.invalid"), "INVALID_DESTINATION");
  rejectsCode(() => guardHttpTarget(profile, CANONICAL_ORIGIN + "v1/enroll?activationCode=secret"), "SECRET_QUERY_FORBIDDEN");
  rejectsCode(() => guardWebSocketTarget(profile, CANONICAL_ORIGIN + "v1/sessions/x/ws"), "CROSS_ORIGIN_DESTINATION");
  rejectsCode(() => guardWebSocketTarget(profile, CANONICAL_ORIGIN.replace("https:", "wss:") + "ws?credential=bad"), "CROSS_ORIGIN_DESTINATION");
});

test("output/module paths reject traversal, sibling prefixes, root itself and alternate streams", t => {
  const root = fixture(t);
  const good = path.join(root, "outputs", "report.json");
  assert.equal(assertContainedPath(root, good), good);
  for (const candidate of [path.join(root, "..", "escape.json"), root + "-sibling/out.json", root,
    path.join(root, "out.json:stream")]) rejectsCode(() => assertContainedPath(root, candidate), "PATH_ESCAPE");
  rejectsCode(() => assertContainedPath(root, good, { mustExist: true }), "MISSING_REQUIRED_PATH");
});

test("realpath containment rejects directory junctions before import or output creation", t => {
  const root = fixture(t);
  const outside = path.join(root, "outside");
  const controlled = path.join(root, "controlled");
  fs.mkdirSync(outside);
  fs.mkdirSync(controlled);
  fs.writeFileSync(path.join(outside, "module.mjs"), "export const value = 1;");
  const link = path.join(controlled, "link");
  fs.symlinkSync(outside, link, "junction");
  rejectsCode(() => assertContainedPath(controlled, path.join(link, "module.mjs"), { mustExist: true }), "LINK_PATH_FORBIDDEN");
  rejectsCode(() => assertContainedPath(controlled, path.join(link, "new-report.json")), "LINK_PATH_FORBIDDEN");
  fs.mkdirSync(path.join(outside, "nested"));
  rejectsCode(() => assertContainedPath(path.join(link, "nested"), path.join(link, "nested", "report.json")), "UNSAFE_CONTROLLED_ROOT");
});

test("native, bundle and fixture file identities fail before any adapter can consume changed bytes", t => {
  const root = fixture(t);
  for (const name of ["native.exe", "student.mjs", "image.png"]) {
    const file = path.join(root, name);
    fs.writeFileSync(file, name);
    const sha256 = createHash("sha256").update(name).digest("hex");
    assert.equal(verifyFileIdentity(root, { path: file, sha256 }).sha256, sha256);
    fs.appendFileSync(file, "changed");
    rejectsCode(() => verifyFileIdentity(root, { path: file, sha256 }), "FILE_IDENTITY_MISMATCH");
  }
});

test("source snapshot is deterministic, exact-byte and refuses escaping or duplicate files", t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "a.js"), "a\r\n");
  fs.writeFileSync(path.join(root, "b.js"), "b\n");
  const first = sourceSnapshot(root, ["b.js", "a.js"]);
  assert.deepEqual(first, sourceSnapshot(root, ["a.js", "b.js"]));
  fs.writeFileSync(path.join(root, "a.js"), "a\n");
  assert.notEqual(sourceSnapshot(root, ["a.js", "b.js"]).sha256, first.sha256);
  rejectsCode(() => sourceSnapshot(root, ["../outside.js"]), "PATH_ESCAPE");
  rejectsCode(() => sourceSnapshot(root, ["a.js", "a.js"]), "INVALID_SOURCE_LIST");
});

test("setup consumes the same monotonic deadline and cleanup reserve cannot extend the run", () => {
  let now = 200;
  const deadline = createDeadline({ totalMs: 1000, cleanupMs: 100, now: () => now });
  assert.equal(deadline.remainingMs(), 900);
  now += 600; // setup has already used 600 ms before enrollment begins
  assert.equal(deadline.boundedMs(500), 300);
  now += 300;
  rejectsCode(() => deadline.assertWork(), "WORK_DEADLINE");
  assert.equal(deadline.boundedMs(500, { cleanup: true }), 100);
  now += 100;
  rejectsCode(() => deadline.boundedMs(20, { cleanup: true }), "CLEANUP_DEADLINE");
  assert.equal("reset" in deadline, false);
});

test("non-finite durations, clock reversal and expanded wall budget are rejected", () => {
  for (const totalMs of [NaN, Infinity, -1, 0, LIMITS.wallMs + 1]) {
    rejectsCode(() => createDeadline({ totalMs }), "INVALID_DEADLINE");
  }
  rejectsCode(() => createDeadline({ totalMs: 100, cleanupMs: 100 }), "INVALID_DEADLINE");
  rejectsCode(() => createDeadline({ totalMs: 100, cleanupMs: 0 }), "INVALID_DEADLINE");
  let now = 10;
  const deadline = createDeadline({ now: () => now });
  now = 9;
  rejectsCode(() => deadline.remainingMs(), "INVALID_CLOCK");
});
