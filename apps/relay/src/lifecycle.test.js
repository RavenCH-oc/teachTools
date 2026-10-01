import assert from "node:assert/strict";
import test from "node:test";
import { expireRelay } from "./lifecycle.js";

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
