// Import-safe helpers for the bounded Pass B runner. No transport or subprocess starts here.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export const CANONICAL_ORIGIN = "https://classroom-relay.ryanaddy1102.workers.dev/";
export const LOOPBACK_ORIGIN = "http://127.0.0.1:8794/";
export const LIMITS = Object.freeze({ students: 30, teachers: 1, classrooms: 1,
  rawBytes: 1024 * 1024 * 1024, teacherUtf8Bytes: 2 * 1024 * 1024 * 1024,
  wallMs: 30 * 60 * 1000, cleanupMs: 2 * 60 * 1000 });
export const IMAGE_STAGES = Object.freeze([1, 4, 5, 10, 20, 30]);
export const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class SafetyError extends Error {
  constructor(code) { super(code); this.name = "SafetyError"; this.code = code; }
}
function reject(code) { throw new SafetyError(code); }
export function validateRunId(value) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) reject("INVALID_RUN_ID");
  return value;
}
function onlyKeys(value, allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !allowed.includes(key))) reject("UNKNOWN_CONFIGURATION");
}
export function imageStages(students = LIMITS.students) {
  if (!Number.isInteger(students) || students < 1 || students > LIMITS.students) reject("INVALID_STUDENT_COUNT");
  return [...new Set([...IMAGE_STAGES.filter(count => count <= students), students])];
}

// A valid profile is data, never an authorization token. The supervisor has a
// separate execute-production entry and checks its operator authorization.
export function validateProfile(input = {}) {
  onlyKeys(input, ["mode", "runId", "students", "teachers", "classrooms", "origin"]);
  const mode = input.mode ?? "plan";
  if (!["plan", "production", "loopback"].includes(mode)) reject("INVALID_MODE");
  const origin = mode === "loopback" ? LOOPBACK_ORIGIN : CANONICAL_ORIGIN;
  if (input.origin !== undefined && input.origin !== origin) reject("NON_CANONICAL_TARGET");
  const students = input.students ?? LIMITS.students;
  const stages = imageStages(students);
  if ((input.teachers ?? 1) !== 1 || (input.classrooms ?? 1) !== 1) reject("INVALID_PILOT_SCOPE");
  const runId = validateRunId(mode === "production" ? input.runId : input.runId ?? randomUUID());
  return Object.freeze({ mode, origin, runId, students, teachers: 1, classrooms: 1,
    stages: Object.freeze(stages), rawBytes: LIMITS.rawBytes,
    teacherUtf8Bytes: LIMITS.teacherUtf8Bytes, wallMs: LIMITS.wallMs, cleanupMs: LIMITS.cleanupMs });
}

function profileOrigin(profile) {
  const expected = profile?.mode === "loopback" ? LOOPBACK_ORIGIN : CANONICAL_ORIGIN;
  if (!profile || !["plan", "production", "loopback"].includes(profile.mode)
    || profile.origin !== expected) reject("INVALID_PROFILE");
  return expected;
}
export function assertNativeTarget(profile, effectiveUrl) {
  if (typeof effectiveUrl !== "string" || effectiveUrl !== profileOrigin(profile)) reject("NATIVE_TARGET_MISMATCH");
  return effectiveUrl;
}

function targetUrl(profile, input, websocket) {
  const configured = profileOrigin(profile);
  if (!(typeof input === "string" || input instanceof URL)) reject("INVALID_DESTINATION");
  const raw = String(input);
  if (/[\u0000-\u0020\\]/.test(raw)) reject("INVALID_DESTINATION");
  let result;
  try { result = new URL(raw, configured); } catch { reject("INVALID_DESTINATION"); }
  const expected = new URL(configured);
  if (websocket) expected.protocol = expected.protocol === "https:" ? "wss:" : "ws:";
  if (result.origin !== expected.origin || result.username || result.password || result.hash
    || (websocket && result.search)) reject("CROSS_ORIGIN_DESTINATION");
  if ([...result.searchParams.keys()].some(key => /^(credential|token|activationcode|authorization|ticket)$/i.test(key))) reject("SECRET_QUERY_FORBIDDEN");
  return result;
}
export function guardHttpTarget(profile, input) { return targetUrl(profile, input, false); }
export function guardWebSocketTarget(profile, input) { return targetUrl(profile, input, true); }

// Lexical containment alone permits junction escapes. Reject links at every
// existing component and also compare each real path with the trusted root.
// Call again immediately before writes/import/spawn; this is a trusted-operator
// workspace guard, not an OS sandbox against concurrent hostile path changes.
export function assertContainedPath(root, candidate, { mustExist = false, kind } = {}) {
  if (typeof root !== "string" || typeof candidate !== "string" || !root || !candidate
    || /[\u0000-\u001f]/.test(candidate) || /^\\\\[?.]/.test(candidate)) reject("INVALID_PATH");
  const base = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)
    || relative.split(path.sep).some(part => part.includes(":"))) reject("PATH_ESCAPE");
  let baseStat;
  try { baseStat = fs.lstatSync(base); } catch { reject("MISSING_CONTROLLED_ROOT"); }
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) reject("UNSAFE_CONTROLLED_ROOT");
  // A nested directory below a junction is not itself a symbolic link. Check
  // the trusted root's ancestors too, otherwise the whole sandbox can move.
  let ancestor = path.parse(base).root;
  for (const part of base.slice(ancestor.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    if (fs.lstatSync(ancestor).isSymbolicLink()) reject("UNSAFE_CONTROLLED_ROOT");
  }
  const realBase = fs.realpathSync(base);
  let component = base;
  let missing = false;
  for (const part of relative.split(path.sep)) {
    component = path.join(component, part);
    if (missing) continue;
    let stat;
    try { stat = fs.lstatSync(component); } catch (error) {
      if (error.code === "ENOENT") { missing = true; continue; }
      reject("PATH_INSPECTION_FAILED");
    }
    if (stat.isSymbolicLink()) reject("LINK_PATH_FORBIDDEN");
    const realRelative = path.relative(realBase, fs.realpathSync(component));
    if (!realRelative || realRelative === ".." || realRelative.startsWith(".." + path.sep)
      || path.isAbsolute(realRelative)) reject("REALPATH_ESCAPE");
    if (component !== resolved && !stat.isDirectory()) reject("NON_DIRECTORY_PARENT");
  }
  if (mustExist && missing) reject("MISSING_REQUIRED_PATH");
  if (!missing && kind) {
    const stat = fs.lstatSync(resolved);
    if ((kind === "file" && !stat.isFile()) || (kind === "directory" && !stat.isDirectory())
      || !["file", "directory"].includes(kind)) reject("INVALID_PATH_KIND");
  }
  return resolved;
}

export function verifyFileIdentity(root, identity) {
  onlyKeys(identity, ["path", "sha256"]);
  if (!SHA256_PATTERN.test(identity.sha256 ?? "")) reject("INVALID_SHA256");
  const resolved = assertContainedPath(root, identity.path, { mustExist: true, kind: "file" });
  const actual = createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
  if (actual !== identity.sha256) reject("FILE_IDENTITY_MISMATCH");
  return Object.freeze({ path: resolved, sha256: actual });
}

export function sourceSnapshot(root, files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > 512
    || files.some(file => typeof file !== "string") || new Set(files).size !== files.length) reject("INVALID_SOURCE_LIST");
  const records = files.map(file => {
    const resolved = assertContainedPath(root, path.resolve(root, file), { mustExist: true, kind: "file" });
    return { file: path.relative(root, resolved).split(path.sep).join("/"),
      sha256: createHash("sha256").update(fs.readFileSync(resolved)).digest("hex") };
  }).sort((left, right) => left.file < right.file ? -1 : left.file > right.file ? 1 : 0);
  return { records, sha256: createHash("sha256").update(JSON.stringify(records), "utf8").digest("hex") };
}

// Instantiate before setup/provision starts. No reset API exists. Smaller
// limits are allowed for isolated tests, never larger than the fixed profile.
export function createDeadline({ totalMs = LIMITS.wallMs, cleanupMs = LIMITS.cleanupMs,
  now = () => performance.now() } = {}) {
  if (!Number.isFinite(totalMs) || totalMs <= 0 || totalMs > LIMITS.wallMs
    || !Number.isFinite(cleanupMs) || cleanupMs <= 0 || cleanupMs >= totalMs) reject("INVALID_DEADLINE");
  const began = now();
  if (!Number.isFinite(began)) reject("INVALID_CLOCK");
  let last = began;
  const elapsedMs = () => {
    const current = now();
    if (!Number.isFinite(current) || current < last) reject("INVALID_CLOCK");
    last = current;
    return current - began;
  };
  const remainingMs = ({ cleanup = false } = {}) => Math.max(0, totalMs - elapsedMs() - (cleanup ? 0 : cleanupMs));
  const boundedMs = (maximum, options) => {
    if (!Number.isFinite(maximum) || maximum <= 0) reject("INVALID_WAIT_BOUND");
    const remaining = remainingMs(options);
    if (remaining <= 0) reject(options?.cleanup ? "CLEANUP_DEADLINE" : "WORK_DEADLINE");
    return Math.max(1, Math.floor(Math.min(maximum, remaining)));
  };
  return Object.freeze({ elapsedMs, remainingMs, boundedMs,
    assertWork: () => boundedMs(LIMITS.wallMs), totalMs, cleanupMs });
}
