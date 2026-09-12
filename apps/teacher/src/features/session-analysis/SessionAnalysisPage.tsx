import { useMemo, useState } from "react";
import { SessionReportExport } from "./SessionReportExport";
import { PeerReviewRecordsEntry } from "../peer-review/PeerReviewMonitor";
import type { LocalSession, QuestionDifficulty, QuestionStatistics, SessionHistory, SessionQuestion, SessionStatistics } from "../../types/teacher";
import { formatRate, formatScore } from "../live-quiz/statisticsFormatting";
import { formatSessionDate } from "./SessionHistoryPage";
import { useSessionAnalysis, type SessionAnalysisApi } from "./useSessionAnalysis";

export type AnalysisSession = Pick<LocalSession, "id" | "classroomName" | "state" | "createdAt" | "endedAt"> | SessionHistory;
type Props = { api: SessionAnalysisApi; session: AnalysisSession; onBack: () => void; onPeerReview?: (id:string)=>void };

const QUESTION_TYPES: Record<string, string> = { true_false: "是非題", single_choice: "單選題", multiple_choice: "複選題", fill_blank: "填空題", essay: "論述題" };

export function SessionAnalysisPage({ api, session, onBack, onPeerReview }: Props) {
  const state = useSessionAnalysis({ api, sessionId: sessionIdOf(session), initialState: session.state });
  const snapshot = state.snapshot;
  if (state.loading && !snapshot) return <section className="state-card"><span className="spinner" />正在載入課堂統計…</section>;
  if (!snapshot) return <section className="state-card"><h2>無法載入課堂統計</h2><p>{state.error ?? "目前沒有可顯示的統計資料。"}</p><button className="button primary" type="button" onClick={state.retry}>重新載入</button></section>;

  const { statistics, difficultQuestions, questions } = snapshot;
  const currentQuestion = findCurrentQuestion(questions);
  const safeMode = statistics.sessionState === "ACTIVE" && currentQuestion?.state === "OPEN";
  return <section className="session-analysis-page">
    <div className="page-heading compact"><div><p className="eyebrow">教師工作區 / Session Analysis</p><h2>課堂統計</h2><p className="intro">{session.classroomName} · {statistics.sessionState === "ACTIVE" ? "進行中" : "已結束"} · {formatSessionDate(session.endedAt ?? session.createdAt)}</p></div><button className="button ghost" type="button" onClick={onBack}>返回{session.state === "ACTIVE" ? "即時測驗" : "課堂紀錄"}</button></div>
    {state.error && <div className="error-banner" role="status"><span>{state.error}</span><button type="button" onClick={state.retry}>重新載入</button></div>}
    {safeMode && <div className="analysis-safe-banner" role="status">目前仍在作答中，為避免投影畫面影響作答，詳細分析會在停止作答後顯示。</div>}
    {statistics.sessionState === "ENDED" && <SessionReportExport key={sessionIdOf(session)} sessionId={sessionIdOf(session)} />}
    <SummarySection statistics={statistics} safeMode={safeMode} />
    {statistics.sessionState==="ENDED" && onPeerReview && <PeerReviewRecordsEntry key={sessionIdOf(session)} sessionId={sessionIdOf(session)} onOpen={onPeerReview}/>}
    <QuestionSection statistics={statistics} questions={questions} safeMode={safeMode} />
    {!safeMode && <DifficultSection difficultQuestions={difficultQuestions} />}
    <ParticipantSection statistics={statistics} safeMode={safeMode} />
  </section>;
}

function SummarySection({ statistics, safeMode }: { statistics: SessionStatistics; safeMode: boolean }) {
  return <section className="analysis-section" aria-labelledby="analysis-summary"><div className="analysis-section-heading"><div><p className="eyebrow">Session summary</p><h3 id="analysis-summary">課堂摘要</h3></div></div><div className="analysis-metrics"><Metric label="參與學生" value={String(statistics.participantCount)} /><Metric label="可作答題數" value={String(statistics.eligibleQuestionCount)} /><Metric label="作答機會" value={`${statistics.answeredOpportunityCount} / ${statistics.totalOpportunityCount}`} /><Metric label="整體作答率" value={formatRate(statistics.responseRate)} />{!safeMode && <><Metric label="已評分作答" value={String(statistics.gradedSubmissionCount)} /><Metric label="待評分作答" value={String(statistics.pendingSubmissionCount)} /><Metric label="答對" value={statistics.gradedSubmissionCount ? String(statistics.correctCount) : "—"} /><Metric label="答錯" value={statistics.gradedSubmissionCount ? String(statistics.incorrectCount) : "—"} /><Metric label="答對率" value={formatRate(statistics.gradedSubmissionCount ? statistics.accuracy : null)} /><Metric label="已評分得分" value={statistics.gradedPossibleScoreTotal > 0 ? formatScore(statistics.earnedScoreTotal, statistics.gradedPossibleScoreTotal) : "—"} /><Metric label="得分率" value={statistics.gradedPossibleScoreTotal > 0 ? formatRate(statistics.scoreRate) : "—"} /></>}</div></section>;
}

function QuestionSection({ statistics, questions, safeMode }: { statistics: SessionStatistics; questions: SessionQuestion[]; safeMode: boolean }) {
  const ordered = useMemo(() => [...statistics.questionSummaries].sort((left, right) => left.position - right.position || left.sessionQuestionId.localeCompare(right.sessionQuestionId)), [statistics.questionSummaries]);
  const snapshots = useMemo(() => new Map(questions.map((question) => [question.id, question])), [questions]);
  return <section className="analysis-section" aria-labelledby="analysis-questions"><div className="analysis-section-heading"><div><p className="eyebrow">Question analysis</p><h3 id="analysis-questions">逐題分析</h3></div></div>{ordered.length === 0 ? <p className="analysis-empty">目前沒有已發布題目。</p> : <div className="analysis-table-scroll"><table className="analysis-table"><caption className="sr-only">逐題作答與評分分析</caption><thead><tr><th scope="col">題號 / 題型</th><th scope="col">已作答</th><th scope="col">作答率</th><th scope="col">已評分</th><th scope="col">待評分</th><th scope="col">答對率</th><th scope="col">平均得分</th><th scope="col">分布</th></tr></thead><tbody>{ordered.map((item) => <QuestionRow key={item.sessionQuestionId} item={item} snapshot={snapshots.get(item.sessionQuestionId)} safeMode={safeMode} />)}</tbody></table></div>}</section>;
}

function QuestionRow({ item, snapshot, safeMode }: { item: QuestionStatistics; snapshot?: SessionQuestion; safeMode: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const prompt = snapshot?.prompt ?? item.prompt;
  const distributionId = `distribution-${item.sessionQuestionId}`;
  return <><tr><th scope="row"><span className="analysis-question-number">{item.position + 1}</span><span title={prompt}>{truncate(prompt)}</span><small>{QUESTION_TYPES[snapshot?.type ?? item.questionType] ?? item.questionType}</small></th><td>{item.answeredCount} / {item.participantCount}</td><td>{formatRate(item.responseRate)}</td><td>{safeMode ? "—" : String(item.gradedCount)}</td><td>{safeMode ? "—" : String(item.pendingCount)}</td><td>{safeMode || item.gradedCount === 0 ? "—" : formatRate(item.accuracy)}</td><td>{safeMode || item.gradedCount === 0 || item.maxPoints <= 0 ? "—" : formatScore(item.averageScore, item.maxPoints)}</td><td>{!safeMode && item.choiceDistribution.length > 0 && <button className="text-button" type="button" aria-expanded={expanded} aria-controls={distributionId} onClick={() => setExpanded((value) => !value)}>{expanded ? "收合分布" : "查看作答分布"}</button>}</td></tr>{expanded && !safeMode && <tr id={distributionId}><td colSpan={8}><ChoiceDistribution item={item} questionType={snapshot?.type ?? item.questionType} /></td></tr>}</>;
}

function ChoiceDistribution({ item, questionType }: { item: QuestionStatistics; questionType: string }) {
  return <div className="analysis-distribution">{item.choiceDistribution.map((option) => <div className="choice-distribution-row" key={option.optionId}><div className="choice-distribution-label"><span>{option.label}</span><span>{option.selectionCount} · {formatRate(option.selectionRate)}</span></div><div className="choice-distribution-track" role="progressbar" aria-label={`${option.label} 作答率`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={clampRate(option.selectionRate) * 100}><span style={{ width: `${clampRate(option.selectionRate) * 100}%` }} /></div></div>)}{questionType === "multiple_choice" && <p className="choice-distribution-note">複選題每個選項以已作答人數為分母，因此百分比總和可能超過 100%。</p>}</div>;
}

function DifficultSection({ difficultQuestions }: { difficultQuestions: QuestionDifficulty[] }) {
  const top = difficultQuestions.slice(0, 5);
  return <section className="analysis-section" aria-labelledby="analysis-difficult"><div className="analysis-section-heading"><div><p className="eyebrow">Difficulty</p><h3 id="analysis-difficult">易錯題</h3></div></div>{top.length === 0 ? <p className="analysis-empty">目前沒有可計算的易錯題。</p> : <ol className="difficult-list">{top.map((item) => <li key={item.sessionQuestionId}><span>{item.position + 1}. {truncate(item.prompt)}</span><strong>{formatRate(item.accuracy)} · {item.gradedCount} 份已評分</strong></li>)}</ol>}</section>;
}

function ParticipantSection({ statistics, safeMode }: { statistics: SessionStatistics; safeMode: boolean }) {
  const ordered = useMemo(() => [...statistics.participantSummaries].sort((left, right) => left.seatNumber - right.seatNumber || left.displayName.localeCompare(right.displayName) || left.participantId.localeCompare(right.participantId)), [statistics.participantSummaries]);
  return <section className="analysis-section" aria-labelledby="analysis-participants"><div className="analysis-section-heading"><div><p className="eyebrow">Participants</p><h3 id="analysis-participants">學生統計</h3></div></div>{ordered.length === 0 ? <p className="analysis-empty">目前沒有學生參與這堂課。</p> : <div className="analysis-table-scroll"><table className="analysis-table participant-table"><caption className="sr-only">學生作答與評分統計</caption><thead><tr><th scope="col">座號 / 姓名</th><th scope="col">已作答</th><th scope="col">可作答</th><th scope="col">未作答</th>{!safeMode && <><th scope="col">已評分</th><th scope="col">待評分</th><th scope="col">答對</th><th scope="col">答錯</th><th scope="col">答對率</th><th scope="col">已評分得分</th><th scope="col">得分率</th></>}</tr></thead><tbody>{ordered.map((item) => <tr key={item.participantId}><th scope="row"><span className="analysis-question-number">{item.seatNumber}</span>{item.displayName}</th><td>{item.answeredCount}</td><td>{item.eligibleQuestionCount}</td><td>{item.unansweredCount}</td>{!safeMode && <><td>{item.gradedCount}</td><td>{item.pendingCount}</td><td>{item.gradedCount ? item.correctCount : "—"}</td><td>{item.gradedCount ? item.incorrectCount : "—"}</td><td>{formatRate(item.gradedCount ? item.accuracy : null)}</td><td>{item.gradedPossibleScore > 0 ? formatScore(item.earnedScore, item.gradedPossibleScore) : "—"}</td><td>{item.gradedPossibleScore > 0 ? formatRate(item.scoreRate) : "—"}</td></>}</tr>)}</tbody></table></div>}</section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="analysis-metric"><span>{label}</span><strong>{value}</strong></div>; }
function findCurrentQuestion(questions: SessionQuestion[]): SessionQuestion | null { const ordered = [...questions].sort((left, right) => right.position - left.position || right.id.localeCompare(left.id)); return ordered.find((question) => question.state === "OPEN" || question.state === "LOCKED") ?? ordered[0] ?? null; }
function truncate(value: string): string { return value.length > 90 ? `${value.slice(0, 87)}…` : value; }
function clampRate(value: number | null): number { return value === null || !Number.isFinite(value) ? 0 : Math.min(1, Math.max(0, value)); }
function sessionIdOf(session: AnalysisSession): string { return "id" in session ? session.id : session.sessionId; }
