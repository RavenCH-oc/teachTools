import assert from "node:assert/strict";
import test from "node:test";
import { disconnectTeacher, ensureTeacherDeadline, expireRelay, expireTeacher, invalidateStudents } from "./lifecycle.js";

test("relay expiry clears pending tickets and cannot reopen closed sessions", () => {
  const meta = { status: "TEACHER_OFFLINE", expiresAt: 1000,
    teacherGeneration: 7, ticketHash: "hash", ticketExpiresAt: 900 };
  assert.equal(expireRelay(meta, 999), meta);
  const expired = expireRelay(meta, 1000);
  assert.equal(expired.status, "EXPIRED");
  assert.equal(expired.ticketHash, null);
  assert.equal(expired.ticketExpiresAt, null);
  assert.equal(expired.teacherGeneration, 7);
  assert.equal(expireRelay(expired, 2000), expired);
  const closed = { ...meta, status: "CLOSED" };
  assert.equal(expireRelay(closed, 2000), closed);
});

test("F4 stale Teacher close/error cannot invalidate the replacement generation", () => {
  const meta = { status: "OPEN", teacherGeneration: 8, teacherHeartbeatDeadline: 61000 };
  assert.equal(disconnectTeacher(meta, { role: "teacher", generation: 7 }), meta);
  assert.equal(disconnectTeacher(meta, { role: "student", generation: 8 }), meta);
  assert.deepEqual(disconnectTeacher(meta, { role: "teacher", generation: 8 }),
    { status: "TEACHER_OFFLINE", teacherGeneration: 8, teacherHeartbeatDeadline: null });
});

test("Teacher silent-loss deadline survives hibernation and never expires a refreshed generation early", () => {
  const meta = { status: "OPEN", teacherGeneration: 7, teacherHeartbeatDeadline: 61000 };
  assert.equal(expireTeacher(meta, 60999), meta);
  assert.deepEqual(expireTeacher(meta, 61000),
    { status: "TEACHER_OFFLINE", teacherGeneration: 7, teacherHeartbeatDeadline: null });
  const replacement = { status: "OPEN", teacherGeneration: 8, teacherHeartbeatDeadline: 121000 };
  assert.equal(expireTeacher(replacement, 61000), replacement);
  assert.equal(expireTeacher({ ...meta, status: "CLOSED" }, 70000).status, "CLOSED");
});

test("upgrade seeds a missing OPEN Teacher deadline once without extending it on subsequent wakes", () => {
  const legacy = { status: "OPEN", teacherGeneration: 7 };
  const upgraded = ensureTeacherDeadline(legacy, 1000, 60000);
  assert.deepEqual(upgraded, { status: "OPEN", teacherGeneration: 7, teacherHeartbeatDeadline: 61000 });
  assert.equal(ensureTeacherDeadline(upgraded, 50000, 60000), upgraded);
  assert.equal(expireTeacher(upgraded, 61000).status, "TEACHER_OFFLINE");
  const offline = { status: "TEACHER_OFFLINE", teacherGeneration: 7 };
  assert.equal(ensureTeacherDeadline(offline, 1000, 60000), offline);
});

test("F2 offline and F3 re-auth broadcasts reach every healthy idle Student despite a failed recipient", () => {
  const messages = [];
  const broken = { deserializeAttachment: () => ({ connectionId: "broken" }),
    serializeAttachment: () => {}, send: () => { throw new Error("closed recipient"); },
    close: () => { throw new Error("already closed"); } };
  let healthyAttachment = { connectionId: "healthy", authState: "AUTHENTICATED", generation: 7 };
  const healthy = { deserializeAttachment: () => healthyAttachment,
    serializeAttachment: (next) => { healthyAttachment = next; },
    send: (raw) => messages.push(JSON.parse(raw)) };
  const ctx = { getWebSockets: () => [broken, healthy] };
  invalidateStudents(ctx, { status: "TEACHER_OFFLINE", teacherGeneration: 7 }, 1000);
  assert.deepEqual(messages[0].payload, { op: "teacher_offline", generation: 7 });
  assert.equal(healthyAttachment.authState, "TEACHER_OFFLINE");
  assert.equal(healthyAttachment.authDeadline, null);
  invalidateStudents(ctx, { status: "OPEN", teacherGeneration: 8 }, 2000);
  assert.deepEqual(messages[1].payload, { op: "REAUTH_REQUIRED", generation: 8 });
  assert.equal(healthyAttachment.authState, "UNAUTHENTICATED");
  assert.equal(healthyAttachment.authDeadline, 7000);
});

test("hibernation wake invalidates same-generation auth without retaining credentials or domain attachments", () => {
  let attachment = { role: "student", connectionId: "00000000-0000-4000-8000-000000000003",
    generation: 7, authState: "AUTHENTICATED", authDeadline: null, authRequestId: null,
    credential: "must-not-survive", question: { answer: "must-not-survive" } };
  const messages = [];
  const socket = { deserializeAttachment: () => attachment,
    serializeAttachment: (next) => { attachment = next; }, send: (raw) => messages.push(JSON.parse(raw)) };
  const ctx = { getWebSockets: (tag) => { assert.equal(tag, "student"); return [socket]; } };
  assert.equal(invalidateStudents(ctx, { status: "OPEN", teacherGeneration: 7 }, 1000), 1);
  assert.deepEqual(attachment, { role: "student", connectionId: "00000000-0000-4000-8000-000000000003",
    generation: 7, authState: "UNAUTHENTICATED", authDeadline: 6000, authRequestId: null });
  assert.deepEqual(messages[0].payload, { op: "REAUTH_REQUIRED", generation: 7 });
  invalidateStudents(ctx, { status: "TEACHER_OFFLINE", teacherGeneration: 7 }, 2000);
  assert.equal(attachment.authState, "TEACHER_OFFLINE");
  assert.equal(attachment.authDeadline, null);
  assert.deepEqual(messages[1].payload, { op: "teacher_offline", generation: 7 });
});
