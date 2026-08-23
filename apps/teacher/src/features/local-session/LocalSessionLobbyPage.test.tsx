import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSessionLobbyPage, type LocalSessionLobbyApi } from "./LocalSessionLobbyPage";
import type { LocalSession, LocalSessionParticipant } from "../../types/teacher";

const session: LocalSession = {
  id: "019fe91e-7606-7d00-aede-59c50a724f4d",
  classroomId: "019fe920-0e14-7e30-8a9d-367f86c03bcc",
  classroomName: "三年甲班",
  serverInstanceId: "019fe91f-5d66-7e40-a01b-0a69f36caeff",
  state: "LOBBY",
  joinMode: "roster_match",
  joinCode: "AB7K9M2Q",
  createdAt: "2026-08-11T00:00:00Z",
  lobbyOpenedAt: "2026-08-11T00:00:00Z",
  endedAt: null,
  endedReason: null,
};

const participants: LocalSessionParticipant[] = [
  { participantId: "019fe921-2844-7a50-afd5-65ab3159f0e1", studentId: "019fe922-99f1-7e70-a8b6-213548c1bc21", seatNumber: 1, displayName: "Test", joinedAt: "2026-08-11T00:00:00Z", online: true },
  { participantId: "019fe923-090a-7aa0-85dc-c216080117fa", studentId: "019fe924-a47a-7e40-8ac4-52e621897d30", seatNumber: 2, displayName: "T", joinedAt: "2026-08-11T00:00:00Z", online: false },
];

function apiFixture(): LocalSessionLobbyApi {
  return {
    getLocalServerStatus: vi.fn().mockResolvedValue({ running: true, lifecycleState: "running", port: 49561, localUrl: "http://127.0.0.1:49561", serverInstanceId: session.serverInstanceId, candidateUrls: ["http://192.168.68.54:49561"], webSocketUrls: ["ws://192.168.68.54:49561/ws"], protocolVersion: 1 }),
    getActiveLocalSession: vi.fn().mockResolvedValue(session),
    listLocalSessionParticipants: vi.fn().mockResolvedValue(participants),
    startLocalServer: vi.fn(),
    createLocalSession: vi.fn(),
    openLocalSessionLobby: vi.fn(),
    endLocalSession: vi.fn(),
  };
}

describe("LocalSessionLobbyPage", () => {
  afterEach(() => cleanup());

  it("renders numeric roster seats with online presence without a stale seat validation banner", async () => {
    render(<LocalSessionLobbyPage api={apiFixture()} classrooms={[]} onError={vi.fn()} onClearError={vi.fn()} onOpenLiveQuiz={vi.fn()} />);

    expect(await screen.findByText("1 號 Test")).toBeInTheDocument();
    expect(screen.getByText("2 號 T")).toBeInTheDocument();
    expect(screen.getByText("線上")).toBeInTheDocument();
    expect(screen.getByText("離線")).toBeInTheDocument();
    expect(screen.queryByText(/座號必須為正整數/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Seat number must be a positive whole number/)).not.toBeInTheDocument();
  });

  it("renders an ACTIVE session as in progress and returns to the same Live Quiz", async () => {
    const api = apiFixture();
    vi.mocked(api.getActiveLocalSession).mockResolvedValue({ ...session, state: "ACTIVE" });
    const openLiveQuiz = vi.fn();
    render(<LocalSessionLobbyPage api={api} classrooms={[]} onError={vi.fn()} onClearError={vi.fn()} onOpenLiveQuiz={openLiveQuiz} />);

    expect(await screen.findByRole("heading", { name: "課堂進行中" })).toBeInTheDocument();
    expect(screen.getByText("學生已進入作答流程；不會建立第二個課堂或重新啟動伺服器。")).toBeInTheDocument();
    expect(screen.queryByText("第二步：建立課堂")).not.toBeInTheDocument();
    screen.getByRole("button", { name: "返回即時測驗" }).click();
    expect(openLiveQuiz).toHaveBeenCalledOnce();
    expect(api.createLocalSession).not.toHaveBeenCalled();
    expect(api.startLocalServer).not.toHaveBeenCalled();
  });
});
