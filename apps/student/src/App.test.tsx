import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientMessageSchema, serverMessageSchema, type StudentGroupingView } from "@classtools/backend-contract";
import { App } from "./App";
import { saveParticipant, storedParticipantForJoinCode } from "./services/studentApi";

class StudentWebSocket {
  static instances: StudentWebSocket[] = [];
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  closeCalls = 0;
  readyState = StudentWebSocket.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) { StudentWebSocket.instances.push(this); }
  send(message: string): void { this.sent.push(message); }
  close(): void { this.closeCalls += 1; this.readyState = 3; this.onclose?.({} as CloseEvent); }
  message(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent); }
  networkFailure(): void { this.readyState = 3; this.onclose?.({} as CloseEvent); }
}

describe("Student application shell", () => {
  afterEach(() => { cleanup(); localStorage.clear(); StudentWebSocket.instances = []; vi.useRealTimers(); vi.unstubAllGlobals(); window.history.pushState({}, "", "/"); });
  it("renders the manual classroom-code fallback", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Classroom" })).toBeInTheDocument();
    expect(screen.getByText("請輸入老師提供的課堂代碼。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往課堂" })).toBeInTheDocument();
  });

  it("loads a join page without exposing a roster", async () => {
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: "019fe91e-7606-7d00-aede-59c50a724f4d", classroomName: "三年甲班", state: "LOBBY", joinMode: "roster_match", serverInstanceId: "019fe91f-5d66-7e40-a01b-0a69f36caeff", protocolVersion: 1 }), { status: 200 })));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "加入課堂" })).toBeInTheDocument();
    expect(screen.getByText("三年甲班")).toBeInTheDocument();
    expect(screen.queryByText("王小明")).not.toBeInTheDocument();
    expect(screen.getByLabelText("座號").closest(".student-field")).toHaveTextContent("座號");
    expect(screen.getByLabelText("姓名").closest(".student-field")).toHaveTextContent("姓名");
  });

  it("keeps incomplete identity input on the join form", async () => {
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: "019fe91e-7606-7d00-aede-59c50a724f4d", classroomName: "三年甲班", state: "LOBBY", joinMode: "roster_match", serverInstanceId: "019fe91f-5d66-7e40-a01b-0a69f36caeff", protocolVersion: 1 }), { status: 200 })));
    render(<App />);
    await screen.findByRole("heading", { name: "加入課堂" });
    fireEvent.click(screen.getByRole("button", { name: "加入課堂" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("請輸入正確的座號與姓名。"));
  });

  it("stores a successful HTTP join credential before authenticating the WebSocket", async () => {
    const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
    const serverInstanceId = "019fe91f-5d66-7e40-a01b-0a69f36caeff";
    const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId, classroomName: "三年甲班", state: "LOBBY", joinMode: "roster_match", serverInstanceId, protocolVersion: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, serverInstanceId }), { status: 200 })));
    vi.stubGlobal("WebSocket", StudentWebSocket);
    render(<App />);
    await screen.findByRole("heading", { name: "加入課堂" });
    fireEvent.change(screen.getByLabelText("座號"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "Test" } });
    fireEvent.click(screen.getByRole("button", { name: "加入課堂" }));

    await waitFor(() => expect(localStorage.getItem(`classroom.participant.${serverInstanceId}.${sessionId}`)).toContain("AAAAAAAA"));
    const resume = localStorage.getItem("classroom.resume.v1.AB7K9M2Q");
    expect(resume).toContain(sessionId);
    expect(resume).not.toContain("AAAAAAAA");
    await waitFor(() => expect(StudentWebSocket.instances).toHaveLength(1));
    const socket = latestSocket();
    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
    expect(clientMessageSchema.parse(JSON.parse(firstSent(socket)))).toMatchObject({ type: "participant_auth", participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, classroomName: "三年甲班", sessionState: "LOBBY" });
    expect(await screen.findByRole("heading", { name: "已加入課堂" })).toBeInTheDocument();
  });

  it("restores an ACTIVE session from its stored credential without calling the closed join endpoint", async () => {
    const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
    const serverInstanceId = "019fe91f-5d66-7e40-a01b-0a69f36caeff";
    const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
    const sessionQuestionId = "019fe923-090a-7aa0-85dc-c216080117fa";
    const info = { sessionId, classroomName: "三年甲班", state: "LOBBY" as const, joinMode: "roster_match" as const, serverInstanceId, protocolVersion: 1 as const };
    const joined = { sessionId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, serverInstanceId };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "SESSION_NOT_OPEN", message: "課堂目前未開放新加入。" }), { status: 409 }));
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    saveParticipant(info, joined, "AB7K9M2Q");
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", StudentWebSocket);
    render(<App />);

    expect(await screen.findByText("正在恢復課堂…")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    const socket = await waitForSocket();
    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
    expect(clientMessageSchema.parse(JSON.parse(firstSent(socket)))).toMatchObject({ type: "participant_auth", sessionId, participantId, credential: joined.credential });
    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: joined.participant, classroomName: info.classroomName, sessionState: "ACTIVE" });
    socket.message({ protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: { sessionQuestionId, type: "true_false", prompt: "地球是圓的。", points: 1, state: "OPEN", options: [], blanks: [], assets: [] }, ownLatestSubmission: { submissionId: "019fe925-8c94-7d5e-8e52-d4706e87f65e", revision: 1, gradingStatus: "graded", isCorrect: true, score: 1, maxScore: 1, answer: { type: "true_false", value: true } }, reveal: null } });

    expect(await screen.findByText("地球是圓的。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正確" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "錯誤" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "更新答案" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "加入課堂" })).not.toBeInTheDocument();
  });

  it("shows a no-new-join message when an ACTIVE session has no stored credential", async () => {
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "SESSION_NOT_OPEN", message: "課堂目前未開放新加入。" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", StudentWebSocket);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "無法加入課堂" })).toBeInTheDocument();
    expect(screen.getByText("課堂目前未開放新加入。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(StudentWebSocket.instances).toHaveLength(0);
  });

  it("reconnects a stored credential, keeps it after a transient failure, and clears it after AUTH_FAILED", async () => {
    const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
    const serverInstanceId = "019fe91f-5d66-7e40-a01b-0a69f36caeff";
    const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
    const info = { sessionId, classroomName: "三年甲班", state: "LOBBY" as const, joinMode: "roster_match" as const, serverInstanceId, protocolVersion: 1 as const };
    const joined = { sessionId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, serverInstanceId };
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    saveParticipant(info, joined, "AB7K9M2Q");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "SESSION_NOT_OPEN", message: "課堂目前未開放新加入。" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", StudentWebSocket);
    render(<App />);
    expect(await screen.findByText("正在恢復課堂…")).toBeInTheDocument();
    await waitFor(() => expect(StudentWebSocket.instances).toHaveLength(1));
    vi.useFakeTimers();
    await act(async () => {
      latestSocket().networkFailure();
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(localStorage.getItem(`classroom.participant.${serverInstanceId}.${sessionId}`)).toContain("AAAAAAAA");
    expect(storedParticipantForJoinCode("AB7K9M2Q")).toEqual({ info, participant: joined });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => { latestSocket().message({ protocolVersion: 1, type: "error", code: "AUTH_FAILED", message: "Participant authentication failed." }); });
    expect(localStorage.getItem(`classroom.participant.${serverInstanceId}.${sessionId}`)).toBeNull();
    expect(storedParticipantForJoinCode("AB7K9M2Q")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("登入狀態已失效，請重新加入課堂。");
  });

  it("uses the browser online hint to replace an unauthenticated reconnect socket immediately", async () => {
    const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
    const serverInstanceId = "019fe91f-5d66-7e40-a01b-0a69f36caeff";
    const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
    const sessionQuestionId = "019fe923-090a-7aa0-85dc-c216080117fa";
    const info = { sessionId, classroomName: "三年甲班", state: "LOBBY" as const, joinMode: "roster_match" as const, serverInstanceId, protocolVersion: 1 as const };
    const joined = { sessionId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, serverInstanceId };
    const fetchMock = vi.fn();
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    saveParticipant(info, joined, "AB7K9M2Q");
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", StudentWebSocket);
    render(<App />);
    const socketA = await waitForSocket();
    socketA.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
    socketA.message({ protocolVersion: 1, type: "participant_authenticated", participant: joined.participant, classroomName: info.classroomName, sessionState: "ACTIVE" });
    socketA.message({ protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: { sessionQuestionId, type: "true_false", prompt: "網路恢復題目", points: 1, state: "OPEN", options: [], blanks: [], assets: [] }, ownLatestSubmission: null, reveal: null } });
    await screen.findByText("網路恢復題目");

    vi.useFakeTimers();
    await act(async () => { socketA.networkFailure(); await vi.advanceTimersByTimeAsync(1000); });
    const socketB = latestSocket();
    expect(socketB).not.toBe(socketA);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    const socketC = latestSocket();
    expect(socketC).not.toBe(socketB);
    expect(socketB.closeCalls).toBe(1);

    await act(async () => {
      socketC.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
      socketC.message({ protocolVersion: 1, type: "participant_authenticated", participant: joined.participant, classroomName: info.classroomName, sessionState: "ACTIVE" });
      socketC.message({ protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: { sessionQuestionId, type: "true_false", prompt: "網路恢復題目", points: 1, state: "OPEN", options: [], blanks: [], assets: [] }, ownLatestSubmission: null, reveal: null } });
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(StudentWebSocket.instances).toHaveLength(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the getRandomValues UUID fallback for a True/False submission and completes the shared-contract ACK", async () => {
    const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
    const serverInstanceId = "019fe91f-5d66-7e40-a01b-0a69f36caeff";
    const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
    const sessionQuestionId = "019fe923-090a-7aa0-85dc-c216080117fa";
    const info = { sessionId, classroomName: "三年甲班", state: "LOBBY" as const, joinMode: "roster_match" as const, serverInstanceId, protocolVersion: 1 as const };
    const joined = { sessionId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, serverInstanceId };
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    saveParticipant(info, joined);
    let randomValue = 0;
    const getRandomValues = vi.fn((values: Uint8Array) => {
      expect(values).toBeInstanceOf(Uint8Array);
      expect(values).toHaveLength(16);
      values.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      values[15] = randomValue++;
      return values;
    });
    vi.stubGlobal("crypto", { randomUUID: undefined, getRandomValues });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(info), { status: 200 })));
    vi.stubGlobal("WebSocket", StudentWebSocket);
    render(<App />);
    await screen.findByText("正在驗證登入狀態…");
    const socket = await waitForSocket();
    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: joined.participant, classroomName: info.classroomName, sessionState: "ACTIVE" });
    socket.message({ protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: { sessionQuestionId, type: "true_false", prompt: "地球是圓的。", points: 1, state: "OPEN", options: [], blanks: [], assets: [] }, ownLatestSubmission: null, reveal: null } });
    await screen.findByText("地球是圓的。");

    const trueButton = screen.getByRole("button", { name: "正確" });
    const falseButton = screen.getByRole("button", { name: "錯誤" });
    expect(trueButton).toHaveAttribute("aria-pressed", "false");
    expect(falseButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(trueButton);
    expect(trueButton).toHaveAttribute("aria-pressed", "true");
    expect(falseButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(falseButton);
    expect(trueButton).toHaveAttribute("aria-pressed", "false");
    expect(falseButton).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "送出答案" }));
    expect(screen.getByRole("button", { name: "送出中…" })).toBeDisabled();
    expect(socket.closeCalls).toBe(0);
    const submit = clientMessageSchema.parse(JSON.parse(socket.sent.at(-1) ?? "{}"));
    expect(submit).toMatchObject({ type: "submit_answer", sessionQuestionId, answer: { type: "true_false", value: false } });
    if (submit.type !== "submit_answer") throw new Error("expected submit_answer");
    expect(submit.submissionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(getRandomValues).toHaveBeenCalled();
    expect(screen.queryByText("連線暫時中斷，恢復後會重試送出。")).not.toBeInTheDocument();
    const acknowledgement = { protocolVersion: 1, type: "submission_acknowledged" as const, acknowledgement: { submissionId: submit.submissionId, sessionQuestionId, revision: 1, accepted: true as const, submittedAt: "2026-08-21T00:00:00Z", gradingStatus: "graded" as const } };
    expect(serverMessageSchema.parse(acknowledgement)).toEqual(acknowledgement);
    socket.message(acknowledgement);
    expect(await screen.findByText("答案已送出。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "送出中…" })).not.toBeInTheDocument();
    expect(socket.closeCalls).toBe(0);
    expect(screen.queryByText(/答對|答錯|得分/)).not.toBeInTheDocument();
    fireEvent.click(trueButton);
    fireEvent.click(screen.getByRole("button", { name: "更新答案" }));
    const revision = clientMessageSchema.parse(JSON.parse(socket.sent.at(-1) ?? "{}"));
    expect(revision).toMatchObject({ type: "submit_answer", sessionQuestionId, answer: { type: "true_false", value: true } });
    expect(revision.type === "submit_answer" && revision.submissionId).not.toBe(submit.submissionId);
    if (revision.type === "submit_answer") {
      socket.message({ protocolVersion: 1, type: "submission_acknowledged", acknowledgement: { submissionId: revision.submissionId, sessionQuestionId, revision: 2, accepted: true, submittedAt: "2026-08-21T00:00:01Z", gradingStatus: "graded" } });
      socket.message({ protocolVersion: 1, type: "question_revealed", reveal: { sessionQuestionId, type: "true_false", prompt: "地球是圓的。", points: 1, state: "REVEALED", options: [], blanks: [], assets: [], correctAnswer: true } });
      socket.message({ protocolVersion: 1, type: "submission_result", result: { submissionId: revision.submissionId, revision: 2, gradingStatus: "graded", isCorrect: true, score: 1, maxScore: 1, answer: { type: "true_false", value: true } } });
    }
    expect(await screen.findByLabelText("公布結果")).toHaveTextContent("正確答案：正確");
    expect(screen.getByLabelText("公布結果")).toHaveTextContent("你的作答：正確");
    expect(screen.getByText("結果：答對，得分 1 / 1")).toBeInTheDocument();
  });

  it("shows a controlled local error without closing the socket when submission serialization fails", async () => {
    const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
    const serverInstanceId = "019fe91f-5d66-7e40-a01b-0a69f36caeff";
    const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
    const sessionQuestionId = "019fe923-090a-7aa0-85dc-c216080117fa";
    const info = { sessionId, classroomName: "三年甲班", state: "LOBBY" as const, joinMode: "roster_match" as const, serverInstanceId, protocolVersion: 1 as const };
    const joined = { sessionId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, serverInstanceId };
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    saveParticipant(info, joined);
    vi.stubGlobal("crypto", { randomUUID: () => "not-a-uuid" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(info), { status: 200 })));
    vi.stubGlobal("WebSocket", StudentWebSocket);
    render(<App />);
    const socket = await waitForSocket();
    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: joined.participant, classroomName: info.classroomName, sessionState: "ACTIVE" });
    socket.message({ protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: { sessionQuestionId, type: "true_false", prompt: "地球是圓的。", points: 1, state: "OPEN", options: [], blanks: [], assets: [] }, ownLatestSubmission: null, reveal: null } });
    await screen.findByText("地球是圓的。");

    fireEvent.click(screen.getByRole("button", { name: "正確" }));
    fireEvent.click(screen.getByRole("button", { name: "送出答案" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("無法建立作答資料，請重新選擇後再試。");
    expect(screen.queryByText("連線暫時中斷，恢復後會重試送出。")).not.toBeInTheDocument();
    expect(socket.sent.some((frame) => JSON.parse(frame).type === "submit_answer")).toBe(false);
    expect(socket.closeCalls).toBe(0);
    expect(socket.readyState).toBe(StudentWebSocket.OPEN);
  });

  it("retries the same pending submission through socket B and clears it after B ACK", async () => {
    const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
    const serverInstanceId = "019fe91f-5d66-7e40-a01b-0a69f36caeff";
    const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
    const sessionQuestionId = "019fe923-090a-7aa0-85dc-c216080117fa";
    const info = { sessionId, classroomName: "三年甲班", state: "LOBBY" as const, joinMode: "roster_match" as const, serverInstanceId, protocolVersion: 1 as const };
    const joined = { sessionId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, serverInstanceId };
    const pendingSubmissionId = "019fe926-89d0-7d2a-ae64-cf2fb58e4c0a";
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    saveParticipant(info, joined);
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValueOnce("019fe926-89d0-7d2a-ae64-cf2fb58e4c01").mockReturnValueOnce(pendingSubmissionId).mockReturnValueOnce("019fe926-89d0-7d2a-ae64-cf2fb58e4c02").mockReturnValueOnce("019fe926-89d0-7d2a-ae64-cf2fb58e4c03") });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(info), { status: 200 })));
    vi.stubGlobal("WebSocket", StudentWebSocket);
    render(<App />);
    const socketA = await waitForSocket();
    socketA.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
    socketA.message({ protocolVersion: 1, type: "participant_authenticated", participant: joined.participant, classroomName: info.classroomName, sessionState: "ACTIVE" });
    socketA.message({ protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: { sessionQuestionId, type: "true_false", prompt: "地球是圓的。", points: 1, state: "OPEN", options: [], blanks: [], assets: [] }, ownLatestSubmission: null, reveal: null } });
    await screen.findByText("地球是圓的。");

    vi.useFakeTimers();
    await act(async () => { socketA.networkFailure(); });
    fireEvent.click(screen.getByRole("button", { name: "正確" }));
    fireEvent.click(screen.getByRole("button", { name: "送出答案" }));
    expect(screen.getByRole("alert")).toHaveTextContent("連線暫時中斷，恢復後會重試送出。");
    expect(socketA.sent.some((frame) => JSON.parse(frame).type === "submit_answer")).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const socketB = latestSocket();
    expect(socketB).not.toBe(socketA);
    await act(async () => {
      socketB.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
      socketB.message({ protocolVersion: 1, type: "participant_authenticated", participant: joined.participant, classroomName: info.classroomName, sessionState: "ACTIVE" });
    });
    const submit = clientMessageSchema.parse(JSON.parse(socketB.sent.at(-1) ?? "{}"));
    expect(submit).toMatchObject({ type: "submit_answer", sessionQuestionId, answer: { type: "true_false", value: true } });
    expect(submit.type === "submit_answer" && submit.submissionId).toBe(pendingSubmissionId);
    expect(socketA.sent.some((frame) => JSON.parse(frame).type === "submit_answer")).toBe(false);
    if (submit.type !== "submit_answer") throw new Error("expected submit_answer");

    await act(async () => {
      socketB.message({ protocolVersion: 1, type: "submission_acknowledged", acknowledgement: { submissionId: submit.submissionId, sessionQuestionId, revision: 1, accepted: true, submittedAt: "2026-08-21T00:00:00Z", gradingStatus: "graded" } });
    });
    expect(screen.getByText("答案已送出。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "送出中…" })).not.toBeInTheDocument();
  });

  it("clears pending submission and shows a controlled error when the server rejects it", async () => {
    const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
    const serverInstanceId = "019fe91f-5d66-7e40-a01b-0a69f36caeff";
    const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
    const sessionQuestionId = "019fe923-090a-7aa0-85dc-c216080117fa";
    const info = { sessionId, classroomName: "三年甲班", state: "LOBBY" as const, joinMode: "roster_match" as const, serverInstanceId, protocolVersion: 1 as const };
    const joined = { sessionId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, serverInstanceId };
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    saveParticipant(info, joined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(info), { status: 200 })));
    vi.stubGlobal("WebSocket", StudentWebSocket);
    render(<App />);
    await screen.findByText("正在驗證登入狀態…");
    const socket = await waitForSocket();
    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: joined.participant, classroomName: info.classroomName, sessionState: "ACTIVE" });
    socket.message({ protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: { sessionQuestionId, type: "true_false", prompt: "地球是圓的。", points: 1, state: "OPEN", options: [], blanks: [], assets: [] }, ownLatestSubmission: null, reveal: null } });
    await screen.findByText("地球是圓的。");
    fireEvent.click(screen.getByRole("button", { name: "正確" }));
    fireEvent.click(screen.getByRole("button", { name: "送出答案" }));
    expect(screen.getByRole("button", { name: "送出中…" })).toBeDisabled();
    socket.message({ protocolVersion: 1, type: "error", code: "QUESTION_LOCKED", message: "The question is locked." });
    expect(await screen.findByRole("alert")).toHaveTextContent("老師已停止本題作答。");
    expect(screen.queryByRole("button", { name: "送出中…" })).not.toBeInTheDocument();
    expect(socket.readyState).toBe(StudentWebSocket.OPEN);
  });

  it("restores LOCKED and REVEALED state from a credential resume without exposing answers before reveal", async () => {
    const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
    const serverInstanceId = "019fe91f-5d66-7e40-a01b-0a69f36caeff";
    const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
    const sessionQuestionId = "019fe923-090a-7aa0-85dc-c216080117fa";
    const info = { sessionId, classroomName: "三年甲班", state: "LOBBY" as const, joinMode: "roster_match" as const, serverInstanceId, protocolVersion: 1 as const };
    const joined = { sessionId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, serverInstanceId };
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    saveParticipant(info, joined, "AB7K9M2Q");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", StudentWebSocket);
    render(<App />);
    const socket = await waitForSocket();
    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: joined.participant, classroomName: info.classroomName, sessionState: "ACTIVE" });
    socket.message({ protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: { sessionQuestionId, type: "true_false", prompt: "尚未公布", points: 1, state: "LOCKED", options: [], blanks: [], assets: [] }, ownLatestSubmission: { submissionId: "019fe925-8c94-7d5e-8e52-d4706e87f65e", revision: 1, gradingStatus: "graded", isCorrect: null, score: null, maxScore: 1, answer: { type: "true_false", value: false } }, reveal: null } });
    await screen.findByText("尚未公布");
    expect(screen.getByRole("button", { name: "錯誤" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "錯誤" })).toBeDisabled();
    expect(screen.queryByText(/正確答案/)).not.toBeInTheDocument();

    socket.message({ protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: { sessionQuestionId, type: "true_false", prompt: "尚未作答", points: 1, state: "REVEALED", options: [], blanks: [], assets: [] }, ownLatestSubmission: null, reveal: { sessionQuestionId, type: "true_false", prompt: "尚未作答", points: 1, state: "REVEALED", options: [], blanks: [], assets: [], correctAnswer: true } } });
    expect(await screen.findByText("你尚未送出答案。")).toBeInTheDocument();
    expect(screen.getByLabelText("公布結果")).toHaveTextContent("正確答案：正確");

    socket.message({ protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: { sessionQuestionId, type: "true_false", prompt: "答錯題目", points: 1, state: "REVEALED", options: [], blanks: [], assets: [] }, ownLatestSubmission: { submissionId: "019fe925-8c94-7d5e-8e52-d4706e87f65e", revision: 1, gradingStatus: "graded", isCorrect: false, score: 0, maxScore: 1, answer: { type: "true_false", value: false } }, reveal: { sessionQuestionId, type: "true_false", prompt: "答錯題目", points: 1, state: "REVEALED", options: [], blanks: [], assets: [], correctAnswer: true } } });
    expect(await screen.findByText("結果：答錯，得分 0 / 1")).toBeInTheDocument();
    expect(screen.getByLabelText("公布結果")).toHaveTextContent("你的作答：錯誤");

    const essayId = "019fe924-3e72-7d4e-9e4b-5c52f2a3c1d6";
    socket.message({ protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: { sessionQuestionId: essayId, type: "essay", prompt: "請說明理由", points: 5, state: "REVEALED", options: [], blanks: [], assets: [] }, ownLatestSubmission: { submissionId: "019fe925-8c94-7d5e-8e52-d4706e87f65e", revision: 1, gradingStatus: "pending", isCorrect: null, score: null, maxScore: 5, answer: { type: "essay", text: "我的理由" } }, reveal: { sessionQuestionId: essayId, type: "essay", prompt: "請說明理由", points: 5, state: "REVEALED", options: [], blanks: [], assets: [], correctAnswer: null } } });
    expect(await screen.findByText("本題等待老師評閱。")).toBeInTheDocument();
    expect(screen.getByLabelText("公布結果")).toHaveTextContent("你的作答：我的理由");
    expect(screen.getByLabelText("公布結果")).toHaveTextContent("本題由老師評閱，不提供標準答案。");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders authenticated images responsively and provides an accessible fullscreen viewer", async () => {
    const createObjectURL = vi.fn(() => "blob:student-image");
    const revokeObjectURL = vi.fn();
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null);
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const { unmount } = await renderLiveMedia(
      [{ id: "019fe924-3e72-7d4e-9e4b-5c52f2a3c1d6", assetType: "image", displayName: "diagram.png", mimeType: "image/png", sizeBytes: 12_000, position: 0, pageReference: null }],
      vi.fn().mockResolvedValue(new Response(new Blob(["image"], { type: "image/png" }), { status: 200 })),
    );

    const image = await screen.findByAltText("diagram.png");
    expect(image).toHaveClass("live-question-image");
    expect(image).toHaveAttribute("src", "blob:student-image");
    for (const viewportWidth of [375, 390, 430]) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: viewportWidth });
      expect(image.closest(".live-question-media")).toHaveClass("live-question-media");
    }
    fireEvent.click(screen.getByRole("button", { name: "查看圖片：diagram.png" }));
    expect(screen.getByRole("dialog", { name: "圖片檢視器" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "開啟原圖" })).toHaveClass("media-viewer-action", "media-viewer-action-secondary");
    expect(screen.getByRole("button", { name: "關閉圖片檢視器" })).toHaveClass("media-viewer-action", "media-viewer-close");
    fireEvent.click(screen.getByRole("button", { name: "開啟原圖" }));
    expect(openWindow).toHaveBeenCalledWith("blob:student-image", "_blank", "noopener,noreferrer");
    expect(document.body.textContent).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "圖片檢視器" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看圖片：diagram.png" }));
    fireEvent.click(screen.getByRole("dialog", { name: "圖片檢視器" }));
    expect(screen.queryByRole("dialog", { name: "圖片檢視器" })).not.toBeInTheDocument();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:student-image");
  });

  it("shows a controlled image fetch error, retries it, and opens PDFs from Blob URLs", async () => {
    const createObjectURL = vi.fn().mockReturnValueOnce("blob:retried-image").mockReturnValueOnce("blob:session-pdf");
    const revokeObjectURL = vi.fn();
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null);
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(new Response(new Blob(["image"], { type: "image/png" }), { status: 200 }));
    await renderLiveMedia(
      [{ id: "019fe924-3e72-7d4e-9e4b-5c52f2a3c1d6", assetType: "image", displayName: "diagram.png", mimeType: "image/png", sizeBytes: 12_000, position: 0, pageReference: null }],
      fetchMock,
    );

    expect(await screen.findByText("圖片載入失敗")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新載入" }));
    expect(await screen.findByAltText("diagram.png")).toHaveAttribute("src", "blob:retried-image");

    cleanup();
    StudentWebSocket.instances = [];
    const pdfFetch = vi.fn().mockResolvedValue(new Response(new Blob(["pdf"], { type: "application/pdf" }), { status: 200 }));
    await renderLiveMedia(
      [{ id: "019fe925-8c94-7d5e-8e52-d4706e87f65e", assetType: "pdf", displayName: "chapter.pdf", mimeType: "application/pdf", sizeBytes: 12_000, position: 0, pageReference: null }],
      pdfFetch,
    );
    fireEvent.click(await screen.findByRole("button", { name: "開啟 PDF：chapter.pdf" }));
    await waitFor(() => expect(openWindow).toHaveBeenCalledWith("blob:session-pdf", "_blank", "noopener,noreferrer"));
  });

  it("renders an OPEN grouping projection and selects through the authenticated WebSocket", async () => {
    const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
    const serverInstanceId = "019fe91f-5d66-7e40-a01b-0a69f36caeff";
    const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
    const info = { sessionId, classroomName: "三年甲班", state: "LOBBY" as const, joinMode: "roster_match" as const, serverInstanceId, protocolVersion: 1 as const };
    const joined = { sessionId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, serverInstanceId };
    const draftId = "019fe926-914b-7ea1-8f27-a6494761aac9";
    const groupId = "019fe927-58b7-7bf0-bc08-b381969e4d2f";
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    saveParticipant(info, joined, "AB7K9M2Q");
    vi.stubGlobal("WebSocket", StudentWebSocket);
    render(<App />);
    const socket = await waitForSocket();
    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: joined.participant, classroomName: info.classroomName, sessionState: "ACTIVE" });
    socket.message({
      protocolVersion: 1,
      type: "session_sync",
      sync: {
        sessionState: "ACTIVE",
        currentQuestion: null,
        ownLatestSubmission: null,
        reveal: null,
        grouping: {
          groupingMode: "self_selection",
          draftId,
          draftState: "OPEN",
          selectionOpen: true,
          currentGroup: null,
          availableGroups: [{ groupId, name: "甲組", position: 0, memberCount: 1, capacity: 2, isFull: false, members: [{ displayName: "李小華", seatNumber: 2, isSelf: false }] }],
        },
      },
    });

    expect(await screen.findByText("目前開放自行選組")).toBeInTheDocument();
    expect(screen.getByText("李小華")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加入甲組" }));
    expect(StudentWebSocket.instances).toHaveLength(1);
    expect(clientMessageSchema.parse(JSON.parse(socket.sent.at(-1) ?? "{}"))).toMatchObject({ type: "select_group", draftId, groupId });
    socket.message({ protocolVersion: 1, type: "error", code: "GROUP_FULL", message: "The selected group is full." });
    expect(await screen.findByRole("alert")).toHaveTextContent("這個組別已額滿");
  });

  it.each(["LOBBY", "ACTIVE"] as const)("restores finalized grouping after hard reload and Wi-Fi reconnect in %s without Teacher actions", async (sessionState) => {
    const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
    const serverInstanceId = "019fe91f-5d66-7e40-a01b-0a69f36caeff";
    const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
    const draftId = "019fe926-914b-7ea1-8f27-a6494761aac9";
    const groupId = "019fe927-58b7-7bf0-bc08-b381969e4d2f";
    const info = { sessionId, classroomName: "三年甲班", state: "LOBBY" as const, joinMode: "roster_match" as const, serverInstanceId, protocolVersion: 1 as const };
    const joined = { sessionId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, serverInstanceId };
    const group = { groupId, name: "甲組", position: 0, memberCount: 1, capacity: null, isFull: false, members: [{ displayName: "Test", seatNumber: 1, isSelf: true }] };
    const finalized: StudentGroupingView = { groupingMode: "finalized", draftId: null, draftState: null, selectionOpen: false, currentGroup: group, availableGroups: [] };
    const sync = (grouping: StudentGroupingView | null | undefined) => ({ protocolVersion: 1, type: "session_sync", sync: { sessionState, currentQuestion: null, ownLatestSubmission: null, reveal: null, grouping } });
    const authenticate = (socket: StudentWebSocket) => {
      socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
      expect(clientMessageSchema.parse(JSON.parse(socket.sent.at(-1) ?? "{}"))).toMatchObject({ type: "participant_auth", sessionId, participantId });
      socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: joined.participant, classroomName: info.classroomName, sessionState });
    };
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    saveParticipant(info, joined, "AB7K9M2Q");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", StudentWebSocket);
    const firstMount = render(<App />);
    const firstSocket = await waitForSocket();
    await act(async () => {
      authenticate(firstSocket);
      firstSocket.message(sync({ groupingMode: "self_selection", draftId, draftState: "OPEN", selectionOpen: true, currentGroup: group, availableGroups: [group] }));
    });
    expect(screen.getByText("目前開放自行選組")).toBeInTheDocument();
    await act(async () => { firstSocket.message(sync(finalized)); });
    expect(screen.getByText("你的組別：甲組")).toBeInTheDocument();

    // Exact QA5: discard React/transport memory, retain only the stored credential.
    firstMount.unmount();
    StudentWebSocket.instances = [];
    render(<App />);
    const resumedSocket = await waitForSocket();
    await act(async () => { authenticate(resumedSocket); resumedSocket.message(sync(finalized)); });
    expect(screen.getByText("你的組別：甲組")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    if (sessionState === "LOBBY") expect(screen.getByText("等待老師開始課堂…")).toBeInTheDocument();

    vi.useFakeTimers();
    await act(async () => { resumedSocket.networkFailure(); await vi.advanceTimersByTimeAsync(1_000); });
    const reconnectedSocket = latestSocket();
    expect(reconnectedSocket).not.toBe(resumedSocket);
    await act(async () => { authenticate(reconnectedSocket); reconnectedSocket.message(sync(finalized)); });
    expect(screen.getByText("你的組別：甲組")).toBeInTheDocument();
    const latestRevision = { ...finalized, currentGroup: { ...group, name: "乙組" } };
    await act(async () => {
      reconnectedSocket.message(sync(latestRevision));
      resumedSocket.message(sync(null));
      firstSocket.message(sync(finalized));
    });
    expect(screen.getByText("你的組別：乙組")).toBeInTheDocument();
    expect(screen.queryByText("你的組別：甲組")).not.toBeInTheDocument();
    await act(async () => { reconnectedSocket.message(sync({ ...finalized, currentGroup: null })); });
    expect(screen.getByText("目前尚未分組")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "分組" })).toBeInTheDocument();
    await act(async () => { reconnectedSocket.message(sync(null)); });
    expect(screen.queryByRole("region", { name: "分組" })).not.toBeInTheDocument();
    await act(async () => { reconnectedSocket.message(sync(finalized)); reconnectedSocket.message(sync(undefined)); });
    expect(screen.queryByRole("region", { name: "分組" })).not.toBeInTheDocument();
  });

  it("preserves a selected answer and pending submission across grouping sync updates", async () => {
    const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
    const serverInstanceId = "019fe91f-5d66-7e40-a01b-0a69f36caeff";
    const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
    const sessionQuestionId = "019fe923-090a-7aa0-85dc-c216080117fa";
    const draftId = "019fe926-914b-7ea1-8f27-a6494761aac9";
    const groupId = "019fe927-58b7-7bf0-bc08-b381969e4d2f";
    const info = { sessionId, classroomName: "三年甲班", state: "LOBBY" as const, joinMode: "roster_match" as const, serverInstanceId, protocolVersion: 1 as const };
    const joined = { sessionId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, serverInstanceId };
    const question = { sessionQuestionId, type: "true_false" as const, prompt: "分組期間仍可作答。", points: 1, state: "OPEN" as const, options: [], blanks: [], assets: [] };
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    saveParticipant(info, joined, "AB7K9M2Q");
    vi.stubGlobal("WebSocket", StudentWebSocket);
    render(<App />);
    const socket = await waitForSocket();
    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: joined.participant, classroomName: info.classroomName, sessionState: "ACTIVE" });
    socket.message({
      protocolVersion: 1,
      type: "session_sync",
      sync: {
        sessionState: "ACTIVE",
        currentQuestion: question,
        ownLatestSubmission: null,
        reveal: null,
        grouping: {
          groupingMode: "self_selection",
          draftId,
          draftState: "OPEN",
          selectionOpen: true,
          currentGroup: null,
          availableGroups: [{ groupId, name: "甲組", position: 0, memberCount: 0, capacity: 2, isFull: false, members: [] }],
        },
      },
    });

    const correct = await screen.findByRole("button", { name: "正確" });
    fireEvent.click(correct);
    expect(correct).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "送出答案" }));
    expect(screen.getByRole("button", { name: "送出中…" })).toBeDisabled();
    const submission = clientMessageSchema.parse(JSON.parse(socket.sent.at(-1) ?? "{}"));
    expect(submission).toMatchObject({ type: "submit_answer", sessionQuestionId, answer: { type: "true_false", value: true } });

    socket.message({
      protocolVersion: 1,
      type: "session_sync",
      sync: {
        sessionState: "ACTIVE",
        currentQuestion: question,
        ownLatestSubmission: null,
        reveal: null,
        grouping: {
          groupingMode: "self_selection",
          draftId,
          draftState: "OPEN",
          selectionOpen: true,
          currentGroup: { groupId, name: "甲組", position: 0, memberCount: 1, capacity: 2, isFull: false, members: [{ displayName: "Test", seatNumber: 1, isSelf: true }] },
          availableGroups: [{ groupId, name: "甲組", position: 0, memberCount: 1, capacity: 2, isFull: false, members: [{ displayName: "Test", seatNumber: 1, isSelf: true }] }],
        },
      },
    });

    expect(await screen.findByText("目前選擇：甲組")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正確" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "送出中…" })).toBeDisabled();
    expect(StudentWebSocket.instances).toHaveLength(1);
  });
});

function latestSocket(): StudentWebSocket {
  const socket = StudentWebSocket.instances.at(-1);
  if (!socket) throw new Error("expected WebSocket instance");
  return socket;
}

function firstSent(socket: StudentWebSocket): string {
  const message = socket.sent.at(0);
  if (!message) throw new Error("expected WebSocket message");
  return message;
}

async function waitForSocket(): Promise<StudentWebSocket> {
  await waitFor(() => expect(StudentWebSocket.instances).toHaveLength(1));
  return latestSocket();
}

async function renderLiveMedia(assets: Array<{ id: string; assetType: "image" | "pdf"; displayName: string; mimeType: string; sizeBytes: number; position: number; pageReference: null }>, fetchMock: ReturnType<typeof vi.fn>) {
  const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
  const serverInstanceId = "019fe91f-5d66-7e40-a01b-0a69f36caeff";
  const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
  const info = { sessionId, classroomName: "三年甲班", state: "LOBBY" as const, joinMode: "roster_match" as const, serverInstanceId, protocolVersion: 1 as const };
  const joined = { sessionId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, serverInstanceId };
  window.history.pushState({}, "", "/student/join/AB7K9M2Q");
  saveParticipant(info, joined, "AB7K9M2Q");
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", StudentWebSocket);
  const rendered = render(<App />);
  const socket = await waitForSocket();
  socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
  socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: joined.participant, classroomName: info.classroomName, sessionState: "ACTIVE" });
  socket.message({ protocolVersion: 1, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: { sessionQuestionId: "019fe923-090a-7aa0-85dc-c216080117fa", type: "true_false", prompt: "看圖片", points: 1, state: "OPEN", options: [], blanks: [], assets }, ownLatestSubmission: null, reveal: null } });
  return rendered;
}
