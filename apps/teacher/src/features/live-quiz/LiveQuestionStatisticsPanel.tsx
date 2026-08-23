import type { CSSProperties } from "react";
import type { QuestionStatistics, SessionQuestion, TeacherApi } from "../../types/teacher";
import { formatRate, formatScore } from "./statisticsFormatting";
import { useQuestionStatistics } from "./useQuestionStatistics";

type Props = {
  api: Required<Pick<TeacherApi, "getQuestionStatistics">>;
  sessionId: string;
  question: SessionQuestion | null;
};

export function LiveQuestionStatisticsPanel({ api, sessionId, question }: Props) {
  const state = useQuestionStatistics({ api, sessionId, question });
  if (!question) return null;
  if (question.state === "HIDDEN") {
    return <section className="live-statistics-panel" aria-label="即時統計"><h3>即時統計</h3><p className="statistics-empty">題目尚未開放作答。</p></section>;
  }
  return <StatisticsView question={question} {...state} />;
}

function StatisticsView({ question, statistics, loading, error }: { question: SessionQuestion; statistics: QuestionStatistics | null; loading: boolean; error: string | null }) {
  const hasDetails = question.state === "LOCKED" || question.state === "REVEALED";
  return <section className="live-statistics-panel" aria-label="即時統計">
    <div className="statistics-heading"><div><p className="eyebrow">目前題目</p><h3>即時統計</h3></div>{error && <span className="statistics-stale" role="status">{error}</span>}</div>
    {loading && !statistics && <p className="statistics-loading" role="status">正在更新統計…</p>}
    {!statistics && !loading && <p className="statistics-empty">暫時沒有可顯示的統計資料。</p>}
    {statistics && <>
      <ProgressSummary statistics={statistics} />
      {hasDetails && <DetailedStatistics question={question} statistics={statistics} />}
      {!hasDetails && <p className="statistics-note">作答結束後會顯示答案分析。</p>}
    </>}
  </section>;
}

function ProgressSummary({ statistics }: { statistics: QuestionStatistics }) {
  const percentage = clampRate(statistics.responseRate) * 100;
  return <div className="statistics-progress" aria-label="作答進度">
    <div className="statistics-metrics"><Metric label="已作答" value={`${statistics.answeredCount} / ${statistics.participantCount}`} /><Metric label="未作答" value={String(statistics.unansweredCount)} /><Metric label="作答率" value={formatRate(statistics.responseRate)} /></div>
    <div className="statistics-progress-track" role="progressbar" aria-label="作答率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}><span style={{ width: `${percentage}%` }} /></div>
  </div>;
}

function DetailedStatistics({ question, statistics }: { question: SessionQuestion; statistics: QuestionStatistics }) {
  const graded = statistics.gradedCount > 0;
  return <div className="statistics-details">
    <div className="statistics-metrics"><Metric label="已評分" value={String(statistics.gradedCount)} /><Metric label="待評分" value={String(statistics.pendingCount)} /><Metric label="答對" value={graded ? String(statistics.correctCount) : "—"} /><Metric label="答錯" value={graded ? String(statistics.incorrectCount) : "—"} /><Metric label="答對率" value={formatRate(graded ? statistics.accuracy : null)} /><Metric label="平均得分" value={formatScore(graded ? statistics.averageScore : null, statistics.maxPoints)} /></div>
    {statistics.choiceDistribution.length > 0 && <ChoiceDistribution question={question} statistics={statistics} />}
  </div>;
}

function ChoiceDistribution({ question, statistics }: { question: SessionQuestion; statistics: QuestionStatistics }) {
  return <div className="choice-distribution"><h4>作答分布</h4>{statistics.choiceDistribution.map((option) => { const percentage = clampRate(option.selectionRate) * 100; const style = { width: `${percentage}%` } satisfies CSSProperties; return <div className="choice-distribution-row" key={option.optionId}><div className="choice-distribution-label"><span>{option.label}</span><span>{option.selectionCount} · {formatRate(option.selectionRate)}</span></div><div className="choice-distribution-track" role="progressbar" aria-label={`${option.label} 作答率`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}><span style={style} /></div></div>; })}{question.type === "multiple_choice" && <p className="choice-distribution-note">複選題每個選項以已作答人數為分母，因此百分比總和可能超過 100%。</p>}</div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="statistics-metric"><span>{label}</span><strong>{value}</strong></div>; }

function clampRate(rate: number | null): number { return rate === null || !Number.isFinite(rate) ? 0 : Math.min(1, Math.max(0, rate)); }
