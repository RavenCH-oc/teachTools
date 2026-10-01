export const REMOTE_PROTOCOL_VERSION = 1;
export const MAX_ENVELOPE_BYTES = 64 * 1024;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
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
    || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id)
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
