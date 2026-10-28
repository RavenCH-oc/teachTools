import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { RunLedger } from "./pass-b-ledger.js";
import { SafetyError } from "./pass-b-safety.js";

const hash = "a".repeat(64);
const sessionId = "S".repeat(32);
const rejectsCode = (action, code) => assert.throws(action, error => error instanceof SafetyError && error.code === code);
function fixture() {
  const runId = randomUUID();
  const writes = [];
  const ledger = new RunLedger(runId, { persist: state => writes.push(state) });
  return { runId, ledger, writes };
}
function activation(ledger) { ledger.begin("activation", hash); ledger.confirmCreated("activation", hash); }
function installation(ledger) {
  activation(ledger);
  const id = randomUUID();
  ledger.begin("installation");
  ledger.confirmCreated("installation", id);
  return id;
}
function session(ledger) {
  const installationId = installation(ledger);
  ledger.begin("session");
  ledger.confirmCreated("session", sessionId);
  return installationId;
}
function clean(ledger, kind, id) { ledger.beginCleanup(kind, id); ledger.confirmCleaned(kind, id); }

test("intent is persisted before effect dispatch; persistence failure forbids the effect", () => {
  const { ledger, writes } = fixture();
  let effects = 0;
  ledger.begin("activation", hash);
  assert.equal(writes[0].resources.activation.state, "INTENT_RECORDED");
  effects += 1;
  ledger.confirmCreated("activation", hash);
  assert.equal(effects, 1);
  assert.equal(writes[1].resources.activation.state, "CONFIRMED_CREATED");
  const broken = new RunLedger(randomUUID(), { persist: () => { throw new Error("storage unavailable"); } });
  assert.throws(() => { broken.begin("activation", hash); effects += 1; });
  assert.equal(effects, 1);
  assert.equal(broken.snapshot().resources.activation.state, "NOT_EXECUTED");
});

test("a second activation, installation or classroom is never created, even after failure", () => {
  const { ledger } = fixture();
  const installationId = session(ledger);
  for (const [kind, id] of [["activation", hash], ["installation", undefined], ["session", undefined]]) {
    rejectsCode(() => ledger.begin(kind, id), "RESOURCE_RETRY_FORBIDDEN");
  }
  rejectsCode(() => ledger.beginCleanup("installation", installationId), "CLOSE_BEFORE_REVOKE_REQUIRED");
});

test("enrollment reply loss records unknown effect, forbids retry and cannot infer installation ownership", () => {
  const { ledger } = fixture();
  activation(ledger);
  ledger.begin("installation");
  ledger.fail("installation", { unknown: true, code: "RESPONSE_LOST" });
  assert.equal(ledger.exactId("installation"), null);
  rejectsCode(() => ledger.begin("installation"), "RUN_STOPPED");
  rejectsCode(() => ledger.begin("session"), "RUN_STOPPED");
  rejectsCode(() => ledger.beginCleanup("installation", randomUUID()), "RESOURCE_OWNERSHIP_MISMATCH");
  clean(ledger, "activation", hash);
  const report = ledger.publicReport({ runnerCompleted: true, workloadPassed: true });
  assert.equal(report.cleanupDisposition, "CLEANUP_INCOMPLETE");
  assert.deepEqual(report.unresolved, ["installation"]);
  assert.equal(report.overall, "FAIL");
});

test("Session create reply loss remains unknown after exact known installation revoke", () => {
  const { ledger } = fixture();
  const installationId = installation(ledger);
  ledger.begin("session");
  ledger.fail("session", { unknown: true, code: "DEADLINE" });
  ledger.cleanupFailed("session", "NO_EXACT_ID");
  clean(ledger, "installation", installationId);
  clean(ledger, "activation", hash);
  const report = ledger.publicReport({ workloadPassed: true, runnerCompleted: true });
  assert.deepEqual(report.unresolved, ["session"]);
  assert.equal(report.resources.session.state, "EFFECT_UNKNOWN");
  assert.equal(report.overall, "FAIL");
});

test("a trustworthy late create confirmation recovers exact cleanup identity but never resumes work", () => {
  const { ledger } = fixture();
  const installationId = installation(ledger);
  ledger.begin("session");
  ledger.fail("session", { unknown: true, code: "RESPONSE_LOST" });
  ledger.confirmCreated("session", sessionId);
  ledger.confirmCreated("session", sessionId); // duplicate confirmation, no second effect
  assert.equal(ledger.exactId("session"), sessionId);
  rejectsCode(() => ledger.begin("credential", ledger.snapshot().runId), "RUN_STOPPED");
  clean(ledger, "session", sessionId);
  clean(ledger, "installation", installationId);
  clean(ledger, "activation", hash);
  const report = ledger.publicReport({ workloadPassed: true, runnerCompleted: true });
  assert.equal(report.cleanupComplete, true);
  assert.equal(report.resources.session.code, "RESPONSE_LOST");
  assert.equal(report.overall, "FAIL");
});

test("known activation hash permits best-effort cleanup but does not settle unknown provisioning", () => {
  const { ledger } = fixture();
  ledger.begin("activation", hash);
  ledger.fail("activation", { unknown: true, code: "RESPONSE_LOST" });
  assert.equal(ledger.exactId("activation"), hash);
  clean(ledger, "activation", hash);
  assert.equal(ledger.publicReport().cleanupComplete, false);
  assert.deepEqual(ledger.publicReport().unresolved, ["activation"]);
  assert.equal(ledger.publicReport().resources.activation.cleanup, "EFFECT_UNKNOWN");
  assert.equal(ledger.publicReport().resources.activation.cleanupCode, "CREATE_OUTCOME_UNKNOWN");
  assert.equal(ledger.publicReport().overall, "FAIL");
  assert.equal(ledger.publicReport({ workloadPassed: true, runnerCompleted: true }).overall, "FAIL");
});

test("confirmed activation creation before cleanup permits exact cleanup without erasing the original failure", () => {
  const { ledger } = fixture();
  ledger.begin("activation", hash);
  ledger.fail("activation", { unknown: true, code: "RESPONSE_LOST" });
  ledger.confirmCreated("activation", hash);
  clean(ledger, "activation", hash);
  const report = ledger.publicReport({ workloadPassed: true, runnerCompleted: true });
  assert.equal(report.cleanupComplete, true);
  assert.equal(report.resources.activation.cleanup, "CONFIRMED_CLEANED");
  assert.equal(report.resources.activation.code, "RESPONSE_LOST");
  assert.equal(report.overall, "FAIL");
});

test("activation confirmation after cleanup dispatch cannot clear the uncertain operation ordering", () => {
  const { ledger, writes } = fixture();
  ledger.begin("activation", hash);
  ledger.fail("activation", { unknown: true, code: "DEADLINE" });
  ledger.beginCleanup("activation", hash);
  assert.equal(writes.at(-1).resources.activation.cleanupCode, "CREATE_OUTCOME_UNKNOWN");
  ledger.confirmCreated("activation", hash);
  ledger.confirmCleaned("activation", hash);
  const report = ledger.publicReport();
  assert.equal(report.cleanupComplete, false);
  assert.equal(report.resources.activation.state, "CONFIRMED_CREATED");
  assert.equal(report.resources.activation.cleanup, "EFFECT_UNKNOWN");
  rejectsCode(() => ledger.beginCleanup("activation", hash), "CLEANUP_RETRY_FORBIDDEN");
  assert.equal(RunLedger.recover(ledger.snapshot()).publicReport().cleanupComplete, false);
});

test("recovery retains unknown activation from an older snapshot that marked cleanup confirmed", () => {
  const { ledger } = fixture();
  ledger.begin("activation", hash);
  ledger.fail("activation", { unknown: true, code: "RESPONSE_LOST" });
  const snapshot = ledger.snapshot();
  snapshot.resources.activation.cleanup = "CONFIRMED_CLEANED";
  const recovered = RunLedger.recover(snapshot);
  assert.equal(recovered.publicReport().cleanupComplete, false);
  assert.deepEqual(recovered.publicReport().unresolved, ["activation"]);
  assert.equal(recovered.publicReport().resources.activation.cleanup, "EFFECT_UNKNOWN");
  assert.equal(recovered.publicReport().resources.activation.cleanupCode, "CREATE_OUTCOME_UNKNOWN");
  assert.equal(recovered.publicReport().overall, "FAIL");
});

test("a known create failure cannot be hidden by successful workload flags", () => {
  const { ledger } = fixture();
  ledger.begin("activation", hash);
  ledger.fail("activation", { code: "OPERATION_FAILED" });
  const report = ledger.publicReport({ workloadPassed: true, runnerCompleted: true });
  assert.equal(report.cleanupComplete, true);
  assert.equal(report.overall, "FAIL");
});

test("close intent and confirmation precede installation cleanup", () => {
  const { ledger, writes } = fixture();
  const installationId = session(ledger);
  rejectsCode(() => ledger.beginCleanup("installation", installationId), "CLOSE_BEFORE_REVOKE_REQUIRED");
  ledger.beginCleanup("session", sessionId);
  rejectsCode(() => ledger.beginCleanup("installation", installationId), "CLOSE_BEFORE_REVOKE_REQUIRED");
  ledger.confirmCleaned("session", sessionId);
  clean(ledger, "installation", installationId);
  clean(ledger, "activation", hash);
  const closeComplete = writes.findIndex(state => state.resources.session.cleanup === "CONFIRMED_CLEANED");
  const revokeIntent = writes.findIndex(state => state.resources.installation.cleanup === "INTENT_RECORDED");
  assert.ok(closeComplete < revokeIntent);
  assert.equal(ledger.publicReport({ workloadPassed: true, runnerCompleted: true }).overall, "PASS");
});

test("close failure permits later exact revoke but never turns into complete cleanup", () => {
  const { ledger } = fixture();
  const installationId = session(ledger);
  ledger.beginCleanup("session", sessionId);
  ledger.cleanupFailed("session", "CLEANUP_FAILED");
  clean(ledger, "installation", installationId);
  clean(ledger, "activation", hash);
  const report = ledger.publicReport({ workloadPassed: true, runnerCompleted: true });
  assert.equal(report.overall, "FAIL");
  assert.equal(report.cleanupDisposition, "CLEANUP_INCOMPLETE");
  assert.deepEqual(report.unresolved, ["session"]);
});

test("cleanup exact IDs cannot be changed or guessed; no catch-all resource action exists", () => {
  const { ledger } = fixture();
  session(ledger);
  rejectsCode(() => ledger.beginCleanup("session", "X".repeat(32)), "RESOURCE_OWNERSHIP_MISMATCH");
  rejectsCode(() => ledger.beginCleanup("installation", randomUUID()), "RESOURCE_OWNERSHIP_MISMATCH");
  rejectsCode(() => ledger.beginCleanup("all-active-installations", "all"), "INVALID_RESOURCE_KIND");
  rejectsCode(() => ledger.confirmCleaned("session", sessionId), "NO_PENDING_CLEANUP");
});

test("credential cleanup failure makes successful workload non-PASS and preserves isolation identity", () => {
  const { runId, ledger } = fixture();
  rejectsCode(() => ledger.begin("credential", "Classroom.RemoteInstallation"), "INVALID_RESOURCE_ID");
  ledger.begin("credential", runId);
  ledger.confirmCreated("credential", runId);
  ledger.beginCleanup("credential", runId);
  ledger.cleanupFailed("credential", "CLEANUP_FAILED");
  const report = ledger.publicReport({ runnerCompleted: true, workloadPassed: true });
  assert.equal(report.overall, "FAIL");
  assert.deepEqual(report.unresolved, ["credential"]);
});

test("owned child group and temporary data cleanup do not clear an unknown Session", () => {
  const { runId, ledger } = fixture();
  for (const kind of ["child", "temporaryData"]) { ledger.begin(kind, runId); ledger.confirmCreated(kind, runId); }
  installation(ledger);
  ledger.begin("session");
  ledger.fail("session", { unknown: true, code: "CHILD_CRASH" });
  for (const kind of ["child", "temporaryData"]) clean(ledger, kind, runId);
  assert.equal(ledger.publicReport().resources.session.state, "EFFECT_UNKNOWN");
  assert.ok(ledger.publicReport().unresolved.includes("session"));
});

test("public projection excludes exact operational IDs and rejects secret-bearing fields/codes", () => {
  const { ledger } = fixture();
  const installationId = session(ledger);
  const serialized = JSON.stringify(ledger.publicReport());
  for (const id of [hash, installationId, sessionId]) assert.equal(serialized.includes(id), false);
  assert.equal("credentials" in ledger.snapshot(), false);
  rejectsCode(() => ledger.cleanupFailed("session", "raw exception with credential"), "INVALID_LEDGER_ERROR_CODE");
  const malicious = ledger.snapshot();
  malicious.credential = "should never be persisted";
  rejectsCode(() => RunLedger.recover(malicious), "INVALID_LEDGER_SNAPSHOT");
});

test("crash recovery converts unfinished intents to unknown and never resumes provisioning", () => {
  const { ledger } = fixture();
  installation(ledger);
  ledger.begin("session");
  const recovered = RunLedger.recover(ledger.snapshot());
  assert.equal(recovered.snapshot().resources.session.state, "EFFECT_UNKNOWN");
  rejectsCode(() => recovered.begin("session"), "RUN_STOPPED");
  assert.equal(recovered.publicReport({ workloadPassed: true, runnerCompleted: true }).overall, "FAIL");
});

test("crash during cleanup cannot mark resource removed without confirmation", () => {
  const { ledger } = fixture();
  activation(ledger);
  ledger.beginCleanup("activation", hash);
  const recovered = RunLedger.recover(ledger.snapshot());
  assert.equal(recovered.snapshot().resources.activation.cleanup, "EFFECT_UNKNOWN");
  assert.equal(recovered.publicReport().cleanupComplete, false);
  rejectsCode(() => recovered.confirmCleaned("activation", hash), "NO_PENDING_CLEANUP");
});

test("snapshots and persistence callback cannot mutate ledger authority", () => {
  const { ledger, writes } = fixture();
  activation(ledger);
  writes[0].resources.activation.id = "b".repeat(64);
  const snapshot = ledger.snapshot();
  snapshot.resources.activation.id = "c".repeat(64);
  assert.equal(ledger.exactId("activation"), hash);
});
