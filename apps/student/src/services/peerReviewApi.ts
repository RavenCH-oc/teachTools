import { peerReviewActivitiesPageSchema, peerReviewCandidatesPageSchema, peerReviewFeedbackPageSchema, peerReviewEssaysPageSchema, peerReviewFeedbackDetailSchema, peerReviewFeedbackQuerySchema, publicErrorSchema } from "@classtools/backend-contract";
import { StudentApiError, type StoredParticipant } from "./studentApi";

type PageOptions = { limit?: number; cursor?: string; activityId?: string; signal?: AbortSignal };
async function read<T>(participant: StoredParticipant, path: string, parse: (value: unknown) => T, options: PageOptions = {}): Promise<T> {
  const query = new URLSearchParams();
  peerReviewFeedbackQuerySchema.parse({ limit: options.limit, cursor: options.cursor, activityId: options.activityId });
  if (options.activityId !== undefined) query.set("activityId", options.activityId);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  const response = await fetch(`/api/v1/peer-review/${path}?${query}`, { signal: options.signal, cache: "no-store", headers: { authorization: `Bearer ${participant.credential}`, "x-classroom-session": participant.sessionId, "x-classroom-participant": participant.participantId } });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = publicErrorSchema.safeParse(body);
    throw new StudentApiError(error.success ? error.data.message : "無法讀取互評資料。", error.success ? error.data.code : "REQUEST_FAILED");
  }
  return parse(body);
}
export const getPeerReviewActivities = (p: StoredParticipant, options?: PageOptions) => read(p, "activities", peerReviewActivitiesPageSchema.parse, options);
export const getPeerReviewActivity = (p: StoredParticipant, id: string, options?: PageOptions) => read(p, `activities/${encodeURIComponent(id)}`, peerReviewActivitiesPageSchema.parse, options);
export const getPeerReviewCandidates = (p: StoredParticipant, id: string, options?: PageOptions) => read(p, `candidates/${encodeURIComponent(id)}`, peerReviewCandidatesPageSchema.parse, options);
export const getPeerReviewFeedback = (p: StoredParticipant, options?: PageOptions) => read(p, "feedback", peerReviewFeedbackPageSchema.parse, options);
export const getPeerReviewEssays = (p: StoredParticipant, id: string, options?: PageOptions) => read(p, `essays/${encodeURIComponent(id)}`, peerReviewEssaysPageSchema.parse, options);
export const getPeerReviewFeedbackDetail = (p: StoredParticipant, id: string, options?: PageOptions) => read(p, `feedback/${encodeURIComponent(id)}`, peerReviewFeedbackDetailSchema.parse, options);
export const getOwnPeerReview = (p: StoredParticipant, id: string, options?: PageOptions) => read(p, `own-review/${encodeURIComponent(id)}`, peerReviewFeedbackDetailSchema.nullable().parse, options);

/** A view may retain this gate across navigation; stale HTTP completions never replace a newer refresh. */
export function createPeerReviewRefreshGate() {
  let generation = 0;
  return { invalidate: () => ++generation, current: () => generation, accepts: (requestGeneration: number) => requestGeneration === generation };
}
