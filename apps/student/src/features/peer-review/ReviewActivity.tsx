import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PeerReviewActivity, PeerReviewDraft, PeerReviewPending } from "@classtools/backend-contract";
import { getOwnPeerReview, getPeerReviewCandidates, getPeerReviewEssays, getPeerReviewFeedback, getPeerReviewFeedbackDetail } from "../../services/peerReviewApi";
import { secureUuid, type StoredParticipant } from "../../services/studentApi";
import { peerStorage } from "./storage";
import { peerError } from "./errors";
import { modeLabels, PageButtons, type AcceptedReview, type PeerActions } from "./PeerReviewPanel";
import { usePage } from "./usePage";

type Props = { participant: StoredParticipant; activity: PeerReviewActivity; refresh: number; generation: () => number; online: boolean; actions: PeerActions; pending: PeerReviewPending | null; accepted?: AcceptedReview; rejection: string; onClaimed: (id: string) => void };
export function ReviewActivity(props: Props) {
  const { activity: a } = props;
  const [picker, setPicker] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState("");
  const [candidateRefresh, setCandidateRefresh] = useState(0);
  const storage = useMemo(() => peerStorage(props.participant), [props.participant]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const claim = (target: string) => {
    try {
      const draft = a.assignmentId ? storage.draft(a.activityId, a.assignmentId) : null;
      if (draft && !window.confirm("更換評論對象會清除目前尚未送出的評論草稿。")) return;
      setClaiming(true); setError("");
      props.actions.claim(a.activityId, target, id => {
        if (a.assignmentId) storage.clearDraft(a.activityId, a.assignmentId);
        if (!mounted.current) return;
        setClaiming(false); setPicker(false); props.onClaimed(id);
      }, code => { if (mounted.current) { setClaiming(false); setError(peerError(code)); setCandidateRefresh(v => v + 1); } });
    } catch { setError("無法讀取本機草稿，尚未更換評論對象。"); }
  };
  return <section aria-label="互評活動內容"><h3>{a.questionSummary}</h3><p>{modeLabels[a.mode]} · {a.state === "OPEN" ? "進行中" : "已結束"}</p>
    {a.mode === "CROSS_GROUP" && a.assignmentId && <p>我的組別：{a.reviewerGroupLabel}／互評對象：{a.targetGroupLabel}</p>}
    {a.state === "CLOSED" && <p role="status">同儕互評活動已結束，既有評論仍可閱讀。</p>}
    {error && <p role="alert">{error}</p>}
    {a.mode === "STUDENT_SELECT" && a.state === "OPEN" && !a.latestReviewRevision && !props.pending && <button type="button" disabled={!props.online || claiming} onClick={() => setPicker(v => !v)}>{a.assignmentId ? "更換對象" : "選擇作品"}</button>}
    {a.mode === "STUDENT_SELECT" && a.state === "OPEN" && (picker || !a.assignmentId) && <CandidatePicker participant={props.participant} activityId={a.activityId} refresh={props.refresh + candidateRefresh} generation={props.generation} disabled={claiming || !props.online || !!props.pending} claim={claim} />}
    {claiming && <p role="status">正在確認互評對象…</p>}
    {a.assignmentId ? <ReviewWork {...props} key={a.assignmentId} claiming={claiming} /> : <p>尚未指派評論作品；你仍可閱讀已收到的回饋。</p>}
    <ReceivedFeedback {...props} />
  </section>;
}
function CandidatePicker({ participant, activityId, refresh, generation, disabled, claim }: { participant: StoredParticipant; activityId: string; refresh: number; generation: () => number; disabled: boolean; claim: (id: string) => void }) {
  const read = useCallback((cursor: string | undefined, signal: AbortSignal) => getPeerReviewCandidates(participant, activityId, { cursor, limit: 10, signal }), [participant, activityId]);
  const page = usePage(read, refresh, generation);
  return <section aria-label="選擇互評作品"><p>若方便，可以優先選擇尚未收到回饋的作品。</p>
    {page.loading && <p role="status">正在更新作品名額…</p>}{page.error && <p role="alert">{page.error}</p>}
    {page.items.map(c => <article className="peer-card" key={c.peerReviewTargetId}><h4>{c.label}</h4><p>{c.hasReceivedAnyReview ? `已收到 ${c.submittedReviewCount} 份` : "尚未收到評論"}</p><p>{c.remainingCapacity === null ? "評論名額：不限" : c.full ? "名額已滿" : `剩餘 ${c.remainingCapacity} 個名額`}</p><button type="button" disabled={disabled || page.loading || c.full || c.currentClaim} onClick={() => claim(c.peerReviewTargetId)}>{c.currentClaim ? "目前選擇" : "選擇這份作品"}</button></article>)}
    <PageButtons {...page} />
  </section>;
}
function ReviewWork(props: Props & { claiming: boolean }) {
  const { participant, activity: a, refresh, generation } = props;
  const assignmentId = a.assignmentId ?? "";
  const read = useCallback((cursor: string | undefined, signal: AbortSignal) => getPeerReviewEssays(participant, assignmentId, { cursor, limit: 5, signal }), [participant, assignmentId]);
  const page = usePage(read, refresh, generation);
  const targetId = a.mode === "CROSS_GROUP" ? assignmentId : page.items[0]?.peerReviewTargetId;
  return <section aria-label="我要評論"><h4>我要評論</h4><p>以下作品固定於活動開放時，不隨後續作答或分組更新。</p>
    {page.loading && <p role="status">正在載入作品…</p>}{page.error && <p role="alert">{page.error}</p>}
    {page.items.map(item => <article key={item.peerReviewTargetId} className="peer-card"><h5>{item.label}</h5><p className="peer-body">{item.essay}</p></article>)}
    <PageButtons {...page} />
    {targetId && <ReviewEditor {...props} claiming={props.claiming || page.loading || !!page.error} key={`${assignmentId}:${targetId}`} assignmentId={assignmentId} targetId={targetId} />}
  </section>;
}
function ReviewEditor({ participant, activity: a, assignmentId, targetId, refresh, generation, online, actions, pending, accepted, rejection, claiming }: Props & { assignmentId: string; targetId: string; claiming: boolean }) {
  const storage = useMemo(() => peerStorage(participant), [participant]);
  const [body, setBody] = useState("");
  const [base, setBase] = useState(0);
  const [latest, setLatest] = useState<{ revision: number; body: string }>({ revision: 0, body: "" });
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showLatest, setShowLatest] = useState(false);
  const acceptedRef = useRef(accepted); acceptedRef.current = accepted;
  const dirtyRef = useRef<PeerReviewDraft | null>(null);
  useEffect(() => {
    const controller = new AbortController(); const connection = generation();
    setLoading(true);
    void getOwnPeerReview(participant, assignmentId, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || generation() !== connection) return;
      const authoritative = result ?? { revision: 0, body: "" };
      const ack = acceptedRef.current;
      const current = ack && ack.revision > authoritative.revision ? ack : authoritative;
      setLatest(current);
      const draft = dirtyRef.current ?? storage.draft(a.activityId, assignmentId);
      if (draft && (!draft.targetId || draft.targetId === targetId)) { setBody(draft.body); setBase(draft.baseRevision); setDirty(true); }
      else { setBody(current.body); setBase(current.revision); setDirty(false); }
      setLoading(false);
    }).catch(() => { if (!controller.signal.aborted && generation() === connection) { setError("無法載入評論，草稿仍保留。請重新整理。"); setLoading(false); } });
    return () => controller.abort();
  }, [participant, assignmentId, a.activityId, targetId, refresh, generation, storage]);
  useEffect(() => { if (accepted) { dirtyRef.current = null; setBody(accepted.body); setBase(accepted.revision); setLatest(accepted); setDirty(false); setError(""); } }, [accepted]);
  const edit = (text: string) => {
    if (Array.from(text).length > 10000) return;
    setBody(text); setDirty(true);
    dirtyRef.current = { body: text, baseRevision: base, updatedAt: new Date().toISOString(), targetId };
    try { storage.saveDraft(a.activityId, assignmentId, dirtyRef.current); setError(""); }
    catch { setError("無法保存本機草稿，請勿關閉此頁；確認儲存空間後再試。"); }
  };
  const stale = dirty && latest.revision > base;
  const loadLatest = () => {
    if (dirty && !window.confirm("會以伺服器最新內容取代目前未送出文字，是否繼續？")) return;
    try { storage.clearDraft(a.activityId, assignmentId); dirtyRef.current = null; setBody(latest.body); setBase(latest.revision); setDirty(false); setError(""); setShowLatest(false); }
    catch { setError("無法更新本機草稿。"); }
  };
  const submit = () => {
    if (pending || loading || claiming || a.state !== "OPEN" || !online || stale || !body.trim() || body.includes("\0")) return;
    try {
      const normalized = body.trim();
      storage.saveDraft(a.activityId, assignmentId, { body: normalized, baseRevision: base, updatedAt: new Date().toISOString(), targetId });
      actions.submit({ activityId: a.activityId, assignmentId, reviewSubmissionId: secureUuid(), expectedBaseRevision: base, body: normalized });
    } catch { setError("無法安全保存評論提交資料，尚未送出。"); }
  };
  return <section aria-label="評論編輯器"><p>{a.mode === "CROSS_GROUP" ? "目前共享評論" : "目前評論"}：第 {latest.revision} 版</p>
    {loading && <p role="status">正在載入評論…</p>}{pending && <p role="status">正在確認上一筆評論是否已送出…</p>}
    {a.state === "CLOSED" && dirty && <p role="status">活動已結束，這份草稿未送出。</p>}
    {(stale || rejection === "REVIEW_REVISION_CONFLICT") && <p role="alert">這份評論已被更新，你目前的草稿是基於較舊版本。</p>}
    {(error || rejection) && <p role="alert">{error || peerError(rejection)}</p>}
    <label htmlFor={`review-${assignmentId}`}>評論內容</label><textarea id={`review-${assignmentId}`} rows={7} value={body} readOnly={loading || !!pending || claiming || a.state === "CLOSED"} onChange={e => edit(e.target.value)} aria-describedby={`review-count-${assignmentId}`} />
    <p id={`review-count-${assignmentId}`}>{Array.from(body).length} / 10000 字</p>
    <button type="button" disabled={loading || !!pending || claiming || a.state !== "OPEN" || !online || stale || !body.trim() || body.includes("\0")} onClick={submit}>送出評論</button>
    {(stale || rejection || dirty) && <div className="peer-actions"><button type="button" onClick={() => setShowLatest(v => !v)}>查看最新版本</button><button type="button" disabled={!!pending || loading} onClick={loadLatest}>載入最新版本</button><button type="button" onClick={() => setShowLatest(false)}>保留我的草稿</button></div>}
    {showLatest && <article className="peer-card"><h5>伺服器最新版本：第 {latest.revision} 版</h5><p className="peer-body">{latest.body || "尚無已送出的評論。"}</p></article>}
  </section>;
}
function ReceivedFeedback({ participant, activity: a, refresh, generation }: Props) {
  const read = useCallback((cursor: string | undefined, signal: AbortSignal) => getPeerReviewFeedback(participant, { activityId: a.activityId, cursor, limit: 10, signal }), [participant, a.activityId]);
  const page = usePage(read, refresh, generation);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getPeerReviewFeedbackDetail>> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController(); const connection = generation();
    setError("");
    void getPeerReviewFeedbackDetail(participant, selected, { signal: controller.signal }).then(value => { if (!controller.signal.aborted && generation() === connection) setDetail(value); })
      .catch(() => { if (!controller.signal.aborted && generation() === connection) setError("無法讀取這份回饋，請重新整理。"); });
    return () => controller.abort();
  }, [participant, selected, refresh, generation]);
  return <section aria-label="收到的評論"><h4>收到的評論：{a.receivedFeedbackCount}</h4>{page.loading && <p role="status">正在更新回饋…</p>}{page.error && <p role="alert">{page.error}</p>}
    {!page.loading && !page.items.length && <p>尚未收到已送出的評論。</p>}
    {page.items.map((item, index) => <button type="button" key={item.assignmentId} onClick={() => { setDetail(null); setSelected(item.assignmentId); }}>{a.mode === "CROSS_GROUP" ? "其他組別的回饋" : `同學回饋 ${(page.page - 1) * 10 + index + 1}`} · 第 {item.revision} 版</button>)}
    <PageButtons {...page} />{error && <p role="alert">{error}</p>}{selected && <article className="peer-card"><h5>收到的回饋{detail ? ` · 第 ${detail.revision} 版` : ""}</h5><p className="peer-body">{detail?.body ?? "正在載入回饋…"}</p><button type="button" onClick={() => { setSelected(null); setDetail(null); }}>關閉回饋</button></article>}
  </section>;
}
