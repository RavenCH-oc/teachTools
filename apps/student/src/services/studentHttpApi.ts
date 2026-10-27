import { remoteHttpOperationSchema, type RemoteHttpOperation } from "@classtools/backend-contract";
import { isRemoteParticipant, StudentApiError, type StoredParticipant } from "./studentApi";

const MEDIA_RETRY_LIMIT = 16;
const MEDIA_RETRY_BUDGET_MS = 30_000;
const SATURATION_BODY_LIMIT = 1_024;

function abortError(): DOMException { return new DOMException("The operation was aborted.", "AbortError"); }

function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// A 429 is retryable only for the existing small JSON saturation error. Do not
// trust Content-Length alone or consume an unbounded error body to decide this.
async function isMediaSaturation(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return false;
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > SATURATION_BODY_LIMIT)) return false;
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<null>((resolve, reject) => {
    timer = setTimeout(() => resolve(null), 1_000);
    onAbort = () => reject(abortError());
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part === null) return false;
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > SATURATION_BODY_LIMIT) return false;
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && "code" in body && body.code === "REMOTE_SERVICE_UNAVAILABLE";
  } catch {
    if (signal?.aborted) throw abortError();
    return false;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    // Do not await tee cancellation: it can wait until the original is consumed.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

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
    const started = performance.now();
    for (let retries = 0; ; retries += 1) {
      if (signal?.aborted) throw abortError();
      const response = await fetch(path + (query.size || "page" in args ? `?${query}` : ""), { signal, cache: "no-store",
        headers: { authorization: `Bearer ${participant.credential}`, "x-classroom-session": participant.sessionId, "x-classroom-participant": participant.participantId } });
      if (!remote || request.operation !== "SESSION_ASSET_GET" || response.status !== 429
        || retries >= MEDIA_RETRY_LIMIT || performance.now() - started >= MEDIA_RETRY_BUDGET_MS
        || !await isMediaSaturation(response, signal)) return response;
      const ceiling = Math.min(2_000, 250 * 2 ** retries);
      const delay = ceiling * (0.5 + Math.random() * 0.5);
      if (performance.now() - started + delay >= MEDIA_RETRY_BUDGET_MS) return response;
      await waitForRetry(delay, signal);
      // This is a retry-admission deadline, not a successful media body timeout.
      if (performance.now() - started >= MEDIA_RETRY_BUDGET_MS) return response;
      void response.body?.cancel().catch(() => undefined);
    }
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
