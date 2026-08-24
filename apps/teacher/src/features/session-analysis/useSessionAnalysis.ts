import { useCallback, useEffect, useState } from "react";
import type { QuestionDifficulty, SessionQuestion, SessionStatistics, TeacherApi } from "../../types/teacher";

export const SESSION_ANALYSIS_POLL_INTERVAL_MS = 2000;
export type SessionAnalysisApi = Required<Pick<TeacherApi, "getSessionStatistics" | "getDifficultQuestions" | "listSessionQuestions">>;
export interface SessionAnalysisSnapshot { statistics: SessionStatistics; difficultQuestions: QuestionDifficulty[]; questions: SessionQuestion[] }
export interface SessionAnalysisState { snapshot: SessionAnalysisSnapshot | null; loading: boolean; error: string | null; retry: () => void }

export function useSessionAnalysis({ api, sessionId, initialState }: { api: SessionAnalysisApi; sessionId: string; initialState?: string }): SessionAnalysisState {
  const [snapshot, setSnapshot] = useState<SessionAnalysisSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let timer: number | undefined;
    let inFlight = false;
    let shouldPoll = initialState === "ACTIVE";
    const schedule = () => {
      if (disposed || !shouldPoll || timer !== undefined) return;
      timer = window.setTimeout(() => { timer = undefined; void fetchSnapshot(); }, SESSION_ANALYSIS_POLL_INTERVAL_MS);
    };
    const fetchSnapshot = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      const requestGeneration = generation;
      try {
        const [statistics, difficultQuestions, questions] = await Promise.all([
          api.getSessionStatistics(sessionId), api.getDifficultQuestions(sessionId), api.listSessionQuestions(sessionId),
        ]);
        if (disposed || requestGeneration !== generation) return;
        setSnapshot({ statistics, difficultQuestions, questions });
        setError(null);
        shouldPoll = statistics.sessionState === "ACTIVE";
      } catch {
        if (!disposed && requestGeneration === generation) setError("統計資料暫時無法更新。");
      } finally {
        inFlight = false;
        if (!disposed && requestGeneration === generation) { setLoading(false); schedule(); }
      }
    };
    setSnapshot(null); setError(null); setLoading(true); void fetchSnapshot();
    return () => { disposed = true; generation += 1; if (timer !== undefined) window.clearTimeout(timer); };
  }, [api, attempt, initialState, sessionId]);

  return { snapshot, loading, error, retry };
}
