import { afterEach, describe, expect, it, vi } from "vitest";
import { clientMessageSchema, type JoinSuccess, type SessionPublicView } from "@classtools/backend-contract";
import { connectParticipant, requestId, saveParticipant, storedParticipant, STUDENT_HEARTBEAT_INTERVAL_MS, webSocketUrl } from "./studentApi";

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
  readyState = TestWebSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) { TestWebSocket.instances.push(this); }
  send(message: string): void { this.sent.push(message); }
  close(): void { this.readyState = 3; this.onclose?.({} as CloseEvent); }
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

  it("uses a getRandomValues request ID fallback when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", { getRandomValues: (values: Uint32Array) => { values.set([1, 2, 3, 4]); return values; } });
    expect(requestId()).toBe("1-2-3-4");
  });

  it("sends shared-contract participant_auth after server_hello", () => {
    vi.stubGlobal("WebSocket", TestWebSocket);
    const authenticated = vi.fn();
    const disconnected = vi.fn();
    connectParticipant(participant, authenticated, vi.fn(), disconnected);
    const socket = latestSocket();

    expect(socket.url).toMatch(/^ws:\/\/localhost(?::\d+)?\/ws$/);
    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId: session.serverInstanceId });
    const auth = clientMessageSchema.parse(JSON.parse(firstSent(socket)));
    expect(auth).toMatchObject({ type: "participant_auth", sessionId: participant.sessionId, participantId: participant.participantId, credential: participant.credential });

    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: "三年甲班", sessionState: "LOBBY" });
    expect(authenticated).toHaveBeenCalledOnce();
    expect(disconnected).not.toHaveBeenCalled();
  });

  it("preserves the credential for transient socket failure and classifies authoritative failures", () => {
    vi.stubGlobal("WebSocket", TestWebSocket);
    const transient = vi.fn();
    connectParticipant(participant, vi.fn(), vi.fn(), transient);
    latestSocket().networkFailure();
    expect(transient).toHaveBeenCalledWith("transient");

    const rejected = vi.fn();
    connectParticipant(participant, vi.fn(), vi.fn(), rejected);
    latestSocket().message({ protocolVersion: 1, type: "error", code: "AUTH_FAILED", message: "Participant authentication failed." });
    expect(rejected).toHaveBeenCalledWith("AUTH_FAILED");
  });

  it("starts periodic heartbeat after authentication and stops it on disconnect", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", TestWebSocket);
    const disconnect = connectParticipant(participant, vi.fn(), vi.fn(), vi.fn());
    const socket = latestSocket();

    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId: session.serverInstanceId });
    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: "三年甲班", sessionState: "LOBBY" });
    vi.advanceTimersByTime(STUDENT_HEARTBEAT_INTERVAL_MS);
    expect(clientMessageSchema.parse(JSON.parse(socket.sent.at(-1) ?? "{}"))).toMatchObject({ type: "ping" });

    const messageCount = socket.sent.length;
    disconnect();
    vi.advanceTimersByTime(STUDENT_HEARTBEAT_INTERVAL_MS * 2);
    expect(socket.sent).toHaveLength(messageCount);
  });

  it("resumes heartbeat after reconnect authentication and stops it when the session ends", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", TestWebSocket);
    connectParticipant(participant, vi.fn(), vi.fn(), vi.fn());
    const first = latestSocket();
    first.message({ protocolVersion: 1, type: "server_hello", serverInstanceId: session.serverInstanceId });
    first.message({ protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: "三年甲班", sessionState: "LOBBY" });
    first.networkFailure();

    connectParticipant(participant, vi.fn(), vi.fn(), vi.fn());
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

  it("keeps the namespaced credential available for reload reconnect", () => {
    saveParticipant(session, participant);
    expect(storedParticipant(session)).toEqual(participant);
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
