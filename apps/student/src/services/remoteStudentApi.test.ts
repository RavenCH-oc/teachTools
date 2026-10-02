import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteStudentEnvelopeSchema, type JoinSuccess, type SessionPublicView } from "@classtools/backend-contract";
import { createStudentTransport, getRemoteJoinShell, joinRemoteClassroom } from "./remoteStudentApi";
import { fetchSessionAsset, saveParticipant, storedParticipantForJoinCode, STUDENT_HEARTBEAT_INTERVAL_MS } from "./studentApi";
import { getPeerReviewActivities, getPeerReviewEssays, getPeerReviewFeedbackDetail } from "./peerReviewApi";

const locator = "aBCdefghijklmnopqrstuvwxyz012345";
const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
const id = "019fe923-090a-7aa0-85dc-c216080117fa";
const info: SessionPublicView = { sessionId, serverInstanceId: `remote:${locator}`, classroomName: "測試課堂", state: "LOBBY", joinMode: "roster_match", protocolVersion: 1 };
const participant: JoinSuccess = { sessionId, serverInstanceId: info.serverInstanceId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { sessionId, participantId, seatNumber: 1, displayName: "測試學生" } };
const authenticated = { protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: info.classroomName, sessionState: "ACTIVE" };
const sync = { protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: null, ownLatestSubmission: null, reveal: null, grouping: null, peerReview: { available: true, visibleActivityCount: 1, receivedFeedbackCount: 0 } } };

class RemoteSocket {
  static readonly OPEN = 1;
  static instances: RemoteSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(readonly url: string) { RemoteSocket.instances.push(this); }
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 } as CloseEvent); }
  message(type: string, payload: unknown, v = 1) { this.onmessage?.({ data: JSON.stringify({ v, id, type, payload }) } as MessageEvent); }
}
function socket(): RemoteSocket { const value = RemoteSocket.instances.at(-1); if (!value) throw new Error("socket missing"); return value; }
function start() {
  vi.stubGlobal("WebSocket", RemoteSocket);
  const callbacks = { onAuthenticated: vi.fn(), onEnded: vi.fn(), onDisconnected: vi.fn(), onMessage: vi.fn(), onUnavailable: vi.fn() };
  const transport = createStudentTransport(participant, callbacks);
  transport.start(); socket().onopen?.();
  return { transport, callbacks };
}
function accept(value: RemoteSocket = socket()) { value.message("AUTH", { accepted: true, message: authenticated }); value.message("REALTIME", { message: sync }); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); RemoteSocket.instances = []; });

describe("Remote Student transport", () => {
  it("keeps public bootstrap generic and sends identity only in the join POST body", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ reachable: true, remoteProtocolVersion: 1, status: "available" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ info, participant })));
    vi.stubGlobal("fetch", fetchMock);
    await getRemoteJoinShell(locator);
    expect(await joinRemoteClassroom(locator, id, 1, "測試學生")).toEqual({ info, participant });
    const [path, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(path).toBe(`/v1/sessions/${locator}/join`);
    expect(path).not.toContain(participant.credential);
    expect(JSON.parse(String(init.body))).toEqual({ remoteProtocolVersion: 1, joinAttemptId: id, seatNumber: 1, name: "測試學生" });
  });
  it("stores a case-sensitive Remote resume locator without credential in its pointer", () => {
    saveParticipant(info, participant, locator);
    expect(storedParticipantForJoinCode(locator)).toEqual({ info, participant });
    expect(storedParticipantForJoinCode(locator.toUpperCase())).toBeNull();
    expect(localStorage.getItem(`classroom.resume.remote.v1.${locator}`)).not.toContain(participant.credential);
  });
  it("sends AUTH as first frame without credential in URL and waits for personalized sync", () => {
    const { transport, callbacks } = start();
    expect(socket().url).toContain(`/v1/sessions/${locator}/ws`);
    expect(socket().url).not.toContain(participant.credential);
    expect(remoteStudentEnvelopeSchema.parse(JSON.parse(socket().sent[0]!))).toMatchObject({ type: "AUTH", payload: { message: { type: "participant_auth", credential: participant.credential } } });
    socket().message("REALTIME", { message: sync });
    expect(callbacks.onMessage).not.toHaveBeenCalled();
    socket().message("AUTH", { accepted: true, message: authenticated });
    expect(callbacks.onAuthenticated).not.toHaveBeenCalled();
    expect(transport.submitAnswer(id, sessionId, { type: "true_false", value: true })).toBe("transport_unavailable");
    socket().message("REALTIME", { message: sync });
    expect(callbacks.onAuthenticated).toHaveBeenCalledOnce();
    expect(callbacks.onMessage.mock.calls.at(-1)?.[0].type).toBe("session_sync");
    transport.close();
  });
  it("transports Quiz, Grouping and bounded Peer Review using the existing messages", () => {
    const { transport } = start(); accept();
    expect(transport.submitAnswer(id, sessionId, { type: "true_false", value: true })).toBe("sent");
    expect(transport.selectGroup(sessionId, participantId)).toBe("sent");
    expect(transport.sendPeerReview({ protocolVersion: 1, type: "submit_peer_review", requestId: id, reviewSubmissionId: id, assignmentId: sessionId, expectedBaseRevision: 1, body: "回饋" })).toBe("sent");
    expect(socket().sent.slice(1).map(raw => JSON.parse(raw).payload.message.type)).toEqual(["submit_answer", "select_group", "submit_peer_review"]);
    transport.close();
  });
  it("pauses mutations/heartbeat offline and reauthenticates on the same socket before resume", () => {
    vi.useFakeTimers(); const { transport, callbacks } = start(); accept();
    vi.advanceTimersByTime(STUDENT_HEARTBEAT_INTERVAL_MS);
    expect(JSON.parse(socket().sent.at(-1)!).payload.message.type).toBe("ping");
    socket().message("CONTROL", { op: "teacher_offline", generation: 1 });
    const count = socket().sent.length;
    vi.advanceTimersByTime(STUDENT_HEARTBEAT_INTERVAL_MS * 2);
    expect(socket().sent).toHaveLength(count);
    expect(transport.selectGroup(sessionId, participantId)).toBe("transport_unavailable");
    socket().message("CONTROL", { op: "REAUTH_REQUIRED", generation: 2 });
    expect(JSON.parse(socket().sent.at(-1)!).type).toBe("AUTH");
    expect(transport.currentConnection()?.authenticated).toBe(false);
    socket().message("AUTH", { accepted: true, message: authenticated });
    expect(callbacks.onAuthenticated).toHaveBeenCalledTimes(1);
    socket().message("REALTIME", { message: sync });
    expect(callbacks.onAuthenticated).toHaveBeenCalledTimes(2);
    expect(RemoteSocket.instances).toHaveLength(1);
    expect(callbacks.onUnavailable).toHaveBeenCalledTimes(2);
    transport.close();
  });
  it("reconnects with AUTH and ignores old socket messages", () => {
    const { transport, callbacks } = start(); const old = socket(); accept(); old.close();
    transport.start(); const current = socket(); current.onopen?.(); callbacks.onMessage.mockClear();
    old.message("REALTIME", { message: sync }); expect(callbacks.onMessage).not.toHaveBeenCalled();
    expect(JSON.parse(current.sent[0]!).type).toBe("AUTH"); accept(current);
    expect(transport.currentConnection()?.generation).toBe(2); transport.close();
  });
  it("classifies protocol mismatch and does not enter the Classroom domain", () => {
    const { transport, callbacks } = start(); socket().message("AUTH", { accepted: true, message: authenticated }, 2);
    expect(callbacks.onDisconnected).toHaveBeenCalledWith("PROTOCOL_MISMATCH", expect.anything());
    expect(callbacks.onMessage).not.toHaveBeenCalled(); transport.close();
  });
  it("rejects malformed AUTH and a mismatched participant identity", () => {
    let setup = start(); socket().message("AUTH", { accepted: true, message: { ...authenticated, participant: { ...participant.participant, participantId: sessionId } } });
    expect(setup.callbacks.onDisconnected).toHaveBeenCalledWith("AUTH_FAILED", expect.anything()); setup.transport.close();
    setup = start(); socket().message("AUTH", { accepted: false, message: authenticated });
    expect(setup.callbacks.onAuthenticated).not.toHaveBeenCalled(); expect(socket().readyState).toBe(3); setup.transport.close();
  });
  it("enforces the UTF-8 envelope ceiling before sending or accepting messages", () => {
    const { transport, callbacks } = start(); accept();
    expect(transport.submitAnswer(id, sessionId, { type: "essay", text: "中".repeat(23000) })).toBe("serialization_failed");
    socket().message("REALTIME", { message: sync, padding: "中".repeat(23000) });
    expect(callbacks.onDisconnected).toHaveBeenCalledWith("MESSAGE_TOO_LARGE", expect.anything()); transport.close();
  });
  it("treats the relay size error as a controlled content limit rather than a transient failure", () => {
    const { transport, callbacks } = start(); socket().message("ERROR", { kind: "transport", code: "MESSAGE_TOO_LARGE", retryable: false });
    expect(callbacks.onDisconnected).toHaveBeenCalledWith("MESSAGE_TOO_LARGE", expect.anything());
    expect(callbacks.onAuthenticated).not.toHaveBeenCalled(); transport.close();
  });
  it("blocks all unavailable detail/media HTTP before fetch rather than falling back to LAN", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    for (const request of [fetchSessionAsset(sessionId, participant), getPeerReviewActivities(participant), getPeerReviewEssays(participant, sessionId), getPeerReviewFeedbackDetail(participant, sessionId)]) {
      await expect(request).rejects.toMatchObject({ code: "REMOTE_DETAIL_UNAVAILABLE" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("F2/F3 handles proactive Teacher controls while the Student is idle without a mutation or polling", () => {
    vi.useFakeTimers(); const { transport, callbacks } = start(); accept();
    const currentSocket = socket(); const initialFrames = currentSocket.sent.length;
    currentSocket.message("CONTROL", { op: "teacher_offline", generation: 1 });
    expect(callbacks.onUnavailable).toHaveBeenLastCalledWith(expect.objectContaining({ authenticated: false, readyState: RemoteSocket.OPEN }));
    expect(transport.currentConnection()?.authenticated).toBe(false);
    vi.advanceTimersByTime(STUDENT_HEARTBEAT_INTERVAL_MS * 3);
    expect(currentSocket.sent).toHaveLength(initialFrames);

    currentSocket.message("CONTROL", { op: "REAUTH_REQUIRED", generation: 2 });
    expect(currentSocket.sent).toHaveLength(initialFrames + 1);
    expect(JSON.parse(currentSocket.sent.at(-1)!)).toMatchObject({ type: "AUTH", payload: { message: { sessionId, participantId, credential: participant.credential } } });
    currentSocket.message("AUTH", { accepted: true, message: authenticated });
    expect(callbacks.onAuthenticated).toHaveBeenCalledTimes(1);
    expect(transport.currentConnection()?.authenticated).toBe(false);
    currentSocket.message("REALTIME", { message: sync });
    expect(callbacks.onAuthenticated).toHaveBeenCalledTimes(2);
    expect(transport.currentConnection()?.authenticated).toBe(true);
    expect(RemoteSocket.instances).toEqual([currentSocket]);
    vi.advanceTimersByTime(STUDENT_HEARTBEAT_INTERVAL_MS);
    expect(JSON.parse(currentSocket.sent.at(-1)!).payload.message.type).toBe("ping");
    expect(currentSocket.sent.map(raw => JSON.parse(raw).payload.message.type)).toEqual(["participant_auth", "participant_auth", "ping"]);
    transport.close();
  });
});
