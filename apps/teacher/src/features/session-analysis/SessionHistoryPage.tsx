import { useEffect, useState } from "react";
import type { Classroom, SessionHistory, TeacherApi } from "../../types/teacher";

type HistoryApi = Required<Pick<TeacherApi, "listClassroomSessionHistory">>;
const PAGE_SIZE = 30;

export function SessionHistoryPage({ api, classrooms, onOpenSessionAnalysis }: { api: HistoryApi; classrooms: Classroom[]; onOpenSessionAnalysis: (session: SessionHistory) => void }) {
  const [classroomId, setClassroomId] = useState(classrooms[0]?.id ?? "");
  const [rows, setRows] = useState<SessionHistory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);

  useEffect(() => { if (!classroomId && classrooms[0]) setClassroomId(classrooms[0].id); }, [classroomId, classrooms]);
  useEffect(() => {
    if (!classroomId) { setRows([]); return; }
    let active = true;
    setLoading(true); setError(""); setOffset(0);
    void api.listClassroomSessionHistory(classroomId, PAGE_SIZE, 0).then((items) => {
      if (!active) return;
      setRows(items); setHasMore(items.length === PAGE_SIZE);
    }).catch(() => { if (active) { setRows([]); setHasMore(false); setError("無法載入課堂紀錄。"); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, classroomId, reload]);

  const loadMore = () => {
    if (!classroomId || loading || !hasMore) return;
    const nextOffset = offset + PAGE_SIZE;
    setLoading(true);
    void api.listClassroomSessionHistory(classroomId, PAGE_SIZE, nextOffset).then((items) => {
      setRows((current) => [...current, ...items]); setOffset(nextOffset); setHasMore(items.length === PAGE_SIZE);
    }).catch(() => setError("無法載入更多課堂紀錄。")).finally(() => setLoading(false));
  };

  return <section className="session-history-page">
    <div className="page-heading compact"><div><p className="eyebrow">教師工作區 / History</p><h2>課堂紀錄</h2><p className="intro">檢視已結束課堂的統計與分析。</p></div></div>
    <label className="select-label" htmlFor="history-classroom">班級<select id="history-classroom" value={classroomId} onChange={(event) => setClassroomId(event.target.value)}><option value="">請選擇班級</option>{classrooms.map((classroom) => <option key={classroom.id} value={classroom.id}>{classroom.name}</option>)}</select></label>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setReload((value) => value + 1)}>重試</button></div>}
    {loading && rows.length === 0 && <div className="state-card"><span className="spinner" />正在載入課堂紀錄…</div>}
    {!loading && !error && rows.length === 0 && <div className="empty-state"><span>✦</span><p>目前還沒有已完成的課堂紀錄。</p></div>}
    {rows.length > 0 && <section className="list-card" aria-label="已結束課堂紀錄"><div className="list-card-header"><h3>已結束課堂</h3><span>{rows.length}</span></div><ul className="session-history-list">{rows.map((row) => <li key={row.sessionId}><div><strong>{row.classroomName}</strong><small>{formatSessionDate(row.endedAt)} · {row.participantCount} 位學生 · {row.eligibleQuestionCount} 題</small></div><button className="button ghost compact-button" type="button" onClick={() => onOpenSessionAnalysis(row)}>查看統計</button></li>)}</ul>{hasMore && <button className="button ghost" type="button" onClick={loadMore} disabled={loading}>{loading ? "載入中…" : "載入更多"}</button>}</section>}
  </section>;
}

export function formatSessionDate(value: string | null): string {
  if (!value) return "日期未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日期未知" : new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
