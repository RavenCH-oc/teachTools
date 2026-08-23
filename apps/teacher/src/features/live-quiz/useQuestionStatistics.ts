import { useEffect, useRef, useState } from "react";
import type { QuestionStatistics, SessionQuestion, TeacherApi } from "../../types/teacher";

const POLL_INTERVAL_MS = 1000;
const ELIGIBLE_STATES = new Set<SessionQuestion["state"]>(["OPEN", "LOCKED", "REVEALED"]);

type StatisticsApi = Required<Pick<TeacherApi, "getQuestionStatistics">>;

interface Options {
  api: StatisticsApi;
  sessionId: string;
  question: SessionQuestion | null;
}

export interface QuestionStatisticsState {
  statistics: QuestionStatistics | null;
  loading: boolean;
  error: string | null;
}

export function useQuestionStatistics({ api, sessionId, question }: Options): QuestionStatisticsState {
  const [state, setState] = useState<QuestionStatisticsState>({ statistics: null, loading: false, error: null });
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const questionId = question?.id;
    const questionState = question?.state;
    if (!sessionId || !questionId || !questionState || !ELIGIBLE_STATES.has(questionState)) {
      setState({ statistics: null, loading: false, error: null });
      return;
    }

    let disposed = false;
    let inFlight = false;
    let timer: number | undefined;
    setState({ statistics: null, loading: true, error: null });

    const schedule = () => {
      if (!disposed) timer = window.setTimeout(() => { void fetchStatistics(false); }, POLL_INTERVAL_MS);
    };
    const fetchStatistics = async (initial: boolean) => {
      if (disposed || inFlight) return;
      inFlight = true;
      if (initial) setState((current) => ({ ...current, loading: true }));
      try {
        const statistics = await api.getQuestionStatistics(sessionId, questionId);
        if (!disposed && generationRef.current === generation) {
          setState({ statistics, loading: false, error: null });
        }
      } catch {
        if (!disposed && generationRef.current === generation) {
          setState((current) => ({ statistics: current.statistics, loading: false, error: "暫時無法更新統計資料。" }));
        }
      } finally {
        inFlight = false;
        schedule();
      }
    };

    void fetchStatistics(true);
    return () => {
      disposed = true;
      generationRef.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, question?.id, question?.state, sessionId]);

  return state;
}

export { POLL_INTERVAL_MS };
