import { afterEach, describe, expect, it, vi } from "vitest";
import { clientMessageSchema, type JoinSuccess, type SessionPublicView } from "@classtools/backend-contract";
import { createParticipantTransport, secureUuid, saveParticipant, storedParticipant, storedParticipantForJoinCode, STUDENT_HEARTBEAT_INTERVAL_MS, type ParticipantTransport, webSocketUrl } from "./studentApi";

const session: SessionPublicView = {
  sessionId: "019fe91e-7606-7d00-aede-59c50a724f4d",
  classroomName: "三年甲班",
  state: "LOBBY",
  joinMode: "roster_match",
  serverInstanceId: "019fe91f-5d66-7e40-a01b-0a69f36caeff",
  protocolVersion: 1,
};

const participant: JoinSuccess = {
  sessionId: session.sessionId,
  participantId: "019fe920-0e14-7e30-8a9d-367f86c03bcc",
  credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  participant: { participantId: "019fe920-0e14-7e30-8a9d-367f86c03bcc", sessionId: session.sessionId, seatNumber: 1, displayName: "Test" },
  serverInstanceId: session.serverInstanceId,
};

class TestWebSocket {
  static instances: TestWebSocket[] = [];
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  closeCalls = 0;
  sendError: Error | null = null;
  readyState = TestWebSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) { TestWebSocket.instances.push(this); }
  send(message: string): void { if (this.sendError) throw this.sendError; this.sent.push(message); }
  close(): void { this.closeCalls += 1; this.readyState = 3; this.onclose?.({} as CloseEvent); }
  message(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent); }
  networkFailure(): void { this.readyState = 3; this.onerror?.({} as Event); this.onclose?.({} as CloseEvent); }
}

describe("student local transport", () => {
  afterEach(() => {
    vi.useRealTimers();
    TestWebSocket.instances = [];
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("derives the LAN WebSocket URL from the student page origin", () => {
    expect(webSocketUrl({ protocol: "http:", host: "192.168.68.54:49561" })).toBe("ws://192.168.68.54:49561/ws");
    expect(webSocketUrl({ protocol: "https:", host: "classroom.example.test" })).toBe("wss://classroom.example.test/ws");
  });

  it("uses crypto.randomUUID when available", () => {
    const randomUUID = vi.fn(() => "019fe923-090a-7aa0-85dc-c216080117fa");
    const getRandomValues = vi.fn();
    vi.stubGlobal("crypto", { randomUUID, getRandomValues });

    expect(secureUuid()).toBe("019fe923-090a-7aa0-85dc-c216080117fa");
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("creates a canonical UUID v4 with getRandomValues when randomUUID is unavailable", () => {
    const getRandomValues = vi.fn((values: Uint8Array) => {
      expect(values).toBeInstanceOf(Uint8Array);
      expect(values).toHaveLength(16);
      values.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      return values;
    });
    vi.stubGlobal("crypto", { randomUUID: undefined, getRandomValues });

    const submissionId = secureUuid();
    expect(submissionId).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(clientMessageSchema.parse({ protocolVersion: 1, type: "submit_answer", requestId: "request", submissionId, sessionQuestionId: "019fe924-3e72-7d4e-9e4b-5c52f2a3c1d6", answer: { type: "true_false", value: true } })).toMatchObject({ type: "submit_answer", submissionId });
  });

  it("fails in a controlled way when secure Web Crypto is unavailable", () => {
    vi.stubGlobal("crypto", {});

    expect(() => secureUuid()).toThrow("此瀏覽器無法安全產生作答識別碼。");
  });

  it("sends shared-contract participant_auth after server_hello", () => {
    vi.stubGlobal("WebSocket", TestWebSocket);
    const authenticated = vi.fn();
    const disconnected = vi.fn();
    const transport = createParticipantTransport(participant, { onAuthenticated: authenticated, onEnded: vi.fn(), onDisconnected: disconnected });
    transport.start();
    const socket = latestSocket();

    expect(socket.url).toMatch(/^ws:\/\/localhost(?::\d+)?\/ws$/);
    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId: session.serverInstanceId });
    const auth = clientMessageSchema.parse(JSON.parse(firstSent(socket)));
    expect(auth).toMatchObject({ type: "participant_auth", sessionId: participant.sessionId, participantId: participant.participantId, credential: participant.credential });

    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: "三年甲班", sessionState: "LOBBY" });
    expect(authenticated).toHaveBeenCalledOnce();
    expect(disconnected).not.toHaveBeenCalled();
    transport.close();
  });

  it("preserves the credential for transient socket failure and classifies authoritative failures", () => {
    vi.stubGlobal("WebSocket", TestWebSocket);
    const transient = vi.fn();
    const transientTransport = createParticipantTransport(participant, { onAuthenticated: vi.fn(), onEnded: vi.fn(), onDisconnected: transient });
    transientTransport.start();
    latestSocket().networkFailure();
    expect(transient).toHaveBeenCalledWith("transient", expect.objectContaining({ generation: 1 }));

    const rejected = vi.fn();
    const rejectedTransport = createParticipantTransport(participant, { onAuthenticated: vi.fn(), onEnded: vi.fn(), onDisconnected: rejected });
    rejectedTransport.start();
    latestSocket().message({ protocolVersion: 1, type: "error", code: "AUTH_FAILED", message: "Participant authentication failed." });
    expect(rejected).toHaveBeenCalledWith("AUTH_FAILED", expect.objectContaining({ generation: 1 }));
  });

  it("sends the typed submit_answer wire payload and keeps the authenticated socket for submission errors", () => {
    vi.stubGlobal("WebSocket", TestWebSocket);
    const disconnected = vi.fn();
    const transport = createParticipantTransport(participant, { onAuthenticated: vi.fn(), onEnded: vi.fn(), onDisconnected: disconnected });
    transport.start();
    const socket = latestSocket();
    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId: session.serverInstanceId });
    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: "三年甲班", sessionState: "ACTIVE" });

    const submissionId = "019fe923-090a-7aa0-85dc-c216080117fa";
    const sessionQuestionId = "019fe924-3e72-7d4e-9e4b-5c52f2a3c1d6";
    expect(transport.submitAnswer(submissionId, sessionQuestionId, { type: "true_false", value: true })).toBe("sent");
    const submit = clientMessageSchema.parse(JSON.parse(socket.sent.at(-1) ?? "{}"));
    expect(submit).toMatchObject({ type: "submit_answer", submissionId, sessionQuestionId, answer: { type: "true_false", value: true } });
    socket.message({ protocolVersion: 1, type: "error", code: "QUESTION_LOCKED", message: "The question is locked." });
    expect(socket.readyState).toBe(TestWebSocket.OPEN);
    expect(disconnected).not.toHaveBeenCalled();
    transport.close();
  });

  it("keeps the authenticated socket open when submit message construction fails", () => {
    vi.stubGlobal("WebSocket", TestWebSocket);
    const disconnected = vi.fn();
    const transport = createParticipantTransport(participant, { onAuthenticated: vi.fn(), onEnded: vi.fn(), onDisconnected: disconnected });
    transport.start();
    const socket = latestSocket();
    authenticate(socket, "ACTIVE");

    expect(transport.submitAnswer("not-a-uuid", "019fe924-3e72-7d4e-9e4b-5c52f2a3c1d6", { type: "true_false", value: true })).toBe("serialization_failed");
    expect(socket.sent.some((frame) => JSON.parse(frame).type === "submit_answer")).toBe(false);
    expect(socket.closeCalls).toBe(0);
    expect(socket.readyState).toBe(TestWebSocket.OPEN);
    expect(transport.currentConnection()).toEqual({ generation: 1, authenticated: true, readyState: TestWebSocket.OPEN });
    expect(disconnected).not.toHaveBeenCalled();

    expect(transport.submitAnswer("019fe923-090a-7aa0-85dc-c216080117fa", "019fe924-3e72-7d4e-9e4b-5c52f2a3c1d6", { type: "true_false", value: true })).toBe("sent");
    transport.close();
  });

  it("closes and reports a transport failure only when socket.send throws", () => {
    vi.stubGlobal("WebSocket", TestWebSocket);
    const disconnected = vi.fn();
    const transport = createParticipantTransport(participant, { onAuthenticated: vi.fn(), onEnded: vi.fn(), onDisconnected: disconnected });
    transport.start();
    const socket = latestSocket();
    authenticate(socket, "ACTIVE");
    socket.sendError = new Error("send failed");

    expect(transport.submitAnswer("019fe923-090a-7aa0-85dc-c216080117fa", "019fe924-3e72-7d4e-9e4b-5c52f2a3c1d6", { type: "true_false", value: true })).toBe("send_failed");
    expect(socket.closeCalls).toBe(1);
    expect(socket.readyState).toBe(3);
    expect(disconnected).toHaveBeenCalledWith("transient", expect.objectContaining({ generation: 1 }));
  });

  it("keeps the socket alive when a frontend message consumer fails", () => {
    vi.stubGlobal("WebSocket", TestWebSocket);
    const messageError = vi.fn();
    const transport = createParticipantTransport(participant, { onAuthenticated: vi.fn(), onEnded: vi.fn(), onDisconnected: vi.fn(), onMessage: () => { throw new Error("render update failed"); }, onMessageError: messageError });
    transport.start();
    const socket = latestSocket();

    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId: session.serverInstanceId });
    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: "三年甲班", sessionState: "ACTIVE" });
    socket.message({ protocolVersion: 1, type: "submission_acknowledged", acknowledgement: { submissionId: "019fe923-090a-7aa0-85dc-c216080117fa", sessionQuestionId: "019fe924-3e72-7d4e-9e4b-5c52f2a3c1d6", revision: 1, accepted: true, submittedAt: "2026-08-21T00:00:00Z", gradingStatus: "graded" } });

    expect(messageError).toHaveBeenCalledTimes(3);
    expect(socket.readyState).toBe(TestWebSocket.OPEN);
    expect(clientMessageSchema.parse(JSON.parse(firstSent(socket)))).toMatchObject({ type: "participant_auth" });
    transport.close();
  });

  it("starts periodic heartbeat after authentication and stops it on disconnect", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", TestWebSocket);
    const transport = createParticipantTransport(participant, { onAuthenticated: vi.fn(), onEnded: vi.fn(), onDisconnected: vi.fn() });
    transport.start();
    const socket = latestSocket();

    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId: session.serverInstanceId });
    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: "三年甲班", sessionState: "LOBBY" });
    vi.advanceTimersByTime(STUDENT_HEARTBEAT_INTERVAL_MS);
    expect(clientMessageSchema.parse(JSON.parse(socket.sent.at(-1) ?? "{}"))).toMatchObject({ type: "ping" });

    const messageCount = socket.sent.length;
    transport.close();
    vi.advanceTimersByTime(STUDENT_HEARTBEAT_INTERVAL_MS * 2);
    expect(socket.sent).toHaveLength(messageCount);
  });

  it("resumes heartbeat after reconnect authentication and stops it when the session ends", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", TestWebSocket);
    const transport: ParticipantTransport = createParticipantTransport(participant, { onAuthenticated: vi.fn(), onEnded: vi.fn(), onDisconnected: () => transport.start() });
    transport.start();
    const first = latestSocket();
    first.message({ protocolVersion: 1, type: "server_hello", serverInstanceId: session.serverInstanceId });
    first.message({ protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: "三年甲班", sessionState: "LOBBY" });
    first.networkFailure();

    const reconnected = latestSocket();
    reconnected.message({ protocolVersion: 1, type: "server_hello", serverInstanceId: session.serverInstanceId });
    reconnected.message({ protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: "三年甲班", sessionState: "LOBBY" });
    vi.advanceTimersByTime(STUDENT_HEARTBEAT_INTERVAL_MS);
    expect(clientMessageSchema.parse(JSON.parse(reconnected.sent.at(-1) ?? "{}"))).toMatchObject({ type: "ping" });

    const messageCount = reconnected.sent.length;
    reconnected.message({ protocolVersion: 1, type: "session_state_changed", sessionId: participant.sessionId, state: "ENDED" });
    vi.advanceTimersByTime(STUDENT_HEARTBEAT_INTERVAL_MS * 2);
    expect(reconnected.sent).toHaveLength(messageCount);
  });

  it("uses socket B for both inbound events and submit_answer after socket A reconnects", () => {
    vi.stubGlobal("WebSocket", TestWebSocket);
    const inbound: Array<{ type: string; generation: number }> = [];
    const transport: ParticipantTransport = createParticipantTransport(participant, {
      onAuthenticated: vi.fn(),
      onEnded: vi.fn(),
      onDisconnected: (reason) => { if (reason === "transient") transport.start(); },
      onMessage: (message, connection) => {
        if (message.type === "question_state_changed" || message.type === "submission_acknowledged") {
          inbound.push({ type: message.type, generation: connection.generation });
        }
      },
    });
    transport.start();
    const socketA = latestSocket();
    authenticate(socketA, "ACTIVE");
    expect(transport.currentConnection()).toEqual({ generation: 1, authenticated: true, readyState: TestWebSocket.OPEN });

    socketA.networkFailure();
    const socketB = latestSocket();
    expect(socketB).not.toBe(socketA);
    authenticate(socketB, "ACTIVE");
    socketA.message({ protocolVersion: 1, type: "question_state_changed", question: { sessionQuestionId: "019fe924-3e72-7d4e-9e4b-5c52f2a3c1d6", type: "true_false", prompt: "stale", points: 1, state: "OPEN", options: [], blanks: [], assets: [] } });
    socketB.message({ protocolVersion: 1, type: "question_state_changed", question: { sessionQuestionId: "019fe924-3e72-7d4e-9e4b-5c52f2a3c1d6", type: "true_false", prompt: "地球是圓的。", points: 1, state: "OPEN", options: [], blanks: [], assets: [] } });
    expect(transport.currentConnection()).toEqual({ generation: 2, authenticated: true, readyState: TestWebSocket.OPEN });

    const submissionId = "019fe923-090a-7aa0-85dc-c216080117fa";
    const sessionQuestionId = "019fe924-3e72-7d4e-9e4b-5c52f2a3c1d6";
    expect(transport.submitAnswer(submissionId, sessionQuestionId, { type: "true_false", value: true })).toBe("sent");
    expect(socketA.sent.some((frame) => JSON.parse(frame).type === "submit_answer")).toBe(false);
    expect(socketB.sent.filter((frame) => JSON.parse(frame).type === "submit_answer")).toHaveLength(1);

    socketB.message({ protocolVersion: 1, type: "submission_acknowledged", acknowledgement: { submissionId, sessionQuestionId, revision: 1, accepted: true, submittedAt: "2026-08-21T00:00:00Z", gradingStatus: "graded" } });
    expect(inbound).toEqual([
      { type: "question_state_changed", generation: 2 },
      { type: "submission_acknowledged", generation: 2 },
    ]);
    transport.close();
  });

  it("safely replaces an unauthenticated reconnect socket without duplicating transport callbacks", () => {
    vi.stubGlobal("WebSocket", TestWebSocket);
    const disconnected = vi.fn();
    const transport = createParticipantTransport(participant, { onAuthenticated: vi.fn(), onEnded: vi.fn(), onDisconnected: disconnected });
    transport.start();
    const stale = latestSocket();

    expect(transport.retryReconnectNow()).toBe(true);
    const replacement = latestSocket();
    expect(replacement).not.toBe(stale);
    expect(stale.closeCalls).toBe(1);
    stale.message({ protocolVersion: 1, type: "server_hello", serverInstanceId: session.serverInstanceId });
    expect(stale.sent).toHaveLength(0);
    expect(disconnected).not.toHaveBeenCalled();

    authenticate(replacement, "ACTIVE");
    expect(transport.retryReconnectNow()).toBe(false);
    expect(TestWebSocket.instances).toHaveLength(2);
    transport.close();
  });

  it("keeps the namespaced credential and non-secret resume pointer available for reload reconnect", () => {
    saveParticipant(session, participant, "ab7k9m2q");
    expect(storedParticipant(session)).toEqual(participant);
    expect(storedParticipantForJoinCode("AB7K9M2Q")).toEqual({ info: session, participant });
    const resume = localStorage.getItem("classroom.resume.v1.AB7K9M2Q");
    expect(resume).toContain(session.sessionId);
    expect(resume).not.toContain(participant.credential);
  });

  it("sends an authenticated group selection through the existing WebSocket only", () => {
    vi.stubGlobal("WebSocket", TestWebSocket);
    const transport = createParticipantTransport(participant, { onAuthenticated: vi.fn(), onEnded: vi.fn(), onDisconnected: vi.fn() });
    transport.start();
    const socket = latestSocket();
    authenticate(socket, "ACTIVE");

    expect(transport.selectGroup("019fe926-914b-7ea1-8f27-a6494761aac9", "019fe927-58b7-7bf0-bc08-b381969e4d2f")).toBe("sent");
    expect(TestWebSocket.instances).toHaveLength(1);
    expect(clientMessageSchema.parse(JSON.parse(socket.sent.at(-1) ?? "{}"))).toMatchObject({
      type: "select_group",
      draftId: "019fe926-914b-7ea1-8f27-a6494761aac9",
      groupId: "019fe927-58b7-7bf0-bc08-b381969e4d2f",
    });
    transport.close();
  });
});

function latestSocket(): TestWebSocket {
  const socket = TestWebSocket.instances.at(-1);
  if (!socket) throw new Error("expected WebSocket instance");
  return socket;
}

function firstSent(socket: TestWebSocket): string {
  const message = socket.sent.at(0);
  if (!message) throw new Error("expected WebSocket message");
  return message;
}

function authenticate(socket: TestWebSocket, sessionState: "LOBBY" | "ACTIVE"): void {
  socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId: session.serverInstanceId });
  socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: session.classroomName, sessionState });
}
