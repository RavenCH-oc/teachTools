import { z } from "zod";

export const BACKEND_CONTRACT_VERSION = 1 as const;
export const LOCAL_PROTOCOL_VERSION = 1 as const;

const requestIdSchema = z.string().trim().min(1).max(120);
const protocolVersionSchema = z.literal(LOCAL_PROTOCOL_VERSION);
const uuidSchema = z.string().uuid();

export const sessionPublicViewSchema = z.object({
  sessionId: uuidSchema,
  classroomName: z.string().trim().min(1).max(200),
  state: z.enum(["CREATED", "LOBBY", "ENDED"]),
  joinMode: z.literal("roster_match"),
  serverInstanceId: uuidSchema,
  protocolVersion: protocolVersionSchema,
}).strict();

export const participantSelfViewSchema = z.object({
  participantId: uuidSchema,
  sessionId: uuidSchema,
  seatNumber: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(200),
}).strict();

export const joinSuccessSchema = z.object({
  sessionId: uuidSchema,
  participantId: uuidSchema,
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  participant: participantSelfViewSchema,
  serverInstanceId: uuidSchema,
}).strict();

export const publicErrorSchema = z.object({ code: z.string().trim().min(1), message: z.string().trim().min(1) }).strict();

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("ping"),
    requestId: requestIdSchema,
  }).strict(),
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("participant_auth"),
    requestId: requestIdSchema,
    sessionId: uuidSchema,
    participantId: uuidSchema,
    credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }).strict(),
]);

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("server_hello"),
    serverInstanceId: z.string().uuid(),
  }).strict(),
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("participant_authenticated"),
    participant: participantSelfViewSchema,
    classroomName: z.string().trim().min(1).max(200),
    sessionState: z.literal("LOBBY"),
  }).strict(),
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("session_state_changed"),
    sessionId: uuidSchema,
    state: z.literal("ENDED"),
  }).strict(),
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("pong"),
    requestId: requestIdSchema,
  }).strict(),
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("error"),
    code: z.enum(["PROTOCOL_ERROR", "AUTH_FAILED", "AUTH_TIMEOUT", "SESSION_ENDED", "SERVER_INSTANCE_MISMATCH"]),
    message: z.string().trim().min(1).max(200),
  }).strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type SessionPublicView = z.infer<typeof sessionPublicViewSchema>;
export type ParticipantSelfView = z.infer<typeof participantSelfViewSchema>;
export type JoinSuccess = z.infer<typeof joinSuccessSchema>;

/**
 * The production SessionBackend contract is still deferred. Phase 7 defines
 * only the public local transport handshake and ping/pong protocol.
 */
export type BackendContractMarker = {
  name: "SessionBackend";
  version: typeof BACKEND_CONTRACT_VERSION;
};
