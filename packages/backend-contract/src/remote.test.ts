import { describe, expect, it } from "vitest";
import {
  parseRemoteControlPlaneEnvelope,
  remoteBootstrapSchema,
  remoteCreateSessionRequestSchema,
  parseRemoteStudentEnvelope,
  remoteJoinRequestSchema,
  remoteJoinResultSchema,
  remoteTeacherAuthEnvelopeSchema,
  remoteTeacherRealtimeEnvelopeSchema,
} from "./remote";

describe("Remote Protocol v1 control-plane contract", () => {
  const id = "00000000-0000-4000-8000-000000000000";

  it("accepts only the exact protocol version before control payload processing", () => {
    expect(remoteCreateSessionRequestSchema.parse({ teacherAppVersion: "0.1.0", remoteProtocolVersion: 1 })
      .remoteProtocolVersion).toBe(1);
    expect(remoteCreateSessionRequestSchema.safeParse({ teacherAppVersion: "0.1.0", remoteProtocolVersion: 2 }).success)
      .toBe(false);
    expect(() => parseRemoteControlPlaneEnvelope(JSON.stringify({ v: 2, type: "CONTROL", id,
      payload: { op: "ping" } }))).toThrow();
  });

  it("rejects oversized and malformed envelopes", () => {
    expect(parseRemoteControlPlaneEnvelope(JSON.stringify({ v: 1, type: "CONTROL", id,
      payload: { op: "ping" } })).type).toBe("CONTROL");
    expect(() => parseRemoteControlPlaneEnvelope("x".repeat(64 * 1024 + 1))).toThrow();
    expect(() => parseRemoteControlPlaneEnvelope(JSON.stringify({ v: 1, type: "CONTROL", id,
      payload: { op: "join" } }))).toThrow();
  });

  it("allows only generic public bootstrap fields", () => {
    expect(remoteBootstrapSchema.safeParse({ reachable: true, remoteProtocolVersion: 1,
      status: "available", classroomName: "private" }).success).toBe(false);
  });
});

describe("Remote Protocol v1 join and realtime transport", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const participantId = "00000000-0000-4000-8000-000000000002";
  const connectionId = "00000000-0000-4000-8000-000000000003";
  const remoteSessionId = "A".repeat(32);
  const participant = { sessionId: id, participantId, seatNumber: 1, displayName: "測試" };
  const auth = { protocolVersion: 1, type: "participant_auth", requestId: id, sessionId: id,
    participantId, credential: "A".repeat(43) };
  const make = (type: string, payload: unknown) => JSON.stringify({ v: 1, id, type, payload });

  it("allows only the minimal join request and validates the existing Rust join projection", () => {
    const request = { remoteProtocolVersion: 1, joinAttemptId: id, seatNumber: 1, name: "測試" };
    expect(remoteJoinRequestSchema.parse(request)).toEqual(request);
    expect(remoteJoinRequestSchema.safeParse({ ...request, path: "/arbitrary" }).success).toBe(false);
    expect(remoteJoinRequestSchema.safeParse({ ...request, joinAttemptId: "predictable" }).success).toBe(false);
    expect(remoteJoinResultSchema.safeParse({
      info: { sessionId: id, classroomName: "測試", state: "LOBBY", joinMode: "roster_match",
        serverInstanceId: `remote:${remoteSessionId}`, protocolVersion: 1 },
      participant: { sessionId: id, participantId, credential: "A".repeat(43), participant,
        serverInstanceId: `remote:${remoteSessionId}` },
    }).success).toBe(true);
  });

  it("wraps the original participant AUTH fields without putting routing metadata in Student envelopes", () => {
    expect(parseRemoteStudentEnvelope(make("AUTH", { message: auth })).type).toBe("AUTH");
    expect(() => parseRemoteStudentEnvelope(make("AUTH", { message: auth, connectionId, generation: 1 }))).toThrow();
    expect(remoteTeacherAuthEnvelopeSchema.safeParse({ v: 1, id, type: "AUTH",
      payload: { connectionId, generation: 1, message: auth } }).success).toBe(true);
    expect(() => parseRemoteStudentEnvelope(make("AUTH", { message: { ...auth, credential: "bad" } }))).toThrow();
  });

  it("requires an accepted AUTH response to contain participant_authenticated", () => {
    const message = { protocolVersion: 1, type: "participant_authenticated", participant,
      classroomName: "測試", sessionState: "LOBBY" };
    expect(parseRemoteStudentEnvelope(make("AUTH", { accepted: true, message })).type).toBe("AUTH");
    expect(() => parseRemoteStudentEnvelope(make("AUTH", { accepted: false, message }))).toThrow();
    expect(() => parseRemoteStudentEnvelope(make("AUTH", { accepted: true,
      message: { protocolVersion: 1, type: "error", code: "AUTH_FAILED", message: "失敗" } }))).toThrow();
  });

  it("carries generation in invalidation and rejects Teacher-only control payloads on Student transport", () => {
    expect(parseRemoteStudentEnvelope(make("CONTROL", { op: "REAUTH_REQUIRED", generation: 2 })).type).toBe("CONTROL");
    expect(parseRemoteStudentEnvelope(make("CONTROL", { op: "teacher_offline", generation: 1 })).type).toBe("CONTROL");
    expect(() => parseRemoteStudentEnvelope(make("CONTROL", { op: "REAUTH_REQUIRED" }))).toThrow();
    expect(() => parseRemoteStudentEnvelope(make("CONTROL", { op: "join", generation: 1,
      joinAttemptId: id, seatNumber: 1, name: "測試" }))).toThrow();
  });

  it("reuses existing Quiz, Grouping and Peer Review schemas; AUTH cannot travel as REALTIME", () => {
    const messages = [
      { protocolVersion: 1, type: "submit_answer", requestId: id, submissionId: id,
        sessionQuestionId: id, answer: { type: "true_false", value: true } },
      { protocolVersion: 1, type: "select_group", requestId: id, draftId: id, groupId: null },
      { protocolVersion: 1, type: "submit_peer_review", requestId: id, reviewSubmissionId: id,
        assignmentId: "00000000-0000-7000-8000-000000000001", expectedBaseRevision: 0, body: "評語" },
    ];
    for (const message of messages) {
      expect(parseRemoteStudentEnvelope(make("REALTIME", { message })).type).toBe("REALTIME");
      expect(remoteTeacherRealtimeEnvelopeSchema.safeParse({ v: 1, id, type: "REALTIME",
        payload: { connectionId, generation: 1, message } }).success).toBe(true);
    }
    expect(() => parseRemoteStudentEnvelope(make("REALTIME", { message: auth }))).toThrow();
    expect(() => parseRemoteStudentEnvelope(make("HTTP_RELAY", { path: "/api" }))).toThrow();
  });

  it("preserves the LAN server hello UUID contract and rejects oversized UTF-8 envelopes", () => {
    expect(() => parseRemoteStudentEnvelope(make("REALTIME", { message: { protocolVersion: 1,
      type: "server_hello", serverInstanceId: `remote:${remoteSessionId}` } }))).toThrow();
    expect(() => parseRemoteStudentEnvelope(make("REALTIME", { message: { protocolVersion: 1,
      type: "submit_answer", requestId: id, submissionId: id, sessionQuestionId: id,
      answer: { type: "essay", text: "繁".repeat(22000) } } }))).toThrow("64 KiB");
  });
});
