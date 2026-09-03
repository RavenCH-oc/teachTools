import { useCallback, useEffect, useState } from "react";
import { TeacherApiError } from "../../services/teacherApi";
import type { GroupPresetSummary, SessionGroupingDraft, SessionGroupingGroup, SessionGroupingOverview, TeacherApi, UpdateSessionGroupingDraftRequest } from "../../types/teacher";

export type SessionGroupingApi = Required<Pick<TeacherApi,
  "getSessionGrouping" | "listGroupPresets" | "createGroupingDraftFromPreset" | "createRandomGroupingDraft" |
  "createManualGroupingDraft" | "cloneCurrentGroupingDraft" | "updateSessionGroupingDraft" |
  "openSessionGroupingDraft" | "moveSessionGroupingParticipant" | "cancelSessionGroupingDraft" |
  "finalizeSessionGroupingDraft">>;

interface Props {
  api: SessionGroupingApi;
  sessionId: string;
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onError?: (message: string) => void;
}

type LocalGroup = SessionGroupingGroup & { key: string };

export function SessionGroupingPage({ api, sessionId, onBack, onDirtyChange, onError }: Props) {
  const [overview, setOverview] = useState<SessionGroupingOverview | null>(null);
  const [presets, setPresets] = useState<GroupPresetSummary[]>([]);
  const [localDraft, setLocalDraft] = useState<SessionGroupingDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [randomCount, setRandomCount] = useState("2");

  const reportError = useCallback((cause: unknown) => {
    onError?.(cause instanceof TeacherApiError ? groupingError(cause.code) : "無法完成分組操作。");
  }, [onError]);
  const applyOverview = useCallback((next: SessionGroupingOverview) => {
    setOverview(next);
    setLocalDraft(next.activeDraft);
    setDirty(false);
    onDirtyChange(false);
  }, [onDirtyChange]);
  const refresh = useCallback(async (isCurrent: () => boolean) => {
    setLoading(true);
    try {
      const next = await api.getSessionGrouping(sessionId);
      const nextPresets = await api.listGroupPresets(next.classroomId);
      if (!isCurrent()) return;
      setPresets(nextPresets);
      applyOverview(next);
    } catch (cause) {
      if (isCurrent()) reportError(cause);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [api, applyOverview, reportError, sessionId]);
  useEffect(() => {
    let current = true;
    void refresh(() => current);
    return () => { current = false; };
  }, [refresh]);

  const activeDraftId = overview?.activeDraft?.id;
  const activeDraftState = overview?.activeDraft?.state;
  useEffect(() => {
    if (!activeDraftId || activeDraftState !== "OPEN") return;
    let disposed = false;
    let timeout: number | undefined;
    const poll = () => {
      if (disposed) return;
      void api.getSessionGrouping(sessionId)
        .then((next) => { if (!disposed && next.sessionId === sessionId) applyOverview(next); })
        .catch(() => undefined)
        .finally(() => {
          if (!disposed) timeout = window.setTimeout(poll, 1_000);
        });
    };
    timeout = window.setTimeout(poll, 1_000);
    return () => {
      disposed = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [activeDraftId, activeDraftState, api, applyOverview, sessionId]);

  const markDirty = (next: boolean) => { setDirty(next); onDirtyChange(next); };
  const updateLocalDraft = (next: SessionGroupingDraft) => { setLocalDraft(next); markDirty(true); };
  const sourceAction = async (operation: () => Promise<SessionGroupingOverview>) => {
    setWorking(true);
    try { applyOverview(await operation()); } catch (cause) { reportError(cause); } finally { setWorking(false); }
  };
  const saveDraft = async (draft: SessionGroupingDraft): Promise<SessionGroupingOverview> => {
    const request: UpdateSessionGroupingDraftRequest = {
      draftId: draft.id,
      groups: draft.groups.map((group, position) => ({ key: group.id, id: group.id, name: group.name, position, capacity: group.capacity })),
      assignments: draft.groups.flatMap((group) => group.participantIds.map((participantId) => ({ groupKey: group.id, participantId }))),
    };
    const next = await api.updateSessionGroupingDraft(request);
    applyOverview(next);
    return next;
  };
  const handleSave = async () => {
    if (!localDraft || localDraft.state !== "DRAFT") return;
    setWorking(true);
    try { await saveDraft(localDraft); } catch (cause) { reportError(cause); } finally { setWorking(false); }
  };
  const handleOpen = async () => {
    if (!localDraft || localDraft.state !== "DRAFT") return;
    setWorking(true);
    try {
      const saved = dirty ? await saveDraft(localDraft) : overview;
      const draftId = saved?.activeDraft?.id ?? localDraft.id;
      applyOverview(await api.openSessionGroupingDraft(draftId));
    } catch (cause) {
      reportError(cause);
    } finally {
      setWorking(false);
    }
  };
  const handleCancel = async () => {
    if (!localDraft || !window.confirm("取消草稿後目前已套用的分組不會變更，確定嗎？")) return;
    setWorking(true);
    try { applyOverview(await api.cancelSessionGroupingDraft(localDraft.id)); } catch (cause) { reportError(cause); } finally { setWorking(false); }
  };
  const handleFinalize = async () => {
    if (!localDraft) return;
    const assigned = new Set(localDraft.groups.flatMap((group) => group.participantIds));
    const unassigned = (overview?.participants.length ?? 0) - assigned.size;
    if (unassigned > 0 && !window.confirm(`目前有 ${unassigned} 位學生尚未分組，仍要套用嗎？`)) return;
    setWorking(true);
    try {
      const saved = dirty && localDraft.state === "DRAFT" ? await saveDraft(localDraft) : overview;
      applyOverview(await api.finalizeSessionGroupingDraft(saved?.activeDraft?.id ?? localDraft.id));
    } catch (cause) {
      reportError(cause);
    } finally {
      setWorking(false);
    }
  };
  const handleOpenMove = async (participantId: string, targetGroupId: string | null) => {
    if (!localDraft || localDraft.state !== "OPEN") return;
    setWorking(true);
    try {
      applyOverview(await api.moveSessionGroupingParticipant({ draftId: localDraft.id, participantId, targetGroupId }));
    } catch (cause) {
      reportError(cause);
    } finally {
      setWorking(false);
    }
  };

  if (loading) return <section className="state-card"><span className="spinner" />正在載入課堂分組…</section>;
  if (!overview) return <section className="state-card"><h2>課堂分組</h2><p>無法載入課堂分組資料。</p><button className="button ghost" onClick={onBack} type="button">返回</button></section>;
  const canEdit = overview.sessionState === "LOBBY" || overview.sessionState === "ACTIVE";
  const readOnly = !canEdit;
  const currentAssigned = new Set(overview.currentGroupSet?.groups.flatMap((group) => group.participantIds) ?? []);
  const draftAssigned = new Set(localDraft?.groups.flatMap((group) => group.participantIds) ?? []);
  const unassignedCurrent = overview.participants.filter((participant) => !currentAssigned.has(participant.participantId));
  const unassignedDraft = overview.participants.filter((participant) => !draftAssigned.has(participant.participantId));
  const isOpen = localDraft?.state === "OPEN";
  return <section className="session-grouping-page" aria-labelledby="session-grouping-title">
    <header className="page-heading compact"><div><p className="eyebrow">教師工作區 / 課堂分組</p><h2 id="session-grouping-title">課堂分組</h2><p className="intro">草稿期間可編輯；開放自行選組後，學生與教師只會進行即時單人分組變更。</p></div><button className="button ghost" onClick={onBack} type="button">返回課堂</button></header>
    {overview.sessionState === "ENDED" && <p className="session-grouping-warning">課堂已結束，目前分組僅供檢視。</p>}
    {overview.sessionState === "CREATED" && <p className="session-grouping-warning">請先開放課堂等候大廳，再建立分組草稿。</p>}
    {overview.currentGroupSet && <section className="session-grouping-current list-card"><div className="list-card-header"><h3>目前分組（第 {overview.currentGroupSet.revision} 版）</h3><span>已套用</span></div><GroupCards groups={overview.currentGroupSet.groups} participants={overview.participants.map((participant) => [participant.participantId, participant.displayName] as const)} /><Unassigned people={unassignedCurrent} label="目前未分組" /></section>}
    {!readOnly && !localDraft && <section className="session-grouping-source form-card"><h3>建立分組草稿</h3><p>選擇一個來源；草稿可編輯，完成後再一次套用。</p><div className="session-grouping-source-row"><label className="field"><span>從預設建立</span><select aria-label="分組預設" defaultValue="" disabled={working} onChange={(event) => { if (event.target.value) void sourceAction(() => api.createGroupingDraftFromPreset({ sessionId, presetId: event.target.value })); }}><option value="">請選擇分組預設</option>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}（{preset.groupCount} 組）</option>)}</select></label><label className="field"><span>隨機組數</span><input aria-label="隨機組數" min="1" type="number" value={randomCount} onChange={(event) => setRandomCount(event.target.value)} /></label><button className="button ghost" disabled={working} onClick={() => void sourceAction(() => api.createRandomGroupingDraft({ sessionId, groupCount: Number(randomCount) }))} type="button">隨機建立</button><button className="button ghost" disabled={working} onClick={() => void sourceAction(() => api.createManualGroupingDraft(sessionId))} type="button">手動建立</button>{overview.currentGroupSet && <button className="button ghost" disabled={working} onClick={() => void sourceAction(() => api.cloneCurrentGroupingDraft(sessionId))} type="button">複製目前分組</button>}</div></section>}
    {!readOnly && localDraft?.state === "DRAFT" && <section className="session-grouping-draft form-card"><div className="list-card-header"><div><h3>分組草稿</h3><p className="muted">可編輯組別、容量與分配；開放後結構會鎖定。</p></div><span>DRAFT</span></div><DraftEditor draft={localDraft} participants={overview.participants} onChange={updateLocalDraft} /><p className="muted">尚有 {unassignedDraft.length} 位學生未分組。</p><div className="form-actions"><button className="button primary" disabled={working || !dirty} onClick={() => void handleSave()} type="button">儲存草稿</button><button className="button primary" disabled={working || localDraft.groups.length === 0} onClick={() => void handleOpen()} type="button">開放學生選組</button><button className="button ghost" disabled={working} onClick={() => void handleCancel()} type="button">取消草稿</button><button className="button ghost" disabled={working} onClick={() => void handleFinalize()} type="button">直接套用分組</button></div></section>}
    {!readOnly && isOpen && localDraft && <section className="session-grouping-draft form-card"><div className="list-card-header"><div><h3>學生自行選組已開放</h3><p className="muted">組別結構與容量已鎖定；學生變更會每秒同步。教師可即時覆寫單一學生的分組。</p></div><span>OPEN</span></div><OpenDraftView draft={localDraft} participants={overview.participants} working={working} onMove={handleOpenMove} /><p className="muted">尚有 {unassignedDraft.length} 位學生未分組。</p><div className="form-actions"><button className="button primary" disabled={working} onClick={() => void handleFinalize()} type="button">停止並套用分組</button><button className="button ghost" disabled={working} onClick={() => void handleCancel()} type="button">取消自行選組</button></div></section>}
    {!overview.currentGroupSet && !localDraft && !readOnly && <p className="empty-state">尚未建立目前分組或草稿。</p>}
  </section>;
}

function DraftEditor({ draft, participants, onChange }: { draft: SessionGroupingDraft; participants: SessionGroupingOverview["participants"]; onChange: (draft: SessionGroupingDraft) => void }) {
  const groups: LocalGroup[] = draft.groups.map((group) => ({ ...group, key: group.id }));
  const setGroups = (next: LocalGroup[]) => onChange({ ...draft, groups: next.map((group) => ({ id: group.id, name: group.name, position: group.position, capacity: group.capacity, participantIds: group.participantIds })) });
  const addGroup = () => { const id = crypto.randomUUID(); setGroups([...groups, { id, key: id, name: `第 ${groups.length + 1} 組`, position: groups.length, capacity: null, participantIds: [] }]); };
  const rename = (key: string, name: string) => setGroups(groups.map((group) => group.key === key ? { ...group, name } : group));
  const setCapacity = (key: string, value: string) => setGroups(groups.map((group) => group.key === key ? { ...group, capacity: value === "" ? null : Number(value) } : group));
  const remove = (key: string) => setGroups(groups.filter((group) => group.key !== key).map((group, position) => ({ ...group, position })));
  const move = (key: string, direction: -1 | 1) => { const index = groups.findIndex((group) => group.key === key); const nextIndex = index + direction; const current = groups[index]; const target = groups[nextIndex]; if (!current || !target) return; const next = [...groups]; next[index] = target; next[nextIndex] = current; setGroups(next.map((group, position) => ({ ...group, position }))); };
  const assign = (participantId: string, key: string) => setGroups(groups.map((group) => ({ ...group, participantIds: group.key === key ? [...group.participantIds.filter((id) => id !== participantId), participantId] : group.participantIds.filter((id) => id !== participantId) })));
  return <div className="session-grouping-editor"><div className="session-grouping-group-list">{groups.map((group, index) => <article className="session-grouping-group" key={group.key}><input aria-label={`第 ${index + 1} 組名稱`} value={group.name} onChange={(event) => rename(group.key, event.target.value)} /><label className="session-grouping-capacity"><span>容量</span><input aria-label={`第 ${index + 1} 組容量`} min="1" type="number" value={group.capacity ?? ""} onChange={(event) => setCapacity(group.key, event.target.value)} /></label><span>{group.participantIds.length} 人</span><button className="text-button" disabled={index === 0} onClick={() => move(group.key, -1)} type="button">上移</button><button className="text-button" disabled={index === groups.length - 1} onClick={() => move(group.key, 1)} type="button">下移</button><button className="text-button danger" onClick={() => remove(group.key)} type="button">刪除</button></article>)}</div><button className="button ghost" onClick={addGroup} type="button">新增一組</button><div className="session-grouping-table"><h4>學生分配</h4>{participants.map((participant) => <label className="session-grouping-row" key={participant.participantId}><span>{participant.seatNumber} 號 {participant.displayName}</span><select aria-label={`${participant.seatNumber} 號 ${participant.displayName} 分組`} value={groups.find((group) => group.participantIds.includes(participant.participantId))?.key ?? ""} onChange={(event) => assign(participant.participantId, event.target.value)}><option value="">未分組</option>{groups.map((group, index) => <option key={group.key} value={group.key}>{group.name || `第 ${index + 1} 組`}</option>)}</select></label>)}</div></div>;
}

function OpenDraftView({ draft, participants, working, onMove }: { draft: SessionGroupingDraft; participants: SessionGroupingOverview["participants"]; working: boolean; onMove: (participantId: string, targetGroupId: string | null) => Promise<void> }) {
  const assignment = new Map(draft.groups.flatMap((group) => group.participantIds.map((participantId) => [participantId, group.id] as const)));
  return <div className="session-grouping-editor"><div className="session-grouping-group-list">{draft.groups.map((group) => <article className="session-grouping-group" key={group.id}><strong>{group.name}</strong><span>{group.participantIds.length} / {group.capacity ?? "不限"} 人</span><span>{group.participantIds.map((id) => participants.find((participant) => participant.participantId === id)?.displayName ?? "未知參與者").join("、") || "尚無學生"}</span></article>)}</div><div className="session-grouping-table"><h4>即時教師覆寫</h4>{participants.map((participant) => <label className="session-grouping-row" key={participant.participantId}><span>{participant.seatNumber} 號 {participant.displayName}</span><select aria-label={`${participant.seatNumber} 號 ${participant.displayName} 即時分組`} disabled={working} value={assignment.get(participant.participantId) ?? ""} onChange={(event) => void onMove(participant.participantId, event.target.value || null)}><option value="">未分組</option>{draft.groups.map((group) => <option key={group.id} value={group.id}>{group.name}（{group.participantIds.length} / {group.capacity ?? "不限"}）</option>)}</select></label>)}</div></div>;
}

function GroupCards({ groups, participants }: { groups: SessionGroupingGroup[]; participants: ReadonlyArray<readonly [string, string]> }) { const labels = new Map(participants); return <div className="session-grouping-group-list">{groups.map((group) => <article className="session-grouping-group" key={group.id}><strong>{group.name}</strong><span>{group.participantIds.map((id) => labels.get(id) ?? "未知參與者").join("、") || "尚無學生"}</span></article>)}</div>; }
function Unassigned({ people, label }: { people: SessionGroupingOverview["participants"]; label: string }) { return <p className="muted">{label}：{people.length ? people.map((person) => `${person.seatNumber} 號 ${person.displayName}`).join("、") : "無"}</p>; }
function groupingError(code: string): string { const messages: Record<string, string> = { active_draft_exists: "目前已有正在編輯的分組草稿。", session_ended: "課堂已結束，分組不可再修改。", preset_classroom_mismatch: "這個分組預設不屬於目前課堂。", group_preset_not_found: "找不到分組預設。", no_participants: "目前沒有已加入的學生。", invalid_group_count: "組數必須介於 1 與學生人數之間。", group_full: "分組人數超過容量。", stale_participant: "學生名單已變更，請重新載入課堂分組。", stale_grouping_draft: "分組狀態已更新，請重新載入。", draft_not_open: "草稿目前不可用此方式修改。" }; return messages[code] ?? "無法完成分組操作。"; }
