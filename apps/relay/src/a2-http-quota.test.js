import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { HttpRelay, HTTP_LIMITS, httpQuotaOwner } from "./http_relay.js";
const sessionId = "00000000-0000-4000-8000-000000000001";
const participantId = "00000000-0000-4000-8000-000000000002";
const identity = { sessionId, participantId, credential: "A".repeat(43) };
const request = { operation: "SESSION_ASSET_GET", arguments: { assetId: sessionId } };
// Compute the proposed opaque owner independently; the before implementation
// ignores this extra internal argument and still trusts the claimed identity.
const owner = value => createHash("sha256").update(JSON.stringify([value.sessionId, value.participantId, value.credential])).digest("hex");
function fixture() {
  const frames = []; const teacher = {};
  const relay = new HttpRelay((_socket, raw) => { frames.push(JSON.parse(raw)); return true; }, () => {});
  const responses = [];
  return { relay, frames, open(value = identity, operation = request) {
    const response = relay.open(new Request("http://test/"), { identity: value, request: operation }, 1, teacher, owner(value));
    responses.push(response); return response;
  }, async cleanup() { relay.failAll(); await Promise.all(responses); } };
}
test("A2 forged participant ID with a different credential cannot claim the victim media bucket", async () => {
  const f = fixture();
  try {
    f.open({ ...identity, credential: "B".repeat(43) });
    const victim = f.open();
    assert.equal(f.relay.pending.size, 2, "victim request must reach independent Rust authorization");
    assert.equal(victim instanceof Promise, true);
    assert.equal((await f.open()).status, 429, "same valid credential remains limited to one media stream");
  } finally { await f.cleanup(); }
});
test("A2 forged participant ID cannot consume the victim detail bucket", async () => {
  const f = fixture(); const operation = { operation: "PEER_REVIEW_ACTIVITIES_LIST", arguments: { page: {} } };
  try {
    for (let i = 0; i < HTTP_LIMITS.participantRequests; i += 1) f.open({ ...identity, credential: "B".repeat(43) }, operation);
    f.open(identity, operation);
    assert.equal(f.relay.pending.size, 5);
    assert.equal(f.frames.filter(frame => frame.payload.op === "HTTP_REQUEST").length, 5);
  } finally { await f.cleanup(); }
});
test("A2 varying invalid credentials do not bypass the Session media cap", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < HTTP_LIMITS.media; i += 1) f.open({ ...identity, credential: String.fromCharCode(66 + i).repeat(43) });
    assert.equal(f.relay.pending.size, HTTP_LIMITS.media);
    assert.equal((await f.open()).status, 429);
    for (const entry of f.relay.pending.values()) {
      assert.match(entry.owner, /^[a-f0-9]{64}$/);
      assert.equal(entry.owner.includes(participantId), false);
      assert.equal("credential" in entry, false);
    }
  } finally { await f.cleanup(); }
  assert.equal(f.relay.pending.size, 0);
});

test("A2 owner fingerprint is validated, opaque and scoped to the full presented identity", async () => {
  const body = { identity, request };
  assert.equal(await httpQuotaOwner(body), owner(identity));
  for (const changed of [ { ...identity, credential: "B".repeat(43) }, { ...identity, participantId: crypto.randomUUID() }, { ...identity, sessionId: crypto.randomUUID() } ]) {
    assert.notEqual(await httpQuotaOwner({ identity: changed, request }), await httpQuotaOwner(body));
  }
  for (const bad of [null, {}, { identity, request: { operation: "PROXY", arguments: {} } }, { identity: { ...identity, credential: "bad" }, request }, { identity, request, owner: "forged" }]) {
    assert.equal(await httpQuotaOwner(bad), null);
  }
  const f = fixture();
  const rejected = f.relay.open(new Request("http://test/"), body, 1, {});
  assert.equal(rejected.status, 400);
  assert.equal(f.relay.pending.size, 0);
});
