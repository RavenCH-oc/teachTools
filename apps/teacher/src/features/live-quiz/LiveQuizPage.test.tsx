import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveQuizPage, type LiveQuizApi } from "./LiveQuizPage";
import type { LocalServerStatus, LocalSession, Question, QuestionSet, QuestionStatistics, SessionQuestion } from "../../types/teacher";

const server: LocalServerStatus = {
  running: true,
  lifecycleState: "running",
  port: 49561,
  localUrl: "http://127.0.0.1:49561",
  serverInstanceId: "019fe91f-5d66-7e40-a01b-0a69f36caeff",
  candidateUrls: [],
  webSocketUrls: [],
  protocolVersion: 1,
};

const baseSession: LocalSession = {
  id: "019fe91e-7606-7d00-aede-59c50a724f4d",
  classroomId: "019fe920-0e14-7e30-8a9d-367f86c03bcc",
  classroomName: "三年甲班",
  serverInstanceId: server.serverInstanceId ?? "",
  state: "ACTIVE",
  joinMode: "roster_match",
  joinCode: "AB7K9M2Q",
  createdAt: "2026-08-11T00:00:00Z",
  lobbyOpenedAt: "2026-08-11T00:00:00Z",
  endedAt: null,
  endedReason: null,
};

function apiFixture(session: LocalSession | null): LiveQuizApi {
  const statistics: QuestionStatistics = { sessionQuestionId: "session-question", position: 0, questionType: "true_false", prompt: "A", participantCount: 4, answeredCount: 3, unansweredCount: 1, responseRate: 0.75, gradedCount: 0, pendingCount: 0, correctCount: 0, incorrectCount: 0, accuracy: null, averageScore: null, maxPoints: 1, choiceDistribution: [] };
  return {
    getLocalServerStatus: vi.fn().mockResolvedValue(server),
    getActiveLocalSession: vi.fn().mockResolvedValue(session),
    listQuestionSets: vi.fn().mockResolvedValue([]),
    listQuestions: vi.fn().mockResolvedValue([]),
    startLocalSession: vi.fn().mockResolvedValue(session),
    publishSessionQuestion: vi.fn(),
    listSessionQuestions: vi.fn().mockResolvedValue([]),
    openSessionQuestion: vi.fn(),
    lockSessionQuestion: vi.fn(),
    reopenSessionQuestion: vi.fn(),
    revealSessionQuestion: vi.fn(),
    getSessionQuestionProgress: vi.fn(),
    getQuestionStatistics: vi.fn().mockResolvedValue(statistics),
  };
}

function publishedQuestion(state: SessionQuestion["state"]): SessionQuestion {
  return { id: "session-question-1", sessionId: baseSession.id, sourceQuestionId: "source-question-1", type: "true_false", prompt: "A", points: 1, position: 0, answerConfig: { correctAnswer: true }, gradingConfig: {}, metadata: {}, configVersion: 1, state, createdAt: "2026-08-11T00:00:00Z", openedAt: null, lockedAt: null, revealedAt: null, assets: [] };
}

describe("LiveQuizPage", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("hydrates an ACTIVE session from the authoritative backend on direct mount", async () => {
    const api = apiFixture(baseSession);
    render(<LiveQuizPage api={api} onError={vi.fn()} />);

    expect(screen.getByText("正在載入課堂…")).toBeInTheDocument();
    expect(await screen.findByText("發布題目")).toBeInTheDocument();
    expect(screen.queryByText("請先開啟伺服器並建立課堂。")).not.toBeInTheDocument();
    expect(api.getLocalServerStatus).toHaveBeenCalledTimes(1);
    expect(api.getActiveLocalSession).toHaveBeenCalledTimes(1);
    expect(api.listSessionQuestions).toHaveBeenCalledWith(baseSession.id);
  });

  it("keeps LOBBY semantics until the teacher starts the session", async () => {
    const api = apiFixture({ ...baseSession, state: "LOBBY" });
    render(<LiveQuizPage api={api} onError={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "開始課堂" })).toBeInTheDocument();
    expect(screen.queryByText("請先開啟伺服器並建立課堂。")).not.toBeInTheDocument();
  });

  it.each([
    ["null session", null],
    ["ended session", { ...baseSession, state: "ENDED" as const }],
  ])("shows the empty state only after confirming %s", async (_label, session) => {
    render(<LiveQuizPage api={apiFixture(session)} onError={vi.fn()} />);

    expect(await screen.findByText("請先開啟伺服器並建立課堂。")).toBeInTheDocument();
    expect(screen.queryByText("正在載入課堂…")).not.toBeInTheDocument();
  });

  it("does not treat an old server-instance session as a continuing Live Quiz", async () => {
    const api = apiFixture({ ...baseSession, serverInstanceId: "019fe920-0e14-7e30-8a9d-367f86c03bcc" });
    render(<LiveQuizPage api={api} onError={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "課堂伺服器狀態已變更" })).toBeInTheDocument();
    expect(screen.queryByText("發布題目")).not.toBeInTheDocument();
    expect(api.listSessionQuestions).not.toHaveBeenCalled();
  });

  it("publishes from a button action without losing the same ACTIVE session", async () => {
    const sourceSet: QuestionSet = { id: "019fe920-0e14-7e30-8a9d-367f86c03bcc", lessonId: null, title: "測驗題組", description: null, createdAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z" };
    const sourceQuestion: Question = { id: "019fe921-2844-7a50-afd5-65ab3159f0e1", questionSetId: sourceSet.id, type: "true_false", prompt: "A", points: 1, position: 0, answerConfig: { correctAnswer: true }, metadata: {}, configVersion: 1, createdAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z" };
    const api = apiFixture(baseSession);
    vi.mocked(api.listQuestionSets).mockResolvedValue([sourceSet]);
    vi.mocked(api.listQuestions).mockResolvedValue([sourceQuestion]);
    vi.mocked(api.publishSessionQuestion).mockResolvedValue({ id: "019fe923-090a-7aa0-85dc-c216080117fa", sessionId: baseSession.id, sourceQuestionId: sourceQuestion.id, type: "true_false", prompt: "A", points: 1, position: 0, answerConfig: { correctAnswer: true }, gradingConfig: {}, metadata: {}, configVersion: 1, state: "HIDDEN", createdAt: "2026-08-11T00:00:00Z", openedAt: null, lockedAt: null, revealedAt: null, assets: [] });
    render(<LiveQuizPage api={api} onError={vi.fn()} />);

    await screen.findByText("發布題目");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: sourceSet.id } });
    await screen.findByText("A");
    fireEvent.click(screen.getByRole("button", { name: "發布" }));

    await waitFor(() => expect(api.publishSessionQuestion).toHaveBeenCalledWith(baseSession.id, sourceQuestion.id));
    expect(screen.getByRole("heading", { name: "即時測驗" })).toBeInTheDocument();
    expect(api.getActiveLocalSession).toHaveBeenLastCalledWith();
    expect(screen.queryByText("請先開啟伺服器並建立課堂。")).not.toBeInTheDocument();
  });

  it("hydrates the current-question dashboard without disabling Live Quiz controls", async () => {
    const api = apiFixture(baseSession);
    vi.mocked(api.listSessionQuestions).mockResolvedValue([publishedQuestion("OPEN")]);
    render(<LiveQuizPage api={api} onError={vi.fn()} />);

    expect(await screen.findByText("3 / 4")).toBeInTheDocument();
    expect(screen.getByText("作答結束後會顯示答案分析。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "鎖定題目" })).toBeEnabled();
    expect(api.getQuestionStatistics).toHaveBeenCalledWith(baseSession.id, "session-question-1");
  });

  it("shows the hidden current question and keeps its open action available", async () => {
    const api = apiFixture(baseSession);
    vi.mocked(api.listSessionQuestions).mockResolvedValue([publishedQuestion("HIDDEN")]);
    render(<LiveQuizPage api={api} onError={vi.fn()} />);

    expect(await screen.findByText("題目尚未開放作答。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "開啟題目" })).toBeEnabled();
    expect(api.getQuestionStatistics).not.toHaveBeenCalled();
  });

  it("selects the latest hidden question after a previously revealed question", async () => {
    const api = apiFixture(baseSession);
    vi.mocked(api.listSessionQuestions).mockResolvedValue([
      { ...publishedQuestion("REVEALED"), id: "session-question-1", position: 0 },
      { ...publishedQuestion("HIDDEN"), id: "session-question-2", position: 1 },
    ]);
    render(<LiveQuizPage api={api} onError={vi.fn()} />);

    expect(await screen.findByText("題目尚未開放作答。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "開啟題目" })).toBeEnabled();
    expect(screen.queryByText("作答結束後會顯示答案分析。")).not.toBeInTheDocument();
  });

  it("keeps question controls enabled while statistics are still loading", async () => {
    const api = apiFixture(baseSession);
    vi.mocked(api.listSessionQuestions).mockResolvedValue([publishedQuestion("OPEN")]);
    vi.mocked(api.getQuestionStatistics).mockReturnValue(new Promise<QuestionStatistics>(() => undefined));
    render(<LiveQuizPage api={api} onError={vi.fn()} />);

    expect(await screen.findByText("正在更新統計…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "鎖定題目" })).toBeEnabled();
  });

  it("stops current-question progress polling when navigation unmounts the page", async () => {
    vi.useFakeTimers();
    const api = apiFixture(baseSession);
    vi.mocked(api.listSessionQuestions).mockResolvedValue([publishedQuestion("OPEN")]);
    vi.mocked(api.getSessionQuestionProgress).mockResolvedValue({ sessionQuestionId: "session-question-1", answeredCount: 0, participantCount: 1, answeredParticipantIds: [] });
    const view = render(<LiveQuizPage api={api} onError={vi.fn()} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(api.getSessionQuestionProgress).toHaveBeenCalledTimes(1);

    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(api.getSessionQuestionProgress).toHaveBeenCalledTimes(1);
  });
});
