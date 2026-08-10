import { z } from "zod";

export const BACKEND_CONTRACT_VERSION = 1 as const;
export const LOCAL_PROTOCOL_VERSION = 1 as const;

const requestIdSchema = z.string().trim().min(1).max(120);
const protocolVersionSchema = z.literal(LOCAL_PROTOCOL_VERSION);

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("ping"),
    requestId: requestIdSchema,
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
    type: z.literal("pong"),
    requestId: requestIdSchema,
  }).strict(),
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("error"),
    code: z.literal("PROTOCOL_ERROR"),
    message: z.string().trim().min(1).max(200),
  }).strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/**
 * The production SessionBackend contract is still deferred. Phase 7 defines
 * only the public local transport handshake and ping/pong protocol.
 */
export type BackendContractMarker = {
  name: "SessionBackend";
  version: typeof BACKEND_CONTRACT_VERSION;
};
