export const REMOTE_PROTOCOL_VERSION = 1;
export const MAX_ENVELOPE_BYTES = 64 * 1024;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ERROR_CODES = Object.freeze([
  "AUTH_REQUIRED", "AUTH_REJECTED", "TEACHER_UNAVAILABLE", "SESSION_CLOSED",
  "SESSION_EXPIRED", "PROTOCOL_MISMATCH", "MESSAGE_TOO_LARGE",
  "MALFORMED_MESSAGE", "REMOTE_SERVICE_UNAVAILABLE",
]);

export function readEnvelope(raw) {
  if (typeof raw !== "string") return { error: "MALFORMED_MESSAGE" };
  if (new TextEncoder().encode(raw).byteLength > MAX_ENVELOPE_BYTES) {
    return { error: "MESSAGE_TOO_LARGE" };
  }
  let value;
  try { value = JSON.parse(raw); } catch { return { error: "MALFORMED_MESSAGE" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "MALFORMED_MESSAGE" };
  }
  if (value.v !== REMOTE_PROTOCOL_VERSION) return { error: "PROTOCOL_MISMATCH" };
  if (!Object.keys(value).every((key) => ["v", "type", "id", "payload"].includes(key))
    || !["CONTROL", "AUTH", "REALTIME", "HTTP_RELAY", "ERROR"].includes(value.type)
    || typeof value.id !== "string" || !UUID_PATTERN.test(value.id)
    || !value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) {
    return { error: "MALFORMED_MESSAGE" };
  }
  return { value };
}

export function transportError(code, id = null) {
  if (!ERROR_CODES.includes(code)) throw new Error("Unknown transport error");
  return JSON.stringify({ v: REMOTE_PROTOCOL_VERSION, type: "ERROR", id,
    payload: { kind: "transport", code, retryable: ["TEACHER_UNAVAILABLE", "REMOTE_SERVICE_UNAVAILABLE"].includes(code) } });
}

export function control(op, id, extra = {}) {
  return JSON.stringify({ v: REMOTE_PROTOCOL_VERSION, type: "CONTROL", id, payload: { op, ...extra } });
}

export function hasKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

export function participantAuth(message) {
  return hasKeys(message, ["protocolVersion", "type", "requestId", "sessionId", "participantId", "credential"])
    && message.protocolVersion === 1 && message.type === "participant_auth"
    && typeof message.requestId === "string" && message.requestId.length > 0 && message.requestId.length <= 120
    && UUID_PATTERN.test(message.sessionId) && UUID_PATTERN.test(message.participantId)
    && typeof message.credential === "string" && SECRET_PATTERN.test(message.credential);
}

// Payload contents remain Rust-authoritative. Only the frozen transport families
// and existing bounded Classroom message names are allowlisted here.
export function clientRealtime(message) {
  return message && message.protocolVersion === 1
    && ["ping", "submit_answer", "select_group", "claim_peer_review", "submit_peer_review"].includes(message.type);
}

export function serverRealtime(message) {
  return message && message.protocolVersion === 1
    && ["session_sync", "session_state_changed", "question_state_changed", "question_revealed",
      "submission_acknowledged", "submission_result", "group_selection_acknowledged", "pong", "error",
      "peer_review_changed", "peer_review_acknowledged", "peer_review_rejected"].includes(message.type);
}

export function encodeEnvelope(type, id, payload) {
  const raw = JSON.stringify({ v: REMOTE_PROTOCOL_VERSION, type, id, payload });
  return encoderLength(raw) <= MAX_ENVELOPE_BYTES ? raw : null;
}

function encoderLength(raw) { return new TextEncoder().encode(raw).byteLength; }
