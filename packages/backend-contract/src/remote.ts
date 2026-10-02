import { z } from "zod";
import { clientMessageSchema, joinSuccessSchema, publicErrorSchema, serverMessageSchema, sessionPublicViewSchema } from "./index";

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
const generationSchema = z.number().int().positive();
const connectionIdSchema = z.string().uuid();

export const remoteJoinRequestSchema = z.object({
  remoteProtocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
  joinAttemptId: z.string().uuid(),
  seatNumber: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
}).strict();

export const remoteJoinResultSchema = z.object({
  info: z.lazy(() => sessionPublicViewSchema),
  participant: z.lazy(() => joinSuccessSchema),
}).strict();

export const remoteControlEnvelopeSchema = z.object({
  ...envelope,
  type: z.literal("CONTROL"),
  payload: z.union([
    z.object({ op: z.literal("ping") }).strict(),
    z.object({ op: z.literal("pong"), generation: z.number().int().positive() }).strict(),
    z.object({ op: z.literal("teacher_attached"), generation: z.number().int().positive() }).strict(),
    z.object({ op: z.literal("REAUTH_REQUIRED"), generation: generationSchema }).strict(),
    z.object({ op: z.literal("teacher_offline"), generation: generationSchema }).strict(),
    z.object({ op: z.literal("participant_disconnected"), generation: generationSchema,
      connectionId: connectionIdSchema }).strict(),
    z.object({ op: z.literal("join"), generation: generationSchema, joinAttemptId: z.string().uuid(),
      seatNumber: z.number().int().positive(), name: z.string().trim().min(1).max(200) }).strict(),
    z.object({ op: z.literal("join_result"), generation: generationSchema,
      result: remoteJoinResultSchema.optional(), error: z.lazy(() => publicErrorSchema).optional(),
    }).strict().refine((value) => (value.result === undefined) !== (value.error === undefined)),
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

// Lazy references preserve the single existing Classroom message contract and
// avoid evaluating the index module's schemas during the export cycle.
export const remoteStudentAuthEnvelopeSchema = z.object({
  ...envelope,
  type: z.literal("AUTH"),
  payload: z.union([
    z.object({ message: z.lazy(() => clientMessageSchema).refine((message) => message.type === "participant_auth") }).strict(),
    z.object({ accepted: z.boolean(), message: z.lazy(() => serverMessageSchema) }).strict()
      .refine((payload) => payload.message.type === (payload.accepted ? "participant_authenticated" : "error")),
  ]),
}).strict();

export const remoteStudentRealtimeEnvelopeSchema = z.object({
  ...envelope,
  type: z.literal("REALTIME"),
  payload: z.object({ message: z.lazy(() => z.union([clientMessageSchema, serverMessageSchema]))
    .refine((message) => !["participant_auth", "participant_authenticated", "server_hello"].includes(message.type)) }).strict(),
}).strict();

export const remoteStudentControlEnvelopeSchema = z.object({
  ...envelope,
  type: z.literal("CONTROL"),
  payload: z.discriminatedUnion("op", [
    z.object({ op: z.literal("REAUTH_REQUIRED"), generation: generationSchema }).strict(),
    z.object({ op: z.literal("teacher_offline"), generation: generationSchema }).strict(),
  ]),
}).strict();

export const remoteStudentEnvelopeSchema = z.discriminatedUnion("type", [
  remoteStudentControlEnvelopeSchema,
  remoteStudentAuthEnvelopeSchema,
  remoteStudentRealtimeEnvelopeSchema,
  remoteErrorEnvelopeSchema,
]);

export const remoteTeacherAuthEnvelopeSchema = z.object({
  ...envelope,
  type: z.literal("AUTH"),
  payload: z.union([
    z.object({ connectionId: connectionIdSchema, generation: generationSchema,
      message: z.lazy(() => clientMessageSchema).refine((message) => message.type === "participant_auth") }).strict(),
    z.object({ connectionId: connectionIdSchema, generation: generationSchema, accepted: z.boolean(),
      message: z.lazy(() => serverMessageSchema) }).strict()
      .refine((payload) => payload.message.type === (payload.accepted ? "participant_authenticated" : "error")),
  ]),
}).strict();

export const remoteTeacherRealtimeEnvelopeSchema = z.object({
  ...envelope,
  type: z.literal("REALTIME"),
  payload: z.object({ connectionId: connectionIdSchema, generation: generationSchema,
    message: z.lazy(() => z.union([clientMessageSchema, serverMessageSchema]))
      .refine((message) => !["participant_auth", "participant_authenticated", "server_hello"].includes(message.type)),
  }).strict(),
}).strict();

export type RemoteJoinRequest = z.infer<typeof remoteJoinRequestSchema>;
export type RemoteJoinResult = z.infer<typeof remoteJoinResultSchema>;
export type RemoteStudentEnvelope = z.infer<typeof remoteStudentEnvelopeSchema>;

export function parseRemoteStudentEnvelope(raw: string): RemoteStudentEnvelope {
  if (new TextEncoder().encode(raw).byteLength > REMOTE_MAX_ENVELOPE_BYTES) {
    throw new Error("Remote envelope exceeds 64 KiB");
  }
  return remoteStudentEnvelopeSchema.parse(JSON.parse(raw) as unknown);
}

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
