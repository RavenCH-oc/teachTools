import { useCallback, useEffect, useState } from "react";
import type { LocalServerStatus, LocalSession, Question, QuestionSet, SessionQuestion, TeacherApi, TeacherQuestionProgress } from "../../types/teacher";
import { LiveQuestionStatisticsPanel } from "./LiveQuestionStatisticsPanel";

export type LiveQuizApi = Required<Pick<TeacherApi, "getLocalServerStatus" | "getActiveLocalSession" | "listQuestionSets" | "listQuestions" | "startLocalSession" | "publishSessionQuestion" | "listSessionQuestions" | "openSessionQuestion" | "lockSessionQuestion" | "reopenSessionQuestion" | "revealSessionQuestion" | "getSessionQuestionProgress" | "getQuestionStatistics">>;

export function LiveQuizPage({ api, onError, onOpenSessionAnalysis }: { api: LiveQuizApi; onError: (message: string) => void; onOpenSessionAnalysis?: (session: LocalSession) => void }) {
  const [server, setServer] = useState<LocalServerStatus | null>(null);
  const [session, setSession] = useState<LocalSession | null>(null);
  const [sets, setSets] = useState<QuestionSet[]>([]); const [setId, setSetId] = useState(""); const [questions, setQuestions] = useState<Question[]>([]); const [published, setPublished] = useState<SessionQuestion[]>([]); const [progress, setProgress] = useState<Record<string, TeacherQuestionProgress>>({}); const [working, setWorking] = useState(false); const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextServer, active] = await Promise.all([api.getLocalServerStatus(), api.getActiveLocalSession()]);
      setServer(nextServer);
      setSession(active);
      if (!active || active.state === "ENDED" || !nextServer.running || active.serverInstanceId !== nextServer.serverInstanceId) {
        setSets([]);
        setPublished([]);
        return;
      }
      const [nextSets, nextPublished] = await Promise.all([api.listQuestionSets(), api.listSessionQuestions(active.id)]);
      setSets(nextSets);
      setPublished(nextPublished);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "無法載入即時測驗狀態。");
    } finally {
      setLoading(false);
    }
  }, [api, onError]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (!setId) { setQuestions([]); return; } void api.listQuestions(setId).then(setQuestions).catch((cause) => onError(cause instanceof Error ? cause.message : "Unable to read questions.")); }, [setId]);
  useEffect(() => { if (!session) return; const timer = window.setInterval(() => { const current = published.find((question) => question.state === "OPEN" || question.state === "LOCKED"); if (!current) return; void api.getSessionQuestionProgress(current.id, session.id).then((value) => setProgress((items) => ({ ...items, [current.id]: value }))).catch(() => undefined); }, 2000); return () => window.clearInterval(timer); }, [session, published]);
  const run = async (operation: () => Promise<void>) => { setWorking(true); try { await operation(); await refresh(); } catch (cause) { onError(cause instanceof Error ? cause.message : "Unable to complete question operation."); } finally { setWorking(false); } };
  if (loading) return <section className="state-card"><span className="spinner" />正在載入課堂…</section>;
  if (!server?.running || !session || session.state === "ENDED") return <section className="state-card"><h2>{"\u5373\u6642\u6e2c\u9a57"}</h2><p>{"\u8acb\u5148\u958b\u555f\u4f3a\u670d\u5668\u4e26\u5efa\u7acb\u8ab2\u5802\u3002"}</p></section>;
  if (session.serverInstanceId !== server.serverInstanceId) return <section className="state-card"><h2>課堂伺服器狀態已變更</h2><p>這個未結束課堂不屬於目前的伺服器執行個體。請到「課堂」頁結束舊課堂後，再建立新的課堂。</p></section>;
  if (session.state === "CREATED") return <section className="state-card"><h2>{"\u5373\u6642\u6e2c\u9a57"}</h2><p>請先在本機課堂頁開放等候大廳。</p></section>;
  const activeQuestion = currentQuestion(published);
  const hasOpenQuestion = published.some((question) => question.state === "OPEN" || question.state === "LOCKED");
  return <section className="live-quiz-page"><div className="page-heading compact"><div><p className="eyebrow">Teacher workspace / Live Quiz</p><h2>{session.state === "LOBBY" ? "\u6e96\u5099\u958b\u59cb\u8ab2\u5802" : "\u5373\u6642\u6e2c\u9a57"}</h2><p className="intro">{session.classroomName}</p></div>{onOpenSessionAnalysis && session.state === "ACTIVE" && <button className="button ghost" type="button" onClick={() => onOpenSessionAnalysis(session)}>課堂統計</button>}</div>
    {session.state === "LOBBY" && <button className="button primary" disabled={working} onClick={() => { if (window.confirm("\u958b\u59cb\u5f8c\u5c07\u505c\u6b62\u65b0\u5b78\u751f\u52a0\u5165\u3002")) void run(async () => { await api.startLocalSession(session.id); }); }} type="button">{"\u958b\u59cb\u8ab2\u5802"}</button>}
    {session.state === "ACTIVE" && <><section className="form-card"><h3>{"\u767c\u5e03\u984c\u76ee"}</h3><label className="field"><span>{"\u984c\u7d44"}</span><select value={setId} onChange={(event) => setSetId(event.target.value)}><option value="">{"\u9078\u64c7\u984c\u7d44"}</option>{sets.map((set) => <option key={set.id} value={set.id}>{set.title}</option>)}</select></label>{questions.map((question) => <div className="live-source-row" key={question.id}><span>{question.prompt}</span><button className="button primary" disabled={working} onClick={() => void run(async () => { await api.publishSessionQuestion(session.id, question.id); })} type="button">{"\u767c\u5e03"}</button></div>)}</section>
      <section className="list-card"><h3>{"\u672c\u6b21\u8ab2\u5802\u984c\u76ee"}</h3>{published.length === 0 ? <p>{"\u5c1a\u672a\u767c\u5e03\u984c\u76ee\u3002"}</p> : published.map((question) => <QuestionRow api={api} key={question.id} progress={progress[question.id]} question={question} active={hasOpenQuestion} working={working} run={run} />)}</section></>}
    {session.state === "ACTIVE" && activeQuestion && <LiveQuestionStatisticsPanel api={api} sessionId={session.id} question={activeQuestion} />}
  </section>;
}

function currentQuestion(questions: SessionQuestion[]): SessionQuestion | null {
  const ordered = [...questions].sort((left, right) => right.position - left.position);
  return ordered.find((question) => question.state === "OPEN" || question.state === "LOCKED") ?? ordered[0] ?? null;
}

function QuestionRow({ api, question, progress, active, working, run }: { api: LiveQuizApi; question: SessionQuestion; progress?: TeacherQuestionProgress; active: boolean; working: boolean; run: (operation: () => Promise<void>) => Promise<void> }) { return <article className="live-question-row"><div><strong>{question.position + 1}. {question.prompt}</strong><p>{question.state}{progress ? ` · ${progress.answeredCount} / ${progress.participantCount}` : ""}</p></div><div className="row-actions">{question.state === "HIDDEN" && <button className="button primary" disabled={working || active} onClick={() => void run(async () => { await api.openSessionQuestion(question.id); })} type="button">{"\u958b\u555f\u984c\u76ee"}</button>}{question.state === "OPEN" && <button className="button" disabled={working} onClick={() => void run(async () => { await api.lockSessionQuestion(question.id); })} type="button">{"\u9396\u5b9a\u984c\u76ee"}</button>}{question.state === "LOCKED" && <><button className="button ghost" disabled={working} onClick={() => void run(async () => { await api.reopenSessionQuestion(question.id); })} type="button">{"\u91cd\u65b0\u958b\u555f"}</button><button className="button primary" disabled={working} onClick={() => { if (window.confirm("\u516c\u5e03\u7b54\u6848\u5f8c\u4e0d\u53ef\u518d\u91cd\u65b0\u958b\u555f\u3002")) void run(async () => { await api.revealSessionQuestion(question.id); }); }} type="button">{"\u516c\u5e03\u7b54\u6848"}</button></>}{question.state === "REVEALED" && <span>{"\u5df2\u516c\u5e03"}</span>}</div></article>; }
