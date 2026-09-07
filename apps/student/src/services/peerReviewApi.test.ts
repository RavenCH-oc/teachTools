import { afterEach, expect, it, vi } from "vitest";
import { createPeerReviewRefreshGate, getPeerReviewActivities, getPeerReviewEssays } from "./peerReviewApi";
import type { StoredParticipant } from "./studentApi";
const id = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
const participant: StoredParticipant = { sessionId: id, participantId: id, serverInstanceId: id, credential: "A".repeat(43), participant: { participantId: id, sessionId: id, displayName: "Test", seatNumber: 1 } };
afterEach(() => vi.unstubAllGlobals());
it("sends credentials only in headers and retains bounded page cursor", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], nextCursor: "opaque" }) });
  vi.stubGlobal("fetch", fetchMock);
  expect(await getPeerReviewActivities(participant, { limit: 7, cursor: "opaque" })).toEqual({ items: [], nextCursor: "opaque" });
  expect(fetchMock).toHaveBeenCalledWith("/api/v1/peer-review/activities?limit=7&cursor=opaque", expect.objectContaining({ cache: "no-store", headers: { authorization: `Bearer ${participant.credential}`, "x-classroom-session": id, "x-classroom-participant": id } }));
  await getPeerReviewEssays(participant, id, { limit: 1 });
  expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain(participant.credential);
});
it("rejects old HTTP completion generations after invalidation", () => {
  const gate = createPeerReviewRefreshGate();
  const old = gate.current();
  const fresh = gate.invalidate();
  expect(gate.accepts(old)).toBe(false);
  expect(gate.accepts(fresh)).toBe(true);
});
