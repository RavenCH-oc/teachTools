import { z } from "zod";
import { claimPeerReviewSchema, submitPeerReviewSchema, peerReviewProjectionSchema, peerReviewChangedSchema, peerReviewAcknowledgedSchema, peerReviewRejectedSchema } from "./peer-review";
export * from "./peer-review";

export const BACKEND_CONTRACT_VERSION = 1 as const;
export const LOCAL_PROTOCOL_VERSION = 1 as const;

const requestIdSchema = z.string().trim().min(1).max(120);
const protocolVersionSchema = z.literal(LOCAL_PROTOCOL_VERSION);
const uuidSchema = z.string().uuid();

export const sessionPublicViewSchema = z.object({
  sessionId: uuidSchema,
  classroomName: z.string().trim().min(1).max(200),
  state: z.enum(["CREATED", "LOBBY", "ACTIVE", "ENDED"]),
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
  claimPeerReviewSchema,
  submitPeerReviewSchema,
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
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("submit_answer"),
    requestId: requestIdSchema,
    submissionId: uuidSchema,
    sessionQuestionId: uuidSchema,
    answer: z.discriminatedUnion("type", [
      z.object({ type: z.literal("true_false"), value: z.boolean() }).strict(),
      z.object({ type: z.literal("single_choice"), optionId: z.string().trim().min(1).max(120) }).strict(),
      z.object({ type: z.literal("multiple_choice"), optionIds: z.array(z.string().trim().min(1).max(120)).max(100) }).strict(),
      z.object({ type: z.literal("fill_blank"), values: z.record(z.string().trim().min(1).max(120), z.string().max(10_000)) }).strict(),
      z.object({ type: z.literal("essay"), text: z.string().max(100_000) }).strict(),
    ]),
  }).strict(),
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("select_group"),
    requestId: requestIdSchema,
    draftId: uuidSchema,
    groupId: uuidSchema.nullable(),
  }).strict(),
]);

export const sessionQuestionAssetSchema = z.object({
  id: uuidSchema, assetType: z.enum(["image", "pdf"]), displayName: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().min(1).max(200), sizeBytes: z.number().int().positive(), position: z.number().int().nonnegative(), pageReference: z.number().int().positive().nullable(),
}).strict();
export const questionPublicViewSchema = z.object({
  sessionQuestionId: uuidSchema, type: z.enum(["true_false", "single_choice", "multiple_choice", "fill_blank", "essay"]), prompt: z.string().trim().min(1).max(20_000), points: z.number().int().positive(), state: z.enum(["OPEN", "LOCKED", "REVEALED"]),
  options: z.array(z.object({ id: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(20_000) }).strict()), blanks: z.array(z.string().trim().min(1).max(120)), assets: z.array(sessionQuestionAssetSchema),
}).strict();
export const ownSubmissionResultSchema = z.object({ submissionId: uuidSchema, revision: z.number().int().positive(), gradingStatus: z.enum(["graded", "pending"]), isCorrect: z.boolean().nullable(), score: z.number().int().nonnegative().nullable(), maxScore: z.number().int().positive(), answer: z.unknown() }).strict();
export const questionRevealViewSchema = z.object({ ...questionPublicViewSchema.shape, correctAnswer: z.unknown().nullable() }).strict();
export const studentGroupingMemberSchema = z.object({ displayName: z.string().trim().min(1).max(200), seatNumber: z.number().int().positive(), isSelf: z.boolean() }).strict();
export const studentGroupingGroupSchema = z.object({ groupId: uuidSchema, name: z.string().trim().min(1).max(200), position: z.number().int().nonnegative(), memberCount: z.number().int().nonnegative(), capacity: z.number().int().positive().nullable(), isFull: z.boolean(), members: z.array(studentGroupingMemberSchema) }).strict();
export const studentGroupingViewSchema = z.object({ groupingMode: z.enum(["none", "self_selection", "finalized"]), draftId: uuidSchema.nullable(), draftState: z.literal("OPEN").nullable(), selectionOpen: z.boolean(), currentGroup: studentGroupingGroupSchema.nullable(), availableGroups: z.array(studentGroupingGroupSchema) }).strict();
export const sessionSyncSchema = z.object({ sessionState: z.enum(["LOBBY", "ACTIVE", "ENDED"]), currentQuestion: questionPublicViewSchema.nullable(), ownLatestSubmission: ownSubmissionResultSchema.nullable(), reveal: questionRevealViewSchema.nullable(), grouping: studentGroupingViewSchema.nullable().optional(), peerReview: peerReviewProjectionSchema.optional() }).strict();

export const serverMessageSchema = z.discriminatedUnion("type", [
  peerReviewChangedSchema,
  peerReviewAcknowledgedSchema,
  peerReviewRejectedSchema,
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
    sessionState: z.enum(["LOBBY", "ACTIVE"]),
  }).strict(),
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("session_state_changed"),
    sessionId: uuidSchema,
    state: z.enum(["ACTIVE", "ENDED"]),
  }).strict(),
  z.object({ protocolVersion: protocolVersionSchema, type: z.literal("session_sync"), sync: sessionSyncSchema }).strict(),
  z.object({ protocolVersion: protocolVersionSchema, type: z.literal("question_state_changed"), question: questionPublicViewSchema }).strict(),
  z.object({ protocolVersion: protocolVersionSchema, type: z.literal("question_revealed"), reveal: questionRevealViewSchema }).strict(),
  z.object({ protocolVersion: protocolVersionSchema, type: z.literal("submission_acknowledged"), acknowledgement: z.object({ submissionId: uuidSchema, sessionQuestionId: uuidSchema, revision: z.number().int().positive(), accepted: z.literal(true), submittedAt: z.string().datetime(), gradingStatus: z.enum(["graded", "pending"]) }).strict() }).strict(),
  z.object({ protocolVersion: protocolVersionSchema, type: z.literal("submission_result"), result: ownSubmissionResultSchema }).strict(),
  z.object({ protocolVersion: protocolVersionSchema, type: z.literal("group_selection_acknowledged"), acknowledgement: z.object({ requestId: requestIdSchema, selectedGroupId: uuidSchema.nullable(), accepted: z.literal(true) }).strict() }).strict(),
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("pong"),
    requestId: requestIdSchema,
  }).strict(),
  z.object({
    protocolVersion: protocolVersionSchema,
    type: z.literal("error"),
    code: z.enum(["PROTOCOL_ERROR", "AUTH_FAILED", "AUTH_TIMEOUT", "SESSION_ENDED", "SERVER_INSTANCE_MISMATCH", "QUESTION_LOCKED", "INVALID_ANSWER", "SUBMISSION_CONFLICT", "GROUP_FULL", "SELF_SELECTION_NOT_OPEN", "GROUP_NOT_FOUND", "STALE_GROUPING_DRAFT"]),
    message: z.string().trim().min(1).max(200),
  }).strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type SessionPublicView = z.infer<typeof sessionPublicViewSchema>;
export type ParticipantSelfView = z.infer<typeof participantSelfViewSchema>;
export type JoinSuccess = z.infer<typeof joinSuccessSchema>;
export type StudentAnswer = z.infer<typeof clientMessageSchema> extends infer Message ? Extract<Message, { type: "submit_answer" }> extends { answer: infer Answer } ? Answer : never : never;
export type QuestionPublicView = z.infer<typeof questionPublicViewSchema>;
export type SessionSync = z.infer<typeof sessionSyncSchema>;
export type StudentGroupingView = z.infer<typeof studentGroupingViewSchema>;

/**
 * The production SessionBackend contract is still deferred. Phase 7 defines
 * only the public local transport handshake and ping/pong protocol.
 */
export type BackendContractMarker = {
  name: "SessionBackend";
  version: typeof BACKEND_CONTRACT_VERSION;
};
