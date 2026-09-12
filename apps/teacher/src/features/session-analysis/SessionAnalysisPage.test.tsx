import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LocalSession, QuestionStatistics, SessionQuestion, SessionStatistics, TeacherApi } from "../../types/teacher";
import { SessionAnalysisPage } from "./SessionAnalysisPage";

const session: LocalSession = { id: "session-1", classroomId: "class-1", classroomName: "三年甲班", serverInstanceId: "server-1", state: "ENDED", joinMode: "roster_match", joinCode: "unused", createdAt: "2026-08-01T00:00:00Z", lobbyOpenedAt: null, endedAt: "2026-08-02T00:00:00Z", endedReason: "teacher_ended" };
function question(state: SessionQuestion["state"]): SessionQuestion { return { id: "question-1", sessionId: session.id, sourceQuestionId: "source-1", type: "single_choice", prompt: "哪一個是正確答案？", points: 5, position: 0, answerConfig: { options: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correctOptionId: "a" }, gradingConfig: {}, metadata: {}, configVersion: 1, state, createdAt: "2026-08-01T00:00:00Z", openedAt: null, lockedAt: null, revealedAt: null, assets: [] }; }
function statistics(state: SessionStatistics["sessionState"]): SessionStatistics { return { sessionId: session.id, sessionState: state, participantCount: 2, publishedQuestionCount: 1, eligibleQuestionCount: 1, answeredOpportunityCount: 1, totalOpportunityCount: 2, responseRate: 0.5, gradedSubmissionCount: 1, pendingSubmissionCount: 0, correctCount: 1, incorrectCount: 0, accuracy: 1, earnedScoreTotal: 5, gradedPossibleScoreTotal: 5, scoreRate: 1, questionSummaries: [questionStats()], participantSummaries: [{ participantId: "p-2", seatNumber: 2, displayName: "乙", eligibleQuestionCount: 1, answeredCount: 0, unansweredCount: 1, gradedCount: 0, pendingCount: 0, correctCount: 0, incorrectCount: 0, earnedScore: 0, gradedPossibleScore: 0, accuracy: null, scoreRate: null }, { participantId: "p-1", seatNumber: 1, displayName: "甲", eligibleQuestionCount: 1, answeredCount: 1, unansweredCount: 0, gradedCount: 1, pendingCount: 0, correctCount: 1, incorrectCount: 0, earnedScore: 5, gradedPossibleScore: 5, accuracy: 1, scoreRate: 1 }] }; }
function questionStats(): QuestionStatistics { return { sessionQuestionId: "question-1", position: 0, questionType: "single_choice", prompt: "哪一個是正確答案？", participantCount: 2, answeredCount: 1, unansweredCount: 1, responseRate: 0.5, gradedCount: 1, pendingCount: 0, correctCount: 1, incorrectCount: 0, accuracy: 1, averageScore: 5, maxPoints: 5, choiceDistribution: [{ optionId: "a", label: "A", selectionCount: 1, selectionRate: 1 }] }; }
function apiFor(state: SessionStatistics["sessionState"], current: SessionQuestion["state"]): Required<Pick<TeacherApi, "getSessionStatistics" | "getDifficultQuestions" | "listSessionQuestions">> { return { getSessionStatistics: vi.fn().mockResolvedValue(statistics(state)), getDifficultQuestions: vi.fn().mockResolvedValue([{ sessionQuestionId: "question-1", position: 0, prompt: "哪一個是正確答案？", accuracy: 0, gradedCount: 1 }]), listSessionQuestions: vi.fn().mockResolvedValue([question(current)]) }; }

describe("SessionAnalysisPage", () => {
  it("renders ended summary, deterministic participant order, and collapsed distribution", async () => {
    render(<SessionAnalysisPage api={apiFor("ENDED", "REVEALED")} session={session} onBack={vi.fn()} />);
    expect(await screen.findByText("課堂摘要")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "匯出報表" })).toBeInTheDocument();
    expect(screen.getAllByText("已評分得分").length).toBeGreaterThan(0);
    expect(screen.getByText("易錯題")).toBeInTheDocument();
    const participantTable = screen.getByRole("table", { name: "學生作答與評分統計" });
    expect(participantTable.textContent?.indexOf("甲")).toBeLessThan(participantTable.textContent?.indexOf("乙") ?? 0);
    expect(screen.queryByText("A · 100%")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看作答分布" }));
    expect(screen.getByText("A", { exact: true })).toBeInTheDocument();
  });

  it("enters OPEN safe mode and hides grading, difficulty, and distribution", async () => {
    render(<SessionAnalysisPage api={apiFor("ACTIVE", "OPEN")} session={{ ...session, state: "ACTIVE", endedAt: null }} onBack={vi.fn()} />);
    expect(await screen.findByText("目前仍在作答中，為避免投影畫面影響作答，詳細分析會在停止作答後顯示。")).toBeInTheDocument();
    expect(screen.queryByText("易錯題")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "匯出報表" })).not.toBeInTheDocument();
    expect(screen.queryByText("已評分得分")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看作答分布" })).not.toBeInTheDocument();
  });

  it("shows full historical analysis even when the final snapshot is OPEN", async () => {
    render(<SessionAnalysisPage api={apiFor("ENDED", "OPEN")} session={session} onBack={vi.fn()} />);
    expect(await screen.findByText("易錯題")).toBeInTheDocument();
    expect(screen.getAllByText("已評分得分").length).toBeGreaterThan(0);
  });
});
