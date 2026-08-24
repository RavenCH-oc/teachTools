import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionQuestion, SessionStatistics } from "../../types/teacher";
import { SESSION_ANALYSIS_POLL_INTERVAL_MS, useSessionAnalysis, type SessionAnalysisApi } from "./useSessionAnalysis";

function statistics(state: SessionStatistics["sessionState"]): SessionStatistics { return { sessionId: "session-1", sessionState: state, participantCount: 0, publishedQuestionCount: 0, eligibleQuestionCount: 0, answeredOpportunityCount: 0, totalOpportunityCount: 0, responseRate: null, gradedSubmissionCount: 0, pendingSubmissionCount: 0, correctCount: 0, incorrectCount: 0, accuracy: null, earnedScoreTotal: 0, gradedPossibleScoreTotal: 0, scoreRate: null, questionSummaries: [], participantSummaries: [] }; }
const questions: SessionQuestion[] = [];
function Harness({ api, sessionId = "session-1" }: { api: SessionAnalysisApi; sessionId?: string }) { const state = useSessionAnalysis({ api, sessionId, initialState: "ACTIVE" }); return <><span data-testid="loading">{String(state.loading)}</span><span data-testid="error">{state.error ?? ""}</span><span data-testid="state">{state.snapshot?.statistics.sessionState ?? "none"}</span></>; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; }); return { promise, resolve }; }
function apiFor(value: SessionStatistics) { return { getSessionStatistics: vi.fn().mockResolvedValue(value), getDifficultQuestions: vi.fn().mockResolvedValue([]), listSessionQuestions: vi.fn().mockResolvedValue(questions) } satisfies SessionAnalysisApi; }

describe("useSessionAnalysis", () => {
  afterEach(() => vi.useRealTimers());
  it("fetches immediately and polls after completion without overlap", async () => {
    vi.useFakeTimers();
    const first = deferred<SessionStatistics>();
    const api = apiFor(statistics("ACTIVE"));
    api.getSessionStatistics.mockReturnValueOnce(first.promise);
    render(<Harness api={api} />);
    expect(api.getSessionStatistics).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(statistics("ACTIVE")); await first.promise; });
    await act(async () => { await vi.advanceTimersByTimeAsync(SESSION_ANALYSIS_POLL_INTERVAL_MS); });
    expect(api.getSessionStatistics).toHaveBeenCalledTimes(2);
  });
  it("stops polling after an ENDED snapshot", async () => {
    vi.useFakeTimers();
    const api = apiFor(statistics("ENDED"));
    render(<Harness api={api} />);
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(SESSION_ANALYSIS_POLL_INTERVAL_MS * 2); });
    expect(api.getSessionStatistics).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("state")).toHaveTextContent("ENDED");
  });
  it("retains the last snapshot and recovers after a transient error", async () => {
    vi.useFakeTimers();
    const api = apiFor(statistics("ACTIVE"));
    api.getSessionStatistics.mockResolvedValueOnce(statistics("ACTIVE")).mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(statistics("ACTIVE"));
    render(<Harness api={api} />);
    await act(async () => { await Promise.resolve(); await vi.advanceTimersByTimeAsync(SESSION_ANALYSIS_POLL_INTERVAL_MS); });
    expect(screen.getByTestId("state")).toHaveTextContent("ACTIVE");
    expect(screen.getByTestId("error")).toHaveTextContent("統計資料暫時無法更新。");
    await act(async () => { await vi.advanceTimersByTimeAsync(SESSION_ANALYSIS_POLL_INTERVAL_MS); });
    expect(screen.getByTestId("error")).toHaveTextContent("");
  });
});
