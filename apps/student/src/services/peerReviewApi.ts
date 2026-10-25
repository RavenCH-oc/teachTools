import { peerReviewActivitiesPageSchema, peerReviewCandidatesPageSchema, peerReviewFeedbackPageSchema, peerReviewEssaysPageSchema, peerReviewFeedbackDetailSchema, publicErrorSchema, type RemoteHttpOperation } from "@classtools/backend-contract";
import { StudentApiError, type StoredParticipant } from "./studentApi";
import { studentHttpRead, studentHttpError } from "./studentHttpApi";

type PageOptions = { limit?: number; cursor?: string; activityId?: string; signal?: AbortSignal };
const page = (options?: PageOptions) => ({ ...(options?.limit !== undefined ? { limit: options.limit } : {}), ...(options?.cursor !== undefined ? { cursor: options.cursor } : {}) });
async function read<T>(participant: StoredParticipant, operation: RemoteHttpOperation, parse: (value: unknown) => T, options?: PageOptions): Promise<T> {
  const response = await studentHttpRead(participant, operation, options?.signal);
  let body: unknown;
  try { body = await response.json(); } catch (cause) {
    if (typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError") throw cause;
    throw new StudentApiError("遠端服務暫時無法使用，請稍後重試。", "RESPONSE_INTERRUPTED");
  }
  if (!response.ok) {
    const error = publicErrorSchema.safeParse(body);
    throw studentHttpError(error.success ? error.data.code : "REQUEST_FAILED", error.success ? error.data.message : "無法讀取互評資料。");
  }
  try { return parse(body); } catch { throw new StudentApiError("課堂伺服器回應無法使用。", "INVALID_RESPONSE"); }
}
export const getPeerReviewActivities = (p: StoredParticipant, options?: PageOptions) => read(p, { operation: "PEER_REVIEW_ACTIVITIES_LIST", arguments: { page: page(options) } }, peerReviewActivitiesPageSchema.parse, options);
export const getPeerReviewActivity = (p: StoredParticipant, id: string, options?: PageOptions) => read(p, { operation: "PEER_REVIEW_ACTIVITY_GET", arguments: { activityId: id } }, peerReviewActivitiesPageSchema.parse, options);
export const getPeerReviewCandidates = (p: StoredParticipant, id: string, options?: PageOptions) => read(p, { operation: "PEER_REVIEW_CANDIDATES_LIST", arguments: { activityId: id, page: page(options) } }, peerReviewCandidatesPageSchema.parse, options);
export const getPeerReviewFeedback = (p: StoredParticipant, options?: PageOptions) => read(p, { operation: "PEER_REVIEW_FEEDBACK_LIST", arguments: { ...(options?.activityId !== undefined ? { activityId: options.activityId } : {}), page: page(options) } }, peerReviewFeedbackPageSchema.parse, options);
export const getPeerReviewEssays = (p: StoredParticipant, id: string, options?: PageOptions) => read(p, { operation: "PEER_REVIEW_ESSAYS_LIST", arguments: { assignmentId: id, page: page(options) } }, peerReviewEssaysPageSchema.parse, options);
export const getPeerReviewFeedbackDetail = (p: StoredParticipant, id: string, options?: PageOptions) => read(p, { operation: "PEER_REVIEW_FEEDBACK_GET", arguments: { assignmentId: id } }, peerReviewFeedbackDetailSchema.parse, options);
export const getOwnPeerReview = (p: StoredParticipant, id: string, options?: PageOptions) => read(p, { operation: "PEER_REVIEW_OWN_REVIEW_GET", arguments: { assignmentId: id } }, peerReviewFeedbackDetailSchema.nullable().parse, options);

/** A view may retain this gate across navigation; stale HTTP completions never replace a newer refresh. */
export function createPeerReviewRefreshGate() {
  let generation = 0;
  return { invalidate: () => ++generation, current: () => generation, accepts: (requestGeneration: number) => requestGeneration === generation };
}
