import { remoteHttpOperationSchema, type RemoteHttpOperation } from "@classtools/backend-contract";
import { isRemoteParticipant, StudentApiError, type StoredParticipant } from "./studentApi";

function localPath(request: RemoteHttpOperation): string {
  switch (request.operation) {
    case "PEER_REVIEW_ACTIVITIES_LIST": return "/api/v1/peer-review/activities";
    case "PEER_REVIEW_ACTIVITY_GET": return `/api/v1/peer-review/activities/${request.arguments.activityId}`;
    case "PEER_REVIEW_CANDIDATES_LIST": return `/api/v1/peer-review/candidates/${request.arguments.activityId}`;
    case "PEER_REVIEW_ESSAYS_LIST": return `/api/v1/peer-review/essays/${request.arguments.assignmentId}`;
    case "PEER_REVIEW_FEEDBACK_LIST": return "/api/v1/peer-review/feedback";
    case "PEER_REVIEW_FEEDBACK_GET": return `/api/v1/peer-review/feedback/${request.arguments.assignmentId}`;
    case "PEER_REVIEW_OWN_REVIEW_GET": return `/api/v1/peer-review/own-review/${request.arguments.assignmentId}`;
    case "SESSION_ASSET_GET": return `/api/v1/session-assets/${request.arguments.assetId}`;
  }
}

export async function studentHttpRead(participant: StoredParticipant, request: RemoteHttpOperation, signal?: AbortSignal): Promise<Response> {
  remoteHttpOperationSchema.parse(request);
  const remote = isRemoteParticipant(participant);
  const query = new URLSearchParams();
  const args = request.arguments;
  if ("page" in args) {
    if (args.page.limit !== undefined) query.set("limit", String(args.page.limit));
    if (args.page.cursor !== undefined) query.set("cursor", args.page.cursor);
  }
  if (remote) {
    for (const [key, value] of Object.entries(args)) if (key !== "page" && value !== undefined) query.set(key, String(value));
  } else if (request.operation === "PEER_REVIEW_FEEDBACK_LIST" && request.arguments.activityId !== undefined) query.set("activityId", request.arguments.activityId);
  const locator = participant.serverInstanceId.slice("remote:".length);
  if (remote && !/^[A-Za-z0-9_-]{32}$/.test(locator)) throw new StudentApiError("遠端課堂連線無效。", "INVALID_RESPONSE");
  const path = remote ? `/v1/sessions/${locator}/http/${request.operation}` : localPath(request);
  try {
    return await fetch(path + (query.size || "page" in args ? `?${query}` : ""), { signal, cache: "no-store",
      headers: { authorization: `Bearer ${participant.credential}`, "x-classroom-session": participant.sessionId, "x-classroom-participant": participant.participantId } });
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError") throw cause;
    throw new StudentApiError("遠端服務暫時無法使用，請稍後重試。", "NETWORK_ERROR");
  }
}

export function studentHttpError(code: string, fallback: string): StudentApiError {
  return new StudentApiError(code === "TEACHER_UNAVAILABLE" ? "教師端暫時離線，請稍後重試。"
    : code === "REQUEST_TIMEOUT" ? "讀取逾時，請稍後重試。"
    : ["REMOTE_SERVICE_UNAVAILABLE", "RESPONSE_INVALID"].includes(code) ? "遠端服務暫時無法使用，請稍後重試。"
    : fallback, code);
}
