import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassroomStudentApp } from "./App";
import { saveParticipant } from "./services/studentApi";

const locator = "aBCdefghijklmnopqrstuvwxyz012345";
const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
const id = "019fe923-090a-7aa0-85dc-c216080117fa";
const info = { sessionId, serverInstanceId: `remote:${locator}`, classroomName: "私有課堂名稱", state: "LOBBY" as const, joinMode: "roster_match" as const, protocolVersion: 1 as const };
const participant = { sessionId, serverInstanceId: info.serverInstanceId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { sessionId, participantId, seatNumber: 1, displayName: "測試學生" } };
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
  message(type: string, payload: unknown) { this.onmessage?.({ data: JSON.stringify({ v: 1, id, type, payload }) } as MessageEvent); }
}
function socket() { const result = RemoteSocket.instances.at(-1); if (!result) throw new Error("socket missing"); return result; }
function publicResponse(version = 1, status = "available") { return new Response(JSON.stringify({ reachable: true, remoteProtocolVersion: version, status })); }
function join() { fireEvent.change(screen.getByLabelText("座號"), { target: { value: "1" } }); fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "測試學生" } }); fireEvent.click(screen.getByRole("button", { name: "加入課堂" })); }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); RemoteSocket.instances = []; window.history.pushState({}, "", "/"); });

describe("Remote Student application", () => {
  it("shows the existing identity form with no private state before join and stores a successful credential", async () => {
    window.history.pushState({}, "", `/join/${locator}`); vi.stubGlobal("WebSocket", RemoteSocket);
    const fetchMock = vi.fn().mockResolvedValueOnce(publicResponse()).mockResolvedValueOnce(new Response(JSON.stringify({ info, participant })));
    vi.stubGlobal("fetch", fetchMock); render(<ClassroomStudentApp remote />);
    await screen.findByRole("heading", { name: "加入課堂" });
    expect(screen.queryByText(info.classroomName)).not.toBeInTheDocument(); expect(screen.queryByText("測試學生")).not.toBeInTheDocument();
    join(); await screen.findByRole("heading", { name: "正在驗證登入狀態…" });
    expect(localStorage.getItem(`classroom.participant.${info.serverInstanceId}.${sessionId}`)).toContain(participant.credential);
    expect(fetchMock.mock.calls.every(([path]) => !String(path).includes(participant.credential))).toBe(true);
    act(() => { socket().onopen?.(); socket().message("AUTH", { accepted: true, message: { protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: info.classroomName, sessionState: "LOBBY" } }); socket().message("REALTIME", { message: { protocolVersion: 1, type: "session_sync", sync: { sessionState: "LOBBY", currentQuestion: null, ownLatestSubmission: null, reveal: null } } }); });
    expect(await screen.findByRole("heading", { name: "已加入課堂" })).toBeInTheDocument();
  });
  it("reuses a logical join attempt after response loss and changes it when identity changes", async () => {
    window.history.pushState({}, "", `/join/${locator}`);
    const fetchMock = vi.fn().mockResolvedValueOnce(publicResponse()).mockRejectedValue(new TypeError("network")); vi.stubGlobal("fetch", fetchMock);
    render(<ClassroomStudentApp remote />); await screen.findByRole("heading", { name: "加入課堂" }); join();
    await screen.findByRole("alert"); fireEvent.click(screen.getByRole("button", { name: "加入課堂" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3)); await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "另一位" } }); fireEvent.click(screen.getByRole("button", { name: "加入課堂" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const attempts = fetchMock.mock.calls.slice(1).map(([, init]) => JSON.parse(String((init as RequestInit).body)).joinAttemptId);
    expect(attempts[0]).toBe(attempts[1]); expect(attempts[2]).not.toBe(attempts[1]);
  });
  it("shows controlled version/Teacher offline errors in the public shell", async () => {
    window.history.pushState({}, "", `/join/${locator}`); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(publicResponse(2)));
    const view = render(<ClassroomStudentApp remote />);
    expect(await screen.findByText("遠端課堂版本不相容，請更新頁面並確認老師使用相同版本。")).toBeInTheDocument();
    view.unmount(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(publicResponse(1, "unavailable")));
    render(<ClassroomStudentApp remote />); expect(await screen.findByText("老師的遠端課堂暫時無法使用，請稍後再試。")).toBeInTheDocument();
  });
  it("resumes stored Remote identity, pauses UI offline and restores the same Quiz on reauth", async () => {
    window.history.pushState({}, "", `/join/${locator}`); saveParticipant(info, participant, locator);
    vi.stubGlobal("WebSocket", RemoteSocket); const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); render(<ClassroomStudentApp remote />);
    await waitFor(() => expect(RemoteSocket.instances).toHaveLength(1));
    const auth = { accepted: true, message: { protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: info.classroomName, sessionState: "ACTIVE" } };
    const sync = { message: { protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: { sessionQuestionId: id, type: "true_false", prompt: "測試題目", points: 1, state: "OPEN", options: [], blanks: [], assets: [] }, ownLatestSubmission: null, reveal: null, peerReview: { available: true, visibleActivityCount: 1, receivedFeedbackCount: 0 } } } };
    act(() => { socket().onopen?.(); socket().message("AUTH", auth); socket().message("REALTIME", sync); });
    expect(await screen.findByText("測試題目")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => socket().message("CONTROL", { op: "teacher_offline", generation: 1 }));
    expect(screen.getByRole("button", { name: "正確" })).toBeDisabled();
    act(() => socket().message("CONTROL", { op: "REAUTH_REQUIRED", generation: 2 }));
    expect(screen.getByRole("button", { name: "正確" })).toBeDisabled();
    act(() => { socket().message("AUTH", auth); socket().message("REALTIME", sync); });
    expect(screen.getByRole("button", { name: "正確" })).not.toBeDisabled();
    expect(RemoteSocket.instances).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "同儕互評" }));
    expect(await screen.findByText("遠端課堂目前不支援作品詳情、互評詳情與媒體附件；此功能將於後續階段提供。")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("retries an unacknowledged Quiz with the original submissionId only after reauth sync", async () => {
    window.history.pushState({}, "", `/join/${locator}`); saveParticipant(info, participant, locator); vi.stubGlobal("WebSocket", RemoteSocket);
    render(<ClassroomStudentApp remote />); await waitFor(() => expect(RemoteSocket.instances).toHaveLength(1));
    const auth = { accepted: true, message: { protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: info.classroomName, sessionState: "ACTIVE" } };
    const sync = { message: { protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: { sessionQuestionId: id, type: "true_false", prompt: "ACK 測試", points: 1, state: "OPEN", options: [], blanks: [], assets: [] }, ownLatestSubmission: null, reveal: null } } };
    act(() => { socket().onopen?.(); socket().message("AUTH", auth); socket().message("REALTIME", sync); });
    fireEvent.click(screen.getByRole("button", { name: "正確" })); fireEvent.click(screen.getByRole("button", { name: "送出答案" }));
    const submissions = () => socket().sent.map(raw => JSON.parse(raw).payload.message).filter(message => message.type === "submit_answer");
    expect(submissions()).toHaveLength(1); const original = submissions()[0].submissionId;
    act(() => socket().message("CONTROL", { op: "teacher_offline", generation: 1 }));
    expect(screen.queryByText("答案已送出。")).not.toBeInTheDocument();
    act(() => { socket().message("CONTROL", { op: "REAUTH_REQUIRED", generation: 2 }); socket().message("AUTH", auth); });
    expect(submissions()).toHaveLength(1);
    act(() => socket().message("REALTIME", sync)); expect(submissions()).toHaveLength(2);
    expect(submissions()[1].submissionId).toBe(original);
    act(() => socket().message("REALTIME", { message: { protocolVersion: 1, type: "submission_acknowledged", acknowledgement: { submissionId: original, sessionQuestionId: id, revision: 1, accepted: true, submittedAt: "2026-10-01T00:00:00Z", gradingStatus: "graded" } } }));
    expect(await screen.findByText("答案已送出。")).toBeInTheDocument();
    expect(screen.queryByText(/得分/)).not.toBeInTheDocument();
  });
  it("preserves the credential and stops automatic reconnect when personalized content exceeds the Remote ceiling", async () => {
    window.history.pushState({}, "", `/join/${locator}`); saveParticipant(info, participant, locator); vi.stubGlobal("WebSocket", RemoteSocket);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    render(<ClassroomStudentApp remote />); await waitFor(() => expect(RemoteSocket.instances).toHaveLength(1));
    vi.useFakeTimers();
    act(() => { socket().onopen?.(); socket().message("ERROR", { kind: "transport", code: "MESSAGE_TOO_LARGE", retryable: false }); });
    expect(screen.getByRole("heading", { name: "遠端課堂內容暫時無法顯示" })).toBeInTheDocument();
    expect(screen.getByText("此內容超過遠端即時傳輸上限，詳細內容需後續階段支援。")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(30000));
    expect(RemoteSocket.instances).toHaveLength(1);
    expect(localStorage.getItem(`classroom.participant.${info.serverInstanceId}.${sessionId}`)).toContain(participant.credential);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["LOBBY", "ACTIVE"] as const)("F2/F3 proactively updates an idle %s Student on Teacher offline and reauth push", async sessionState => {
    window.history.pushState({}, "", `/join/${locator}`); saveParticipant(info, participant, locator);
    vi.stubGlobal("WebSocket", RemoteSocket); const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    render(<ClassroomStudentApp remote />); await waitFor(() => expect(RemoteSocket.instances).toHaveLength(1));
    const auth = { accepted: true, message: { protocolVersion: 1, type: "participant_authenticated", participant: participant.participant, classroomName: info.classroomName, sessionState } };
    const personalizedSync = { message: { protocolVersion: 1, type: "session_sync", sync: { sessionState, currentQuestion: null, ownLatestSubmission: null, reveal: null } } };
    act(() => { socket().onopen?.(); socket().message("AUTH", auth); socket().message("REALTIME", personalizedSync); });
    const connectedText = sessionState === "ACTIVE" ? "已連線" : "等待老師開始課堂…";
    expect(screen.getByText(connectedText)).toBeInTheDocument();
    const savedCredential = localStorage.getItem(`classroom.participant.${info.serverInstanceId}.${sessionId}`);
    const framesBeforeOffline = socket().sent.length;
    vi.useFakeTimers();

    // From this point, every stimulus is a server-pushed message or elapsed
    // time; the Student never clicks, submits, refreshes, or sends a mutation.
    act(() => socket().message("CONTROL", { op: "teacher_offline", generation: 1 }));
    expect(screen.getByText("連線中斷，正在重新連線…")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(9000));
    expect(socket().sent).toHaveLength(framesBeforeOffline);
    expect(RemoteSocket.instances).toHaveLength(1);

    act(() => socket().message("CONTROL", { op: "REAUTH_REQUIRED", generation: 2 }));
    expect(socket().sent).toHaveLength(framesBeforeOffline + 1);
    expect(JSON.parse(socket().sent.at(-1)!)).toMatchObject({ type: "AUTH", payload: { message: { type: "participant_auth", participantId, sessionId, credential: participant.credential } } });
    act(() => socket().message("AUTH", auth));
    expect(screen.getByText("連線中斷，正在重新連線…")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(9000));
    expect(socket().sent).toHaveLength(framesBeforeOffline + 1);
    act(() => socket().message("REALTIME", personalizedSync));
    expect(screen.getByText(connectedText)).toBeInTheDocument();
    expect(screen.queryByText("連線中斷，正在重新連線…")).not.toBeInTheDocument();
    expect(RemoteSocket.instances).toHaveLength(1);
    expect(localStorage.getItem(`classroom.participant.${info.serverInstanceId}.${sessionId}`)).toBe(savedCredential);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
