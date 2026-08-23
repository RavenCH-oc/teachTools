import { describe, expect, it, vi } from "vitest";
import type { QuestionStatistics, SessionStatistics } from "../types/teacher";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { teacherApi } from "./teacherApi";

const questionStatistics: QuestionStatistics = {
  sessionQuestionId: "question-1",
  position: 0,
  questionType: "true_false",
  prompt: "Prompt",
  participantCount: 0,
  answeredCount: 0,
  unansweredCount: 0,
  responseRate: null,
  gradedCount: 0,
  pendingCount: 0,
  correctCount: 0,
  incorrectCount: 0,
  accuracy: null,
  averageScore: null,
  maxPoints: 2,
  choiceDistribution: [
    { optionId: "true", label: "正確", selectionCount: 0, selectionRate: null },
    { optionId: "false", label: "錯誤", selectionCount: 0, selectionRate: null },
  ],
};

const sessionStatistics: SessionStatistics = {
  sessionId: "session-1",
  sessionState: "ENDED",
  participantCount: 0,
  publishedQuestionCount: 1,
  eligibleQuestionCount: 1,
  answeredOpportunityCount: 0,
  totalOpportunityCount: 0,
  responseRate: null,
  gradedSubmissionCount: 0,
  pendingSubmissionCount: 0,
  correctCount: 0,
  incorrectCount: 0,
  accuracy: null,
  earnedScoreTotal: 0,
  gradedPossibleScoreTotal: 0,
  scoreRate: null,
  questionSummaries: [questionStatistics],
  participantSummaries: [],
};

describe("teacher statistics API contract", () => {
  it("maps the session statistics command with nullable rates", async () => {
    invoke.mockResolvedValueOnce(sessionStatistics);
    await expect(teacherApi.getSessionStatistics?.("session-1")).resolves.toEqual(sessionStatistics);
    expect(invoke).toHaveBeenCalledWith("get_session_statistics", { sessionId: "session-1" });
    expect(sessionStatistics.responseRate).toBeNull();
    expect(questionStatistics.choiceDistribution[0]?.selectionRate).toBeNull();
  });

  it("maps question statistics and preserves option distribution fields", async () => {
    invoke.mockResolvedValueOnce(questionStatistics);
    await expect(teacherApi.getQuestionStatistics?.("session-1", "question-1")).resolves.toEqual(questionStatistics);
    expect(invoke).toHaveBeenCalledWith("get_question_statistics", {
      sessionId: "session-1",
      sessionQuestionId: "question-1",
    });
  });
});
