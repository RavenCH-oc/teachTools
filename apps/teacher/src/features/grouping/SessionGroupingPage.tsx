import { useCallback, useEffect, useState } from "react";
import { TeacherApiError } from "../../services/teacherApi";
import type { GroupPresetSummary, SessionGroupingDraft, SessionGroupingGroup, SessionGroupingOverview, TeacherApi, UpdateSessionGroupingDraftRequest } from "../../types/teacher";

export type SessionGroupingApi = Required<Pick<TeacherApi,
  "getSessionGrouping" | "listGroupPresets" | "createGroupingDraftFromPreset" | "createRandomGroupingDraft" |
  "createManualGroupingDraft" | "cloneCurrentGroupingDraft" | "updateSessionGroupingDraft" |
  "cancelSessionGroupingDraft" | "finalizeSessionGroupingDraft">>;

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
    setOverview(next); setLocalDraft(next.activeDraft); setDirty(false); onDirtyChange(false);
  }, [onDirtyChange]);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.getSessionGrouping(sessionId);
      setPresets(await api.listGroupPresets(next.classroomId));
      applyOverview(next);
    } catch (cause) { reportError(cause); } finally { setLoading(false); }
  }, [api, applyOverview, reportError, sessionId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const markDirty = (next: boolean) => { setDirty(next); onDirtyChange(next); };
  const updateLocalDraft = (next: SessionGroupingDraft) => { setLocalDraft(next); markDirty(true); };
  const sourceAction = async (operation: () => Promise<SessionGroupingOverview>) => {
    setWorking(true); try { applyOverview(await operation()); } catch (cause) { reportError(cause); } finally { setWorking(false); }
  };
  const saveDraft = async (draft: SessionGroupingDraft): Promise<SessionGroupingOverview> => {
    const request: UpdateSessionGroupingDraftRequest = {
      draftId: draft.id,
      groups: draft.groups.map((group, position) => ({ key: group.id, id: group.id, name: group.name, position, capacity: group.capacity })),
      assignments: draft.groups.flatMap((group) => group.participantIds.map((participantId) => ({ groupKey: group.id, participantId }))),
    };
    const next = await api.updateSessionGroupingDraft(request); applyOverview(next); return next;
  };
  const handleSave = async () => { if (!localDraft) return; setWorking(true); try { await saveDraft(localDraft); } catch (cause) { reportError(cause); } finally { setWorking(false); } };
  const handleCancel = async () => {
    if (!localDraft || !window.confirm("取消草稿後目前已套用的分組不會變更，確定嗎？")) return;
    setWorking(true); try { applyOverview(await api.cancelSessionGroupingDraft(localDraft.id)); } catch (cause) { reportError(cause); } finally { setWorking(false); }
  };
  const handleFinalize = async () => {
    if (!localDraft) return;
    const assigned = new Set(localDraft.groups.flatMap((group) => group.participantIds));
    const unassigned = (overview?.participants.length ?? 0) - assigned.size;
    if (unassigned > 0 && !window.confirm(`目前有 ${unassigned} 位學生尚未分組，仍要套用嗎？`)) return;
    setWorking(true);
    try {
      const saved = dirty ? await saveDraft(localDraft) : overview;
      applyOverview(await api.finalizeSessionGroupingDraft(saved?.activeDraft?.id ?? localDraft.id));
    } catch (cause) { reportError(cause); } finally { setWorking(false); }
  };

  if (loading) return <section className="state-card"><span className="spinner" />正在載入課堂分組…</section>;
  if (!overview) return <section className="state-card"><h2>課堂分組</h2><p>無法載入課堂分組資料。</p><button className="button ghost" onClick={onBack} type="button">返回</button></section>;
  const canEdit = overview.sessionState === "LOBBY" || overview.sessionState === "ACTIVE";
  const readOnly = !canEdit;
  const currentAssigned = new Set(overview.currentGroupSet?.groups.flatMap((group) => group.participantIds) ?? []);
  const draftAssigned = new Set(localDraft?.groups.flatMap((group) => group.participantIds) ?? []);
  const unassignedCurrent = overview.participants.filter((participant) => !currentAssigned.has(participant.participantId));
  const unassignedDraft = overview.participants.filter((participant) => !draftAssigned.has(participant.participantId));
  return <section className="session-grouping-page" aria-labelledby="session-grouping-title">
    <header className="page-heading compact"><div><p className="eyebrow">教師工作區 / 課堂分組</p><h2 id="session-grouping-title">課堂分組</h2><p className="intro">依學生 durable identity 編輯本次課堂分組；儲存草稿後才會套用。</p></div><button className="button ghost" onClick={onBack} type="button">返回課堂</button></header>
    {overview.sessionState === "ENDED" && <p className="session-grouping-warning">課堂已結束，目前分組僅供檢視。</p>}
    {overview.sessionState === "CREATED" && <p className="session-grouping-warning">請先開放課堂等候大廳，再建立分組草稿。</p>}
    {overview.currentGroupSet && <section className="session-grouping-current list-card"><div className="list-card-header"><h3>目前分組（第 {overview.currentGroupSet.revision} 版）</h3><span>已套用</span></div><GroupCards groups={overview.currentGroupSet.groups} participants={overview.participants.map((participant) => [participant.participantId, participant.displayName] as const)} /><Unassigned people={unassignedCurrent} label="目前未分組" /></section>}
    {!readOnly && !localDraft && <section className="session-grouping-source form-card"><h3>建立分組草稿</h3><p>選擇一個來源；草稿可編輯，完成後再一次套用。</p><div className="session-grouping-source-row"><label className="field"><span>從預設建立</span><select aria-label="分組預設" defaultValue="" disabled={working} onChange={(event) => { if (event.target.value) void sourceAction(() => api.createGroupingDraftFromPreset({ sessionId, presetId: event.target.value })); }}><option value="">請選擇分組預設</option>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}（{preset.groupCount} 組）</option>)}</select></label><label className="field"><span>隨機分組</span><input aria-label="隨機組數" min="1" type="number" value={randomCount} onChange={(event) => setRandomCount(event.target.value)} /></label><button className="button ghost" disabled={working} onClick={() => void sourceAction(() => api.createRandomGroupingDraft({ sessionId, groupCount: Number(randomCount) }))} type="button">隨機建立</button><button className="button ghost" disabled={working} onClick={() => void sourceAction(() => api.createManualGroupingDraft(sessionId))} type="button">手動建立</button>{overview.currentGroupSet && <button className="button ghost" disabled={working} onClick={() => void sourceAction(() => api.cloneCurrentGroupingDraft(sessionId))} type="button">複製目前分組</button>}</div></section>}
    {!readOnly && localDraft && <section className="session-grouping-draft form-card"><div className="list-card-header"><div><h3>分組草稿</h3><p className="muted">尚未套用；可編輯後儲存。</p></div><span>{localDraft.state}</span></div><DraftEditor draft={localDraft} participants={overview.participants} onChange={updateLocalDraft} /><p className="muted">尚有 {unassignedDraft.length} 位學生未分組。</p><div className="form-actions"><button className="button primary" disabled={working || !dirty} onClick={() => void handleSave()} type="button">儲存草稿</button><button className="button ghost" disabled={working} onClick={() => void handleCancel()} type="button">取消草稿</button><button className="button primary" disabled={working} onClick={() => void handleFinalize()} type="button">套用分組</button></div></section>}
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

function GroupCards({ groups, participants }: { groups: SessionGroupingGroup[]; participants: ReadonlyArray<readonly [string, string]> }) { const labels = new Map(participants); return <div className="session-grouping-group-list">{groups.map((group) => <article className="session-grouping-group" key={group.id}><strong>{group.name}</strong><span>{group.participantIds.map((id) => labels.get(id) ?? "未知參與者").join("、") || "尚無學生"}</span></article>)}</div>; }
function Unassigned({ people, label }: { people: SessionGroupingOverview["participants"]; label: string }) { return <p className="muted">{label}：{people.length ? people.map((person) => `${person.seatNumber} 號 ${person.displayName}`).join("、") : "無"}</p>; }
function groupingError(code: string): string { const messages: Record<string, string> = { active_draft_exists: "目前已有正在編輯的分組草稿。", session_ended: "課堂已結束，分組不可再修改。", preset_classroom_mismatch: "這個分組預設不屬於目前課堂。", group_preset_not_found: "找不到分組預設。", no_participants: "目前沒有已加入的學生。", invalid_group_count: "組數必須介於 1 與學生人數之間。", group_full: "分組人數超過容量。", stale_participant: "學生名單已變更，請重新載入課堂分組。", draft_not_open: "分組草稿目前不可編輯。" }; return messages[code] ?? "無法完成分組操作。"; }
