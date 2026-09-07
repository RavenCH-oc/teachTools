import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PeerReviewActivity, PeerReviewMutation, PeerReviewPending } from "@classtools/backend-contract";
import { getPeerReviewActivities, getPeerReviewActivity } from "../../services/peerReviewApi";
import { secureUuid, type StoredParticipant, type SubmitAnswerResult } from "../../services/studentApi";
import type { PeerSessionChannel } from "./sessionChannel";
import { peerStorage } from "./storage";
import { usePage } from "./usePage";
import { ReviewActivity } from "./ReviewActivity";
import "./peer-review.css";

export const modeLabels = { RANDOM_ONE_TO_ONE: "隨機互評", STUDENT_SELECT: "自行選擇互評", CROSS_GROUP: "跨組互評" };
export type AcceptedReview = { assignmentId: string; revision: number; body: string };
export type PeerActions = {
  claim: (activity: string, target: string, accepted: (id: string) => void, rejected: (code: string) => void) => void;
  submit: (pending: PeerReviewPending) => void;
};
export function PeerReviewPanel({ participant, channel, send }: { participant: StoredParticipant; channel: PeerSessionChannel; send: (message: PeerReviewMutation) => SubmitAnswerResult }) {
  const storage = useMemo(() => peerStorage(participant), [participant]);
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<PeerReviewActivity | null>(null);
  const [online, setOnline] = useState(channel.snapshot().online);
  const [queryEnabled, setQueryEnabled] = useState(channel.snapshot().available);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PeerReviewPending[]>([]);
  const [accepted, setAccepted] = useState<Record<string, AcceptedReview>>({});
  const [rejections, setRejections] = useState<Record<string, string>>({});
  const claims = useRef(new Map<string, { generation: number; accepted: (id: string) => void; rejected: (code: string) => void }>());
  const generation = useCallback(() => channel.snapshot().epoch, [channel]);
  const readActivities = useCallback((cursor: string | undefined, signal: AbortSignal) => queryEnabled && channel.snapshot().online ? getPeerReviewActivities(participant, { cursor, limit: 10, signal }) : Promise.resolve({ items: [], nextCursor: null }), [participant, queryEnabled, channel]);
  const activities = usePage(readActivities, refresh, generation);
  const selectedId = selected?.activityId;
  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController(); const connection = generation();
    void getPeerReviewActivity(participant, selectedId, { signal: controller.signal }).then(page => {
      const item = page.items[0];
      if (!controller.signal.aborted && generation() === connection && item) setSelected(current => current?.activityId === selectedId ? item : current);
    }).catch(() => { if (!controller.signal.aborted && generation() === connection) { setError("無法重新取得此活動；草稿已保留，請確認活動列表。"); setSelected(null); } });
    return () => controller.abort();
  }, [participant, selectedId, refresh, generation]);
  const readPending = useCallback(() => { try { const records = storage.pending(); setPending(records); return records; } catch { setError("無法保存評論草稿，請確認瀏覽器儲存空間。"); return []; } }, [storage]);
  const retry = useCallback(() => {
    if (!channel.snapshot().online) return;
    for (const record of readPending()) send({ protocolVersion: 1, type: "submit_peer_review", requestId: record.reviewSubmissionId, ...recordToMessage(record) });
  }, [channel, readPending, send]);
  useEffect(() => {
    readPending();
    const unsubscribe = channel.subscribe(event => {
      if (event.type === "connection") {
        setOnline(event.online);
        if (!event.online) {
          for (const claim of claims.current.values()) claim.rejected("CONNECTION_LOST");
          claims.current.clear();
        }
        setRefresh(v => v + 1);
        if (event.online) retry();
        return;
      }
      const message = event.message;
      if (message.type === "session_sync") setQueryEnabled(message.sync.peerReview?.available ?? false);
      if (message.type === "peer_review_changed") setQueryEnabled(true);
      if (message.type === "peer_review_changed" || message.type === "session_sync") setRefresh(v => v + 1);
      if (message.type === "peer_review_acknowledged") {
        const ack = message.acknowledgement;
        const claim = claims.current.get(message.requestId);
        if (claim && claim.generation === event.generation && ack.reviewSubmissionId === null) { claims.current.delete(message.requestId); claim.accepted(ack.assignmentId); }
        const record = readPending().find(p => p.reviewSubmissionId === ack.reviewSubmissionId && p.reviewSubmissionId === message.requestId && p.assignmentId === ack.assignmentId);
        if (record) {
          try { storage.clearDraft(record.activityId, record.assignmentId); storage.clearPending(record); }
          catch { setError("已送出評論，但本機狀態未能清除；重新連線會再次確認，不會重複提交。"); }
          setAccepted(v => ({ ...v, [record.assignmentId]: { assignmentId: record.assignmentId, revision: ack.revision, body: record.body } }));
          setSelected(v => v?.assignmentId === record.assignmentId ? { ...v, latestReviewRevision: ack.revision } : v);
          setRejections(v => ({ ...v, [record.assignmentId]: "" })); readPending();
        }
        setRefresh(v => v + 1);
      }
      if (message.type === "peer_review_rejected") {
        const claim = claims.current.get(message.requestId);
        if (claim && claim.generation === event.generation) { claims.current.delete(message.requestId); claim.rejected(message.code); }
        const record = readPending().find(p => p.reviewSubmissionId === message.requestId);
        if (record) {
          setRejections(v => ({ ...v, [record.assignmentId]: message.code }));
          // A controlled rejection settles this attempt; keep authored draft for explicit conflict resolution.
          if (message.code !== "STORAGE" && message.code !== "REVIEW_SUBMISSION_CONFLICT") {
            try { storage.clearPending(record); } catch { setError("無法更新本機提交狀態。"); }
            readPending();
          }
        }
        setRefresh(v => v + 1);
      }
    });
    retry();
    return unsubscribe;
  }, [channel, readPending, retry, storage]);
  const actions: PeerActions = {
    claim: (activityId, targetId, onAccepted, onRejected) => {
      try {
        const requestId = secureUuid();
        claims.current.set(requestId, { generation: channel.snapshot().generation, accepted: onAccepted, rejected: onRejected });
        if (send({ protocolVersion: 1, type: "claim_peer_review", requestId, activityId, targetId }) !== "sent") { claims.current.delete(requestId); onRejected("CONNECTION_LOST"); }
      } catch { onRejected("INVALID_INPUT"); }
    },
    submit: record => {
      try {
        if (storage.pending().some(p => p.assignmentId === record.assignmentId)) return;
        storage.savePending(record); // Durability must precede the send, including its failure paths.
        readPending(); setRejections(v => ({ ...v, [record.assignmentId]: "" }));
        const result = send({ protocolVersion: 1, type: "submit_peer_review", requestId: record.reviewSubmissionId, ...recordToMessage(record) });
        if (result === "serialization_failed") { storage.clearPending(record); readPending(); setRejections(v => ({ ...v, [record.assignmentId]: "INVALID_INPUT" })); }
      } catch { setError("無法保存提交紀錄，尚未送出評論。請確認瀏覽器儲存空間。"); }
    },
  };
  const available = selected !== null || activities.items.length > 0 || activities.page > 1 || (queryEnabled && (activities.loading || !!activities.error));
  if (!available) return null;
  return <section className="peer-review" aria-label="同儕互評">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>同儕互評</button>
    <div hidden={!expanded}>
      <h2>同儕互評</h2><p>同儕互評只作為回饋紀錄，不計入正式成績。</p>
      {!online && <p role="status">連線中斷，草稿會保留；恢復後確認上一筆提交。</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={() => { setRefresh(v => v + 1); retry(); }}>重新整理互評</button>
      {selected ? <><button type="button" onClick={() => setSelected(null)}>返回活動列表</button>
        <ReviewActivity key={selected.activityId} participant={participant} activity={selected} refresh={refresh} generation={generation} online={online} actions={actions} pending={pending.find(p => p.assignmentId === selected.assignmentId) ?? null} accepted={selected.assignmentId ? accepted[selected.assignmentId] : undefined} rejection={selected.assignmentId ? rejections[selected.assignmentId] ?? "" : ""} onClaimed={assignmentId => { setSelected(v => v ? { ...v, assignmentId } : v); setRefresh(v => v + 1); }} />
      </> : <>
        {activities.loading && <p role="status">正在載入互評活動…</p>}{activities.error && <p role="alert">{activities.error}</p>}
        {!activities.loading && activities.items.length === 0 && <p>目前沒有可見的互評活動。</p>}
        {activities.items.map(a => <article className="peer-card" key={a.activityId}><h3>{a.questionSummary}</h3><p>{modeLabels[a.mode]} · {a.state === "OPEN" ? "進行中" : "已結束"}</p><p>我要評論：{a.latestReviewRevision ? `已送出第 ${a.latestReviewRevision} 版` : a.assignmentId ? "尚未送出" : "尚未選擇作品"}</p><p>收到的評論：{a.receivedFeedbackCount}</p><button type="button" onClick={() => setSelected(a)}>開啟活動</button></article>)}
        <PageButtons page={activities.page} loading={activities.loading} nextCursor={activities.nextCursor} previous={activities.previous} next={activities.next} />
      </>}
    </div>
  </section>;
}
function recordToMessage(p: PeerReviewPending) { return { assignmentId: p.assignmentId, reviewSubmissionId: p.reviewSubmissionId, expectedBaseRevision: p.expectedBaseRevision, body: p.body }; }
export function PageButtons({ page, loading, nextCursor, previous, next }: { page: number; loading: boolean; nextCursor: string | null; previous: () => void; next: () => void }) {
  return <nav className="peer-pages" aria-label="互評分頁"><button type="button" disabled={loading || page <= 1} onClick={previous}>上一頁</button><span>第 {page} 頁</span><button type="button" disabled={loading || !nextCursor} onClick={next}>下一頁</button></nav>;
}
