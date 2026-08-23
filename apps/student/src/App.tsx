import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { APP_NAME } from "@classtools/shared";
import type { QuestionPublicView, ServerMessage, SessionPublicView, StudentAnswer } from "@classtools/backend-contract";
import { clearParticipant, createParticipantTransport, fetchSessionAsset, getJoinInfo, joinClassroom, saveParticipant, secureUuid, storedParticipant, storedParticipantForJoinCode, StudentApiError, type ParticipantTransport, type StoredParticipant, type SubmitAnswerResult } from "./services/studentApi";

type Screen = "loading" | "join" | "joining" | "connecting" | "resuming" | "lobby" | "live" | "ended" | "error";
type Latest = { submissionId: string; revision: number; gradingStatus: "graded" | "pending"; isCorrect: boolean | null; score: number | null; maxScore: number; answer: StudentAnswer };
type Pending = { submissionId: string; sessionQuestionId: string; answer: StudentAnswer; maxScore: number };
type SubmissionState = { status: "idle" } | { status: "pending-not-sent"; pending: Pending } | { status: "pending-sent-awaiting-ack"; pending: Pending };
type RevealedQuestion = Extract<ServerMessage, { type: "question_revealed" }>["reveal"];

function nextSubmissionState(pending: Pending, result: SubmitAnswerResult): { state: SubmissionState; error: string } {
  if (result === "sent") return { state: { status: "pending-sent-awaiting-ack", pending }, error: "" };
  if (result === "serialization_failed") return { state: { status: "idle" }, error: "無法建立作答資料，請重新選擇後再試。" };
  return { state: { status: "pending-not-sent", pending }, error: "連線暫時中斷，恢復後會重試送出。" };
}

export function App() {
  const joinCode = useMemo(() => joinCodeFromPath(window.location.pathname), []);
  const [manualCode, setManualCode] = useState(""); const [info, setInfo] = useState<SessionPublicView | null>(null);
  const [screen, setScreen] = useState<Screen>(joinCode ? "loading" : "join"); const [seatNumber, setSeatNumber] = useState(""); const [name, setName] = useState("");
  const [participant, setParticipant] = useState<StoredParticipant | null>(null); const [error, setError] = useState(""); const [reconnecting, setReconnecting] = useState(false);
  const [question, setQuestion] = useState<QuestionPublicView | null>(null); const [reveal, setReveal] = useState<RevealedQuestion | null>(null);
  const [latest, setLatest] = useState<Latest | null>(null); const [submission, setSubmission] = useState<SubmissionState>({ status: "idle" }); const submissionRef = useRef<SubmissionState>({ status: "idle" }); const transportRef = useRef<ParticipantTransport | null>(null);

  useEffect(() => {
    if (!joinCode) return;
    const resume = storedParticipantForJoinCode(joinCode);
    if (resume) {
      setInfo(resume.info);
      setParticipant(resume.participant);
      setScreen("resuming");
      return;
    }
    let active = true;
    void getJoinInfo(joinCode).then((next) => {
      if (!active) return;
      setInfo(next);
      const existing = storedParticipant(next);
      if (existing) {
        saveParticipant(next, existing, joinCode);
        setParticipant(existing);
        setScreen("connecting");
      } else setScreen("join");
    }).catch((cause) => {
      if (active) {
        setError(joinInfoMessage(cause));
        setScreen("error");
      }
    });
    return () => { active = false; };
  }, [joinCode]);

  useEffect(() => {
    if (info && participant && joinCode) saveParticipant(info, participant, joinCode);
  }, [info, joinCode, participant]);

  useEffect(() => {
    if (!info || !participant) return;
    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: number | undefined;
    let reconnectingNow = false;
    let transport: ParticipantTransport | null = null;
    const setSubmissionState = (next: SubmissionState) => { submissionRef.current = next; setSubmission(next); };
    const currentPending = (): Pending | null => submissionRef.current.status === "idle" ? null : submissionRef.current.pending;
    const retryPending = () => {
      const pending = currentPending();
      if (!pending || !transport) return;
      const next = nextSubmissionState(pending, transport.submitAnswer(pending.submissionId, pending.sessionQuestionId, pending.answer));
      setSubmissionState(next.state);
      setError(next.error);
    };
    const scheduleReconnect = () => {
      if (reconnectTimer !== undefined || !transport) return;
      reconnectingNow = true;
      setReconnecting(true);
      transport.markReconnectScheduled();
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        if (!cancelled) transport?.start();
      }, [1000, 2000, 5000][Math.min(attempt++, 2)]);
    };
    const apply = (event: ServerMessage) => {
      if (cancelled) return;
      if (event.type === "participant_authenticated" && event.sessionState === "LOBBY") setScreen("lobby");
      if (event.type === "session_sync") { setQuestion(event.sync.currentQuestion); setLatest(event.sync.ownLatestSubmission as Latest | null); setReveal(event.sync.reveal); setScreen(event.sync.sessionState === "ACTIVE" ? "live" : event.sync.sessionState === "ENDED" ? "ended" : "lobby"); }
      if (event.type === "session_state_changed") { if (event.state === "ACTIVE") setScreen("live"); if (event.state === "ENDED") setScreen("ended"); }
      if (event.type === "question_state_changed") { setQuestion(event.question); if (event.question.state !== "REVEALED") setReveal(null); }
      if (event.type === "question_revealed") { setQuestion(event.reveal); setReveal(event.reveal); }
      if (event.type === "submission_acknowledged") {
        const pending = currentPending();
        if (pending?.submissionId === event.acknowledgement.submissionId) {
          setLatest({ submissionId: event.acknowledgement.submissionId, revision: event.acknowledgement.revision, gradingStatus: event.acknowledgement.gradingStatus, isCorrect: null, score: null, maxScore: pending.maxScore, answer: pending.answer });
          setSubmissionState({ status: "idle" });
          setError("");
        }
      }
      if (event.type === "error" && currentPending()) {
        setSubmissionState({ status: "idle" });
        setError(submissionErrorMessage(event.code));
      }
      if (event.type === "submission_result") setLatest(event.result as Latest);
    };
    transport = createParticipantTransport(participant, {
      onAuthenticated: () => {
        if (cancelled) return;
        attempt = 0;
        reconnectingNow = false;
        setReconnecting(false);
        retryPending();
      },
      onEnded: () => { if (!cancelled) { reconnectingNow = false; clearParticipant(info, joinCode); setParticipant(null); setScreen("ended"); } },
      onDisconnected: (reason) => {
        if (cancelled) return;
        if (reason === "AUTH_FAILED" || reason === "SESSION_ENDED" || reason === "SERVER_INSTANCE_MISMATCH") {
          reconnectingNow = false;
          clearParticipant(info, joinCode);
          setParticipant(null);
          setError(reason === "SESSION_ENDED" ? "課堂已結束。" : "登入狀態已失效，請重新加入課堂。");
          setScreen("join");
          return;
        }
        scheduleReconnect();
      },
      onMessage: apply,
      onMessageError: () => { if (!cancelled) setError("課堂更新暫時無法顯示，連線仍保持中。"); },
    });
    const retryWhenOnline = () => {
      if (cancelled || !transport || !reconnectingNow || transport.currentConnection()?.authenticated) return;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      transport.retryReconnectNow();
    };
    transportRef.current = transport;
    window.addEventListener("online", retryWhenOnline);
    transport.start();
    return () => {
      cancelled = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      window.removeEventListener("online", retryWhenOnline);
      transport?.close();
      if (transportRef.current === transport) transportRef.current = null;
    };
  }, [info, joinCode, participant]);

  const submitManual = (event: FormEvent) => { event.preventDefault(); const code = manualCode.trim().toUpperCase(); if (/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(code)) window.location.assign(`/student/join/${code}`); else setError("請輸入 8 碼課堂代碼。"); };
  const submitJoin = async (event: FormEvent) => { event.preventDefault(); const seat = Number(seatNumber); if (!info || !Number.isInteger(seat) || seat <= 0 || !name.trim()) { setError("請輸入正確的座號與姓名。"); return; } setScreen("joining"); setError(""); try { const joined = await joinClassroom(joinCode, seat, name); saveParticipant(info, joined, joinCode); setParticipant(joined); setScreen("connecting"); } catch (cause) { setError(message(cause)); setScreen("join"); } };
  const submitAnswer = (answer: StudentAnswer) => {
    if (!question || question.state !== "OPEN") return;
    let submissionId: string;
    try { submissionId = secureUuid(); } catch { setError("此瀏覽器無法安全建立作答識別碼，請更新瀏覽器後再試。"); return; }
    const pending = { submissionId, sessionQuestionId: question.sessionQuestionId, answer, maxScore: question.points };
    submissionRef.current = { status: "pending-not-sent", pending };
    setSubmission({ status: "pending-not-sent", pending });
    setError("");
    const next = nextSubmissionState(pending, transportRef.current?.submitAnswer(pending.submissionId, pending.sessionQuestionId, pending.answer) ?? "transport_unavailable");
    submissionRef.current = next.state;
    setSubmission(next.state);
    setError(next.error);
  };

  if (!joinCode) return <main className="student-shell"><section className="student-card"><p className="eyebrow">學生端</p><h1>{APP_NAME}</h1><p>請輸入老師提供的課堂代碼。</p><form onSubmit={submitManual}><Field id="manual-code" label="課堂代碼" value={manualCode} onChange={setManualCode} /><button className="join-button" type="submit">前往課堂</button></form>{error && <p role="alert">{error}</p>}</section></main>;
  if (screen === "loading") return <State title="正在讀取課堂…" />; if (screen === "error") return <State title="無法加入課堂" detail={error} />; if (screen === "ended") return <State title="課堂已結束" detail="老師已結束這堂課，無法再送出答案。" />; if (!info) return <State title="正在讀取課堂…" />;
  if (screen === "resuming") return <State title="正在恢復課堂…" detail={reconnecting ? "網路中斷，正在重新連線…" : undefined} />;
  if (screen === "connecting") return <State title="正在驗證登入狀態…" detail={reconnecting ? "網路中斷，正在重新連線…" : undefined} />;
  if (screen === "lobby") return <main className="student-shell"><section className="student-card"><p className="eyebrow">{info.classroomName}</p><h1>已加入課堂</h1><p>座號：{participant?.participant.seatNumber}</p><p>姓名：{participant?.participant.displayName}</p><p>{reconnecting ? "連線中斷，正在重新連線…" : "等待老師開始課堂…"}</p></section></main>;
  if (screen === "live") return <main className="student-shell"><section className="student-card"><p className="eyebrow">{info.classroomName}</p><h1>{question ? "目前題目" : "課堂已開始"}</h1>{error && <p className="student-error" role="alert">{error}</p>}{question ? <LiveQuestion participant={participant} question={question} latest={latest} pending={submission.status !== "idle"} reveal={reveal} onSubmit={submitAnswer} /> : <p>等待老師發布題目…</p>}{reconnecting && <p role="status">連線中斷，正在重新連線…</p>}</section></main>;
  return <main className="student-shell"><section className="student-card"><p className="eyebrow">{info.classroomName}</p><h1>加入課堂</h1><form onSubmit={submitJoin}><Field id="seat-number" label="座號" value={seatNumber} onChange={setSeatNumber} numeric /><Field id="student-name" label="姓名" value={name} onChange={setName} /><button className="join-button" disabled={screen === "joining"} type="submit">{screen === "joining" ? "加入中…" : "加入課堂"}</button></form>{error && <p role="alert">{error}</p>}</section></main>;
}

function LiveQuestion({ participant, question, latest, pending, reveal, onSubmit }: { participant: StoredParticipant | null; question: QuestionPublicView; latest: Latest | null; pending: boolean; reveal: RevealedQuestion | null; onSubmit: (answer: StudentAnswer) => void }) {
  const [trueFalse, setTrueFalse] = useState<boolean | null>(null); const [single, setSingle] = useState(""); const [multiple, setMultiple] = useState<string[]>([]); const [blanks, setBlanks] = useState<Record<string, string>>({}); const [essay, setEssay] = useState("");
  useEffect(() => { const value = latest?.answer; setTrueFalse(value?.type === "true_false" ? value.value : null); setSingle(value?.type === "single_choice" ? value.optionId : ""); setMultiple(value?.type === "multiple_choice" ? value.optionIds : []); setBlanks(value?.type === "fill_blank" ? value.values : {}); setEssay(value?.type === "essay" ? value.text : ""); }, [question.sessionQuestionId, latest?.revision]);
  const editable = question.state === "OPEN" && !pending;
  const answer: StudentAnswer | null = question.type === "true_false" ? (trueFalse === null ? null : { type: "true_false", value: trueFalse }) : question.type === "single_choice" ? (single ? { type: "single_choice", optionId: single } : null) : question.type === "multiple_choice" ? { type: "multiple_choice", optionIds: multiple } : question.type === "fill_blank" ? { type: "fill_blank", values: blanks } : { type: "essay", text: essay };
  return <div className="live-question"><p>{question.prompt}</p><SessionAssets assets={question.assets} participant={participant} />
    {question.type === "true_false" && <div aria-label="答案選項" className="answer-controls" role="group"><button aria-pressed={trueFalse === true} className={trueFalse === true ? "selected" : ""} disabled={!editable} onClick={() => setTrueFalse(true)} type="button">{"\u6b63\u78ba"}</button><button aria-pressed={trueFalse === false} className={trueFalse === false ? "selected" : ""} disabled={!editable} onClick={() => setTrueFalse(false)} type="button">{"\u932f\u8aa4"}</button></div>}
    {question.type === "single_choice" && question.options.map((option) => <label key={option.id}><input checked={single === option.id} disabled={!editable} name="single" onChange={() => setSingle(option.id)} type="radio" />{option.text}</label>)}
    {question.type === "multiple_choice" && question.options.map((option) => <label key={option.id}><input checked={multiple.includes(option.id)} disabled={!editable} onChange={() => setMultiple((items) => items.includes(option.id) ? items.filter((id) => id !== option.id) : [...items, option.id])} type="checkbox" />{option.text}</label>)}
    {question.type === "fill_blank" && question.blanks.map((blank) => <Field key={blank} id={`blank-${blank}`} label={blank} value={blanks[blank] ?? ""} onChange={(value) => { setBlanks((items) => ({ ...items, [blank]: value })); }} />)}
    {question.type === "essay" && <textarea disabled={!editable} onChange={(event) => setEssay(event.target.value)} rows={7} value={essay} />}
    {question.state === "OPEN" && <button className="join-button" disabled={!editable || !answer} onClick={() => answer && onSubmit(answer)} type="button">{pending ? "\u9001\u51fa\u4e2d\u2026" : latest ? "\u66f4\u65b0\u7b54\u6848" : "\u9001\u51fa\u7b54\u6848"}</button>}
    {question.state === "LOCKED" && <p>{"\u8001\u5e2b\u5df2\u9396\u5b9a\u984c\u76ee\uff0c\u7121\u6cd5\u518d\u4fee\u6539\u7b54\u6848\u3002"}</p>}
    {question.state === "REVEALED" && <RevealSummary question={question} reveal={reveal} latest={latest} />}
    {latest && question.state !== "REVEALED" && <p role="status">答案已送出。</p>}
  </div>;
}
function RevealSummary({ question, reveal, latest }: { question: QuestionPublicView; reveal: RevealedQuestion | null; latest: Latest | null }) {
  if (!reveal) return <p>題目已公布結果。</p>;
  return <section className="student-reveal" aria-label="公布結果"><p>答案已公布。</p><p><strong>正確答案：</strong>{correctAnswerText(question, reveal.correctAnswer)}</p>{latest ? <><p><strong>你的作答：</strong>{answerText(question, latest.answer)}</p><p>{latest.gradingStatus === "pending" ? "本題等待老師評閱。" : `結果：${latest.isCorrect ? "答對" : "答錯"}，得分 ${latest.score ?? 0} / ${latest.maxScore}`}</p></> : <p>你尚未送出答案。</p>}</section>;
}
function correctAnswerText(question: QuestionPublicView, answer: unknown): string {
  if (answer === null) return "本題由老師評閱，不提供標準答案。";
  if (question.type === "true_false" && typeof answer === "boolean") return answer ? "正確" : "錯誤";
  if (question.type === "single_choice" && typeof answer === "string") return question.options.find((option) => option.id === answer)?.text ?? answer;
  if (question.type === "multiple_choice" && Array.isArray(answer)) return answer.map((id) => typeof id === "string" ? question.options.find((option) => option.id === id)?.text ?? id : "").filter(Boolean).join("、");
  if (question.type === "fill_blank" && Array.isArray(answer)) return answer.map((item) => isRecord(item) && typeof item.id === "string" && Array.isArray(item.acceptedAnswers) ? `${item.id}：${item.acceptedAnswers.filter((value): value is string => typeof value === "string").join("／")}` : "").filter(Boolean).join("；");
  return "未提供";
}
function answerText(question: QuestionPublicView, answer: StudentAnswer): string {
  if (answer.type === "true_false") return answer.value ? "正確" : "錯誤";
  if (answer.type === "single_choice") return question.options.find((option) => option.id === answer.optionId)?.text ?? answer.optionId;
  if (answer.type === "multiple_choice") return answer.optionIds.map((id) => question.options.find((option) => option.id === id)?.text ?? id).join("、");
  if (answer.type === "fill_blank") return Object.entries(answer.values).map(([blank, value]) => `${blank}：${value}`).join("；");
  return answer.text || "（未填寫）";
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function SessionAssets({ assets, participant }: { assets: QuestionPublicView["assets"]; participant: StoredParticipant | null }) {
  return <div className="live-question-media" aria-label="題目附件">
    {assets.map((asset) => asset.assetType === "image" ? <ProtectedImage assetId={asset.id} displayName={asset.displayName} key={asset.id} participant={participant} /> : <ProtectedPdf assetId={asset.id} displayName={asset.displayName} key={asset.id} participant={participant} />)}
  </div>;
}

function ProtectedImage({ assetId, displayName, participant }: { assetId: string; displayName: string; participant: StoredParticipant | null }) {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [viewerOpen, setViewerOpen] = useState(false);
  useEffect(() => {
    if (!participant) { setState("error"); return; }
    let active = true;
    let objectUrl = "";
    setState("loading");
    setUrl("");
    void fetchSessionAsset(assetId, participant)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (!active) { URL.revokeObjectURL(objectUrl); return; }
        setUrl(objectUrl);
        setState("ready");
      })
      .catch(() => { if (active) setState("error"); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, attempt, participant]);
  useEffect(() => {
    if (!viewerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setViewerOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [viewerOpen]);
  if (state === "error") return <div className="live-question-media-error" role="status"><span>圖片載入失敗</span><button className="text-button" onClick={() => setAttempt((value) => value + 1)} type="button">重新載入</button></div>;
  if (state !== "ready" || !url) return <p className="live-question-media-loading">正在載入圖片…</p>;
  return <>
    <button aria-label={`查看圖片：${displayName}`} className="live-question-image-button" onClick={() => setViewerOpen(true)} type="button"><img alt={displayName} className="live-question-image" src={url} /></button>
    {viewerOpen && <ImageViewer displayName={displayName} onClose={() => setViewerOpen(false)} onOpenOriginal={() => { window.open(url, "_blank", "noopener,noreferrer"); }} url={url} />}
  </>;
}

function ImageViewer({ displayName, onClose, onOpenOriginal, url }: { displayName: string; onClose: () => void; onOpenOriginal: () => void; url: string }) {
  return <div aria-label="圖片檢視器" aria-modal="true" className="image-viewer-backdrop" onClick={onClose} role="dialog"><div className="image-viewer" onClick={(event) => event.stopPropagation()}><div className="media-viewer-toolbar"><button className="media-viewer-action media-viewer-action-secondary" onClick={onOpenOriginal} type="button">開啟原圖</button><button aria-label="關閉圖片檢視器" className="media-viewer-action media-viewer-close" onClick={onClose} type="button">關閉</button></div><img alt={displayName} className="image-viewer-image" src={url} /></div></div>;
}

function ProtectedPdf({ assetId, displayName, participant }: { assetId: string; displayName: string; participant: StoredParticipant | null }) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const openPdf = async () => {
    if (!participant) return;
    setState("loading");
    try {
      const url = URL.createObjectURL(await fetchSessionAsset(assetId, participant));
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setState("idle");
    } catch {
      setState("error");
    }
  };
  return <div className="live-question-pdf">{state === "error" ? <><span>PDF 載入失敗</span><button className="text-button" onClick={() => void openPdf()} type="button">重新載入</button></> : <button className="text-button" disabled={state === "loading"} onClick={() => void openPdf()} type="button">{state === "loading" ? "正在開啟 PDF…" : `開啟 PDF：${displayName}`}</button>}</div>;
}
function State({ title, detail }: { title: string; detail?: string }) { return <main className="student-shell"><section className="student-card"><h1>{title}</h1>{detail && <p>{detail}</p>}</section></main>; }
function Field({ id, label, value, onChange, numeric = false }: { id: string; label: string; value: string; onChange: (value: string) => void; numeric?: boolean }) { return <div className="student-field"><label htmlFor={id}>{label}</label><input id={id} inputMode={numeric ? "numeric" : undefined} onChange={(event) => onChange(event.target.value)} value={value} /></div>; }
function joinCodeFromPath(path: string): string { const match = /^\/student\/join\/([A-Za-z0-9]+)$/.exec(path); return match?.[1]?.toUpperCase() ?? ""; }
function message(cause: unknown): string { return cause instanceof StudentApiError ? cause.message : "無法完成課堂連線。"; }
function joinInfoMessage(cause: unknown): string { return cause instanceof StudentApiError && cause.code === "SESSION_NOT_OPEN" ? "課堂目前未開放新加入。" : message(cause); }
function submissionErrorMessage(code: string): string {
  switch (code) {
    case "QUESTION_LOCKED": return "老師已停止本題作答。";
    case "SESSION_ENDED": return "課堂已結束，無法送出答案。";
    case "INVALID_ANSWER": return "答案格式無效，請重新選擇。";
    case "SUBMISSION_CONFLICT": return "答案提交衝突，請重新選擇後再試。";
    default: return "課堂伺服器無法接受答案，請重新連線後再試。";
  }
}
