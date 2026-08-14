import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientMessageSchema } from "@classtools/backend-contract";
import { App } from "./App";
import { saveParticipant } from "./services/studentApi";

class StudentWebSocket {
  static instances: StudentWebSocket[] = [];
  readonly sent: string[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) { StudentWebSocket.instances.push(this); }
  send(message: string): void { this.sent.push(message); }
  close(): void { this.onclose?.({} as CloseEvent); }
  message(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent); }
  networkFailure(): void { this.onclose?.({} as CloseEvent); }
}

describe("Student application shell", () => {
  afterEach(() => { cleanup(); localStorage.clear(); StudentWebSocket.instances = []; vi.unstubAllGlobals(); window.history.pushState({}, "", "/"); });
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
    await waitFor(() => expect(StudentWebSocket.instances).toHaveLength(1));
    const socket = latestSocket();
    socket.message({ protocolVersion: 1, type: "server_hello", serverInstanceId });
    expect(clientMessageSchema.parse(JSON.parse(firstSent(socket)))).toMatchObject({ type: "participant_auth", participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    socket.message({ protocolVersion: 1, type: "participant_authenticated", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, classroomName: "三年甲班", sessionState: "LOBBY" });
    expect(await screen.findByRole("heading", { name: "已加入課堂" })).toBeInTheDocument();
  });

  it("reconnects a reload credential, keeps it after a transient failure, and clears it after AUTH_FAILED", async () => {
    const sessionId = "019fe91e-7606-7d00-aede-59c50a724f4d";
    const serverInstanceId = "019fe91f-5d66-7e40-a01b-0a69f36caeff";
    const participantId = "019fe920-0e14-7e30-8a9d-367f86c03bcc";
    const info = { sessionId, classroomName: "三年甲班", state: "LOBBY" as const, joinMode: "roster_match" as const, serverInstanceId, protocolVersion: 1 as const };
    const joined = { sessionId, participantId, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", participant: { participantId, sessionId, seatNumber: 1, displayName: "Test" }, serverInstanceId };
    window.history.pushState({}, "", "/student/join/AB7K9M2Q");
    saveParticipant(info, joined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(info), { status: 200 })));
    vi.stubGlobal("WebSocket", StudentWebSocket);
    render(<App />);
    expect(await screen.findByText("正在驗證登入狀態…")).toBeInTheDocument();
    await waitFor(() => expect(StudentWebSocket.instances).toHaveLength(1));
    latestSocket().networkFailure();
    expect(localStorage.getItem(`classroom.participant.${serverInstanceId}.${sessionId}`)).toContain("AAAAAAAA");

    latestSocket().message({ protocolVersion: 1, type: "error", code: "AUTH_FAILED", message: "Participant authentication failed." });
    await waitFor(() => expect(localStorage.getItem(`classroom.participant.${serverInstanceId}.${sessionId}`)).toBeNull());
    expect(screen.getByRole("alert")).toHaveTextContent("登入狀態已失效，請重新加入課堂。");
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
