import {
  REMOTE_MAX_ENVELOPE_BYTES, REMOTE_PROTOCOL_VERSION, parseRemoteStudentEnvelope,
  publicErrorSchema, remoteBootstrapSchema, remoteJoinRequestSchema, remoteJoinResultSchema, serverMessageSchema,
  type ClientMessage, type RemoteJoinResult,
} from "@classtools/backend-contract";
import {
  createParticipantTransport, isRemoteParticipant, secureUuid, StudentApiError,
  type ParticipantTransportCallbacks, type ParticipantWire, type ParticipantWireEvent,
  type StoredParticipant,
} from "./studentApi";

export function remoteSessionIdFromPath(path: string): string {
  return /^\/join\/([A-Za-z0-9_-]{32})$/.exec(path)?.[1] ?? "";
}

export async function getRemoteJoinShell(remoteSessionId: string): Promise<void> {
  const body = await remoteRequest(`/v1/sessions/${remoteSessionId}/bootstrap`, { cache: "no-store" });
  const parsed = remoteBootstrapSchema.safeParse(body);
  if (!parsed.success) throw invalidRemoteResponse(body);
  if (parsed.data.status !== "available") throw new StudentApiError("老師的遠端課堂暫時無法使用，請稍後再試。", "TEACHER_UNAVAILABLE");
}

export async function joinRemoteClassroom(remoteSessionId: string, joinAttemptId: string, seatNumber: number, name: string): Promise<RemoteJoinResult> {
  const body = remoteJoinRequestSchema.parse({ remoteProtocolVersion: REMOTE_PROTOCOL_VERSION, joinAttemptId, seatNumber, name });
  const result = await remoteRequest(`/v1/sessions/${remoteSessionId}/join`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store",
  });
  const parsed = remoteJoinResultSchema.safeParse(result);
  if (!parsed.success) throw invalidRemoteResponse(result);
  if (parsed.data.participant.serverInstanceId !== `remote:${remoteSessionId}`
    || parsed.data.info.serverInstanceId !== `remote:${remoteSessionId}`
    || parsed.data.info.sessionId !== parsed.data.participant.sessionId) throw invalidRemoteResponse(result);
  return parsed.data;
}

function invalidRemoteResponse(body: unknown): StudentApiError {
  if (typeof body === "object" && body !== null && "remoteProtocolVersion" in body && body.remoteProtocolVersion !== REMOTE_PROTOCOL_VERSION) {
    return new StudentApiError("遠端課堂版本不相容，請更新頁面並確認老師使用相同版本。", "PROTOCOL_MISMATCH");
  }
  return new StudentApiError("遠端課堂回應無法使用。", "INVALID_RESPONSE");
}

async function remoteRequest(path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, init); } catch { throw new StudentApiError("遠端連線暫時中斷，請再試一次。", "NETWORK_ERROR"); }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = publicErrorSchema.safeParse(body);
    const code = error.success ? error.data.code : typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : "REQUEST_FAILED";
    const message = code === "PROTOCOL_MISMATCH" ? "遠端課堂版本不相容，請更新頁面並確認老師使用相同版本。"
      : code === "TEACHER_UNAVAILABLE" ? "老師的遠端課堂暫時無法使用，請稍後再試。"
      : error.success ? error.data.message : "無法完成遠端課堂請求，請稍後再試。";
    throw new StudentApiError(message, code);
  }
  return body;
}

function remoteDecode(raw: string): ParticipantWireEvent {
  // Detect a version mismatch before schema validation, while retaining the complete-envelope ceiling.
  if (new TextEncoder().encode(raw).byteLength > REMOTE_MAX_ENVELOPE_BYTES) return { kind: "failure", reason: "MESSAGE_TOO_LARGE" };
  const version: unknown = JSON.parse(raw);
  if (typeof version === "object" && version !== null && "v" in version && version.v !== REMOTE_PROTOCOL_VERSION) return { kind: "failure", reason: "PROTOCOL_MISMATCH" };
  const envelope = parseRemoteStudentEnvelope(raw);
  if (envelope.type === "AUTH") {
    if (!("accepted" in envelope.payload)) throw new StudentApiError("遠端驗證回應無效。");
    if (envelope.payload.accepted !== (envelope.payload.message.type === "participant_authenticated")) throw new StudentApiError("遠端驗證回應無效。");
    return { kind: "message", message: envelope.payload.message };
  }
  if (envelope.type === "REALTIME") {
    const message = serverMessageSchema.parse(envelope.payload.message);
    if (message.type === "participant_authenticated" || message.type === "server_hello") throw new StudentApiError("遠端驗證必須使用 AUTH 訊息。");
    return { kind: "message", message };
  }
  if (envelope.type === "CONTROL") {
    if (envelope.payload.op === "REAUTH_REQUIRED") return { kind: "reauth" };
    if (envelope.payload.op === "teacher_offline") return { kind: "unavailable" };
    throw new StudentApiError("遠端控制訊息無效。");
  }
  return { kind: "failure", reason: envelope.payload.code === "PROTOCOL_MISMATCH" ? "PROTOCOL_MISMATCH"
    : envelope.payload.code === "MESSAGE_TOO_LARGE" ? "MESSAGE_TOO_LARGE"
    : envelope.payload.code === "AUTH_REJECTED" ? "AUTH_FAILED"
    : envelope.payload.code === "SESSION_CLOSED" || envelope.payload.code === "SESSION_EXPIRED" ? "SESSION_ENDED" : "transient" };
}

function remoteWire(remoteSessionId: string): ParticipantWire {
  return {
    url: () => `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/v1/sessions/${remoteSessionId}/ws`,
    authOnOpen: true, syncBeforeResume: true,
    encode: (message: ClientMessage) => {
      const raw = JSON.stringify({ v: REMOTE_PROTOCOL_VERSION, id: secureUuid(), type: message.type === "participant_auth" ? "AUTH" : "REALTIME", payload: { message } });
      if (new TextEncoder().encode(raw).byteLength > REMOTE_MAX_ENVELOPE_BYTES) throw new StudentApiError("遠端訊息超過大小限制。", "MESSAGE_TOO_LARGE");
      return raw;
    },
    decode: remoteDecode,
  };
}

export function createStudentTransport(participant: StoredParticipant, callbacks: ParticipantTransportCallbacks) {
  return createParticipantTransport(participant, callbacks,
    isRemoteParticipant(participant) ? remoteWire(participant.serverInstanceId.slice("remote:".length)) : undefined);
}
