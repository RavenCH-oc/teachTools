import { describe, expect, it } from "vitest";
import { clientMessageSchema, serverMessageSchema, sessionSyncSchema } from "./index";
import { peerReviewActivitiesPageSchema, peerReviewFeedbackQuerySchema } from "./peer-review";
const id = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
const submission = "c51a6f25-69d6-4e48-907a-12cce665913d";
describe("Peer Review bounded protocol", () => {
  it("validates bounded additive HTTP metadata and the explicit activity filter", () => {
    const item = { activityId: id, sessionQuestionId: id, assignmentId: null, mode: "STUDENT_SELECT", state: "OPEN", questionSummary: "😀".repeat(200), receivedFeedbackCount: 0, latestReviewRevision: null, reviewerGroupLabel: null, targetGroupLabel: null };
    expect(peerReviewActivitiesPageSchema.safeParse({ items: [item], nextCursor: null }).success).toBe(true);
    for (const patch of [{ questionSummary: "😀".repeat(201) }, { receivedFeedbackCount: -1 }, { reviewerGroupLabel: "x".repeat(201) }]) expect(peerReviewActivitiesPageSchema.safeParse({ items: [{ ...item, ...patch }], nextCursor: null }).success).toBe(false);
    expect(peerReviewFeedbackQuerySchema.safeParse({ activityId: id, limit: 100 }).success).toBe(true);
    expect(peerReviewFeedbackQuerySchema.safeParse({}).success).toBe(true);
    for (const query of [{ activityId: submission }, { limit: 101 }, { limit: 0 }, { cursor: "bad!" }, { ignored: "option" }]) expect(peerReviewFeedbackQuerySchema.safeParse(query).success).toBe(false);
  });
  it("allows only v4/v7 submission IDs and v7 internal IDs", () => {
    const request = { protocolVersion: 1, type: "submit_peer_review", requestId: "submit", reviewSubmissionId: submission, assignmentId: id, expectedBaseRevision: 0, body: "feedback" };
    expect(clientMessageSchema.safeParse(request).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...request, reviewSubmissionId: id }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...request, assignmentId: submission }).success).toBe(false);
  });
  it("rejects invalid identity, revision, body and client authority", () => {
    const request = { protocolVersion: 1, type: "submit_peer_review", requestId: "submit", reviewSubmissionId: submission, assignmentId: id, expectedBaseRevision: 0, body: "feedback" };
    for (const reviewSubmissionId of ["invalid", "00000000-0000-0000-0000-000000000000", submission.replace("4e48", "1e48"), submission.replace("907a", "007a")]) expect(clientMessageSchema.safeParse({ ...request, reviewSubmissionId }).success).toBe(false);
    for (const patch of [{ body: " " }, { body: "\0" }, { body: "字".repeat(10001) }, { expectedBaseRevision: -1 }, { reviewerId: id }]) expect(clientMessageSchema.safeParse({ ...request, ...patch }).success).toBe(false);
  });
  it("keeps summary optional, bounded and body-free", () => {
    const sync = { sessionState: "ACTIVE", currentQuestion: null, ownLatestSubmission: null, reveal: null };
    expect(sessionSyncSchema.safeParse(sync).success).toBe(true);
    const peerReview = { available: true, visibleActivityCount: 1000, receivedFeedbackCount: 1000 };
    expect(sessionSyncSchema.safeParse({ ...sync, peerReview }).success).toBe(true);
    expect(sessionSyncSchema.safeParse({ ...sync, peerReview: { ...peerReview, candidates: [] } }).success).toBe(false);
    expect(serverMessageSchema.safeParse({ protocolVersion: 1, type: "peer_review_changed" }).success).toBe(true);
    expect(serverMessageSchema.safeParse({ protocolVersion: 1, type: "peer_review_acknowledged", requestId: "submit", acknowledgement: { assignmentId: id, reviewSubmissionId: submission, revision: 1 } }).success).toBe(true);
    expect(serverMessageSchema.safeParse({ protocolVersion: 1, type: "peer_review_rejected", requestId: "submit", code: "PEER_REVIEW_CLOSED" }).success).toBe(true);
  });
});
