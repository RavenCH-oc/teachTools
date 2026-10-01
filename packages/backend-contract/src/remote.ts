import { z } from "zod";

export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const REMOTE_MAX_ENVELOPE_BYTES = 64 * 1024;

export const remoteFamilySchema = z.enum(["CONTROL", "AUTH", "REALTIME", "HTTP_RELAY", "ERROR"]);
export const remoteTransportErrorCodeSchema = z.enum([
  "AUTH_REQUIRED", "AUTH_REJECTED", "TEACHER_UNAVAILABLE", "SESSION_CLOSED",
  "SESSION_EXPIRED", "PROTOCOL_MISMATCH", "MESSAGE_TOO_LARGE",
  "MALFORMED_MESSAGE", "REMOTE_SERVICE_UNAVAILABLE",
]);

const envelope = {
  v: z.literal(REMOTE_PROTOCOL_VERSION),
  id: z.string().uuid(),
};

export const remoteControlEnvelopeSchema = z.object({
  ...envelope,
  type: z.literal("CONTROL"),
  payload: z.discriminatedUnion("op", [
    z.object({ op: z.literal("ping") }).strict(),
    z.object({ op: z.literal("pong"), generation: z.number().int().positive() }).strict(),
    z.object({ op: z.literal("teacher_attached"), generation: z.number().int().positive() }).strict(),
    z.object({ op: z.literal("REAUTH_REQUIRED") }).strict(),
  ]),
}).strict();

export const remoteErrorEnvelopeSchema = z.object({
  v: z.literal(REMOTE_PROTOCOL_VERSION),
  type: z.literal("ERROR"),
  id: z.string().uuid().nullable(),
  payload: z.object({
    kind: z.literal("transport"),
    code: remoteTransportErrorCodeSchema,
    retryable: z.boolean(),
  }).strict(),
}).strict();

export const remoteControlPlaneEnvelopeSchema = z.discriminatedUnion("type", [
  remoteControlEnvelopeSchema,
  remoteErrorEnvelopeSchema,
]);

export const remoteCreateSessionRequestSchema = z.object({
  teacherAppVersion: z.string().regex(/^[A-Za-z0-9.+-]{1,40}$/),
  remoteProtocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
}).strict();

export const remoteCreateSessionResponseSchema = z.object({
  remoteSessionId: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  remoteProtocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  expiresAt: z.number().int().positive(),
}).strict();

export const remoteTicketResponseSchema = z.object({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  ticketExpiresAt: z.number().int().positive(),
}).strict();

export const remoteEnrollmentResponseSchema = z.object({
  installationId: z.string().uuid(),
  installationCredential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export const remoteBootstrapSchema = z.object({
  reachable: z.literal(true),
  remoteProtocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  status: z.enum(["available", "unavailable"]),
}).strict();

export const remoteTeacherSessionStatusSchema = z.object({
  remoteSessionId: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  localSessionId: z.string().uuid(),
  joinUrl: z.string().url(),
  expiresAt: z.number().int().positive(),
  generation: z.number().int().positive().nullable(),
  state: z.enum(["CONNECTING", "OPEN", "TEACHER_OFFLINE"]),
}).strict();

export const remoteTeacherStatusSchema = z.object({
  configured: z.boolean(),
  enrolled: z.boolean(),
  session: remoteTeacherSessionStatusSchema.nullable(),
}).strict();

export type RemoteTeacherStatus = z.infer<typeof remoteTeacherStatusSchema>;
export type RemoteTeacherSessionStatus = z.infer<typeof remoteTeacherSessionStatusSchema>;

export type RemoteControlPlaneEnvelope = z.infer<typeof remoteControlPlaneEnvelopeSchema>;

export function parseRemoteControlPlaneEnvelope(raw: string): RemoteControlPlaneEnvelope {
  if (new TextEncoder().encode(raw).byteLength > REMOTE_MAX_ENVELOPE_BYTES) {
    throw new Error("Remote envelope exceeds 64 KiB");
  }
  return remoteControlPlaneEnvelopeSchema.parse(JSON.parse(raw) as unknown);
}
