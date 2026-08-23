import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { QuestionStatistics, SessionQuestion, TeacherApi } from "../../types/teacher";
import { LiveQuestionStatisticsPanel } from "./LiveQuestionStatisticsPanel";

const sessionId = "session-1";

function question(state: SessionQuestion["state"], type: SessionQuestion["type"] = "single_choice"): SessionQuestion {
  const answerConfig: SessionQuestion["answerConfig"] = type === "multiple_choice"
    ? { options: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correctOptionIds: ["a"] }
    : type === "essay" ? {} : { options: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correctOptionId: "a" };
  return { id: "question-1", sessionId, sourceQuestionId: "source-1", type, prompt: "目前題目", points: 5, position: 0, answerConfig, gradingConfig: {}, metadata: {}, configVersion: 1, state, createdAt: "2026-08-11T00:00:00Z", openedAt: null, lockedAt: null, revealedAt: null, assets: [] };
}

function statistics(overrides: Partial<QuestionStatistics> = {}): QuestionStatistics {
  return { sessionQuestionId: "question-1", position: 0, questionType: "single_choice", prompt: "目前題目", participantCount: 4, answeredCount: 3, unansweredCount: 1, responseRate: 0.75, gradedCount: 3, pendingCount: 0, correctCount: 2, incorrectCount: 1, accuracy: 2 / 3, averageScore: 3.75, maxPoints: 5, choiceDistribution: [{ optionId: "a", label: "A", selectionCount: 2, selectionRate: 2 / 3 }, { optionId: "b", label: "B", selectionCount: 1, selectionRate: 1 / 3 }], ...overrides };
}

function apiFor(value: QuestionStatistics) {
  return { getQuestionStatistics: vi.fn().mockResolvedValue(value) } satisfies Required<Pick<TeacherApi, "getQuestionStatistics">>;
}

describe("LiveQuestionStatisticsPanel", () => {
  it("shows only response progress while a question is OPEN", async () => {
    const api = apiFor(statistics());
    render(<LiveQuestionStatisticsPanel api={api} sessionId={sessionId} question={question("OPEN")} />);

    expect(await screen.findByText("3 / 4")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("作答結束後會顯示答案分析。")).toBeInTheDocument();
    expect(screen.queryByText("答對")).not.toBeInTheDocument();
    expect(screen.queryByText("作答分布")).not.toBeInTheDocument();
  });

  it.each(["LOCKED", "REVEALED"] as const)("shows grading details and distribution when %s", async (state) => {
    const api = apiFor(statistics());
    render(<LiveQuestionStatisticsPanel api={api} sessionId={sessionId} question={question(state)} />);

    expect(await screen.findByText("66.7%")).toBeInTheDocument();
    expect(screen.getByText("作答分布")).toBeInTheDocument();
    expect(screen.getByText("3.75 / 5")).toBeInTheDocument();
    expect(screen.getByText("答對")).toBeInTheDocument();
    expect(screen.queryByText("作答結束後會顯示答案分析。")).not.toBeInTheDocument();
  });

  it("hides stale detail immediately when a locked question is reopened", async () => {
    const api = apiFor(statistics());
    const view = render(<LiveQuestionStatisticsPanel api={api} sessionId={sessionId} question={question("LOCKED")} />);
    expect(await screen.findByText("作答分布")).toBeInTheDocument();

    view.rerender(<LiveQuestionStatisticsPanel api={api} sessionId={sessionId} question={question("OPEN")} />);
    await waitFor(() => expect(screen.queryByText("作答分布")).not.toBeInTheDocument());
    expect(screen.getByText("作答結束後會顯示答案分析。")).toBeInTheDocument();
  });

  it("does not invent grading values for pending essay answers", async () => {
    const api = apiFor(statistics({ questionType: "essay", gradedCount: 0, pendingCount: 3, correctCount: 0, incorrectCount: 0, accuracy: null, averageScore: null, choiceDistribution: [] }));
    render(<LiveQuestionStatisticsPanel api={api} sessionId={sessionId} question={question("LOCKED", "essay")} />);

    expect(await screen.findByText("待評分")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText("作答分布")).not.toBeInTheDocument();
  });

  it("renders multiple-choice distributions with the explanatory note", async () => {
    const api = apiFor(statistics({ questionType: "multiple_choice", choiceDistribution: [{ optionId: "a", label: "A", selectionCount: 3, selectionRate: 0.75 }, { optionId: "b", label: "B", selectionCount: 3, selectionRate: 0.75 }] }));
    render(<LiveQuestionStatisticsPanel api={api} sessionId={sessionId} question={question("REVEALED", "multiple_choice")} />);

    expect(await screen.findByText("複選題每個選項以已作答人數為分母，因此百分比總和可能超過 100%。")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
  });

  it("shows the hidden message without querying statistics", () => {
    const api = apiFor(statistics());
    render(<LiveQuestionStatisticsPanel api={api} sessionId={sessionId} question={question("HIDDEN")} />);

    expect(screen.getByText("題目尚未開放作答。")).toBeInTheDocument();
    expect(api.getQuestionStatistics).not.toHaveBeenCalled();
  });

  it("keeps zero-participant rates finite", async () => {
    const api = apiFor(statistics({ participantCount: 0, answeredCount: 0, unansweredCount: 0, responseRate: null, gradedCount: 0, pendingCount: 0, choiceDistribution: [] }));
    render(<LiveQuestionStatisticsPanel api={api} sessionId={sessionId} question={question("OPEN")} />);

    expect(await screen.findByText("0 / 0")).toBeInTheDocument();
    expect(screen.getByText("作答率").parentElement).toHaveTextContent("—");
    expect(screen.queryByText(/NaN|Infinity/)).not.toBeInTheDocument();
  });
});
