import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionStatistics, SessionQuestion, TeacherApi } from "../../types/teacher";
import { useQuestionStatistics, POLL_INTERVAL_MS } from "./useQuestionStatistics";

function question(id: string, state: SessionQuestion["state"] = "OPEN"): SessionQuestion {
  return { id, sessionId: "session-1", sourceQuestionId: null, type: "true_false", prompt: id, points: 1, position: 0, answerConfig: { correctAnswer: true }, gradingConfig: {}, metadata: {}, configVersion: 1, state, createdAt: "2026-08-11T00:00:00Z", openedAt: null, lockedAt: null, revealedAt: null, assets: [] };
}

function statistics(id: string): QuestionStatistics {
  return { sessionQuestionId: id, position: 0, questionType: "true_false", prompt: id, participantCount: 1, answeredCount: 1, unansweredCount: 0, responseRate: 1, gradedCount: 1, pendingCount: 0, correctCount: 1, incorrectCount: 0, accuracy: 1, averageScore: 1, maxPoints: 1, choiceDistribution: [] };
}

function Harness({ api, currentQuestion, sessionId = "session-1" }: { api: Required<Pick<TeacherApi, "getQuestionStatistics">>; currentQuestion: SessionQuestion | null; sessionId?: string }) {
  const state = useQuestionStatistics({ api, sessionId, question: currentQuestion });
  return <div><span data-testid="statistics">{state.statistics?.sessionQuestionId ?? "none"}</span><span data-testid="loading">{String(state.loading)}</span><span data-testid="error">{state.error ?? ""}</span></div>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe("useQuestionStatistics", () => {
  afterEach(() => vi.useRealTimers());

  it("fetches immediately, then polls at the configured interval", async () => {
    vi.useFakeTimers();
    const first = deferred<QuestionStatistics>();
    const api = { getQuestionStatistics: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(statistics("q-1")) };
    render(<Harness api={api} currentQuestion={question("q-1")} />);
    expect(api.getQuestionStatistics).toHaveBeenCalledTimes(1);

    await act(async () => { first.resolve(statistics("q-1")); await first.promise; });
    expect(screen.getByTestId("statistics")).toHaveTextContent("q-1");
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(api.getQuestionStatistics).toHaveBeenCalledTimes(2);
  });

  it("never overlaps an in-flight request", async () => {
    vi.useFakeTimers();
    const first = deferred<QuestionStatistics>();
    const api = { getQuestionStatistics: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(statistics("q-1")) };
    render(<Harness api={api} currentQuestion={question("q-1")} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5); });
    expect(api.getQuestionStatistics).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(statistics("q-1")); await first.promise; });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(api.getQuestionStatistics).toHaveBeenCalledTimes(2);
  });

  it("cleans up polling when the question unmounts", async () => {
    vi.useFakeTimers();
    const first = deferred<QuestionStatistics>();
    const api = { getQuestionStatistics: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(statistics("q-1")) };
    const view = render(<Harness api={api} currentQuestion={question("q-1")} />);
    view.unmount();
    await act(async () => { first.resolve(statistics("q-1")); await first.promise; await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2); });
    expect(api.getQuestionStatistics).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale result after the current question changes", async () => {
    const first = deferred<QuestionStatistics>();
    const second = deferred<QuestionStatistics>();
    const api = { getQuestionStatistics: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) };
    const view = render(<Harness api={api} currentQuestion={question("q-1")} />);
    view.rerender(<Harness api={api} currentQuestion={question("q-2")} />);
    await act(async () => { first.resolve(statistics("q-1")); await first.promise; });
    expect(screen.getByTestId("statistics")).toHaveTextContent("none");
    await act(async () => { second.resolve(statistics("q-2")); await second.promise; });
    expect(screen.getByTestId("statistics")).toHaveTextContent("q-2");
  });

  it("retains the last snapshot across a transient error and clears it after recovery", async () => {
    vi.useFakeTimers();
    const api = { getQuestionStatistics: vi.fn().mockResolvedValueOnce(statistics("q-1")).mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(statistics("q-1")) };
    render(<Harness api={api} currentQuestion={question("q-1")} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("statistics")).toHaveTextContent("q-1");
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(screen.getByTestId("statistics")).toHaveTextContent("q-1");
    expect(screen.getByTestId("error")).toHaveTextContent("暫時無法更新統計資料。");
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(screen.getByTestId("statistics")).toHaveTextContent("q-1");
    expect(screen.getByTestId("error")).toHaveTextContent("");
  });

  it("stops polling when the session ends", async () => {
    vi.useFakeTimers();
    const first = deferred<QuestionStatistics>();
    const api = { getQuestionStatistics: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(statistics("q-1")) };
    const view = render(<Harness api={api} currentQuestion={question("q-1")} />);
    view.rerender(<Harness api={api} currentQuestion={question("q-1")} sessionId="" />);
    await act(async () => { first.resolve(statistics("q-1")); await first.promise; await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2); });
    expect(api.getQuestionStatistics).toHaveBeenCalledTimes(1);
  });

  it("does not poll hidden or absent questions", () => {
    const api = { getQuestionStatistics: vi.fn() };
    const { rerender } = render(<Harness api={api} currentQuestion={question("q-1", "HIDDEN")} />);
    expect(api.getQuestionStatistics).not.toHaveBeenCalled();
    rerender(<Harness api={api} currentQuestion={null} />);
    expect(api.getQuestionStatistics).not.toHaveBeenCalled();
  });
});
