import { useEffect, useMemo, useState } from "react";
import { TeacherApiError } from "../../services/teacherApi";
import type {
  Classroom,
  GroupPresetDetail,
  GroupPresetSummary,
  Student,
  TeacherApi,
} from "../../types/teacher";

type GroupingApi = Required<
  Pick<
    TeacherApi,
    | "listGroupPresets"
    | "getGroupPreset"
    | "createGroupPreset"
    | "updateGroupPreset"
    | "deleteGroupPreset"
    | "listStudents"
  >
>;

interface GroupPresetPageProps {
  api: GroupingApi;
  classrooms: Classroom[];
  initialClassroomId?: string;
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

interface EditorGroup {
  key: string;
  id?: string;
  name: string;
  position: number;
}

interface PresetEditorDraft {
  presetId: string;
  name: string;
  groups: EditorGroup[];
  assignments: Array<{ groupId: string; studentId: string }>;
}

let nextLocalGroupKey = 0;

const errorMessages: Record<string, string> = {
  group_preset_name_conflict: "同一個班級內不能有重複的分組預設名稱。",
  group_name_conflict: "同一個分組預設內不能有重複的組別名稱。",
  student_classroom_mismatch: "部分學生已不屬於此班級，請重新載入後再試。",
  student_not_found: "部分學生已不存在，請重新載入後再試。",
  group_preset_not_found: "分組預設已不存在，請重新載入。",
  group_not_found: "部分組別已不存在，請重新載入。",
  validation_error: "請檢查分組預設名稱、組別名稱與排序。",
  conflict: "資料已被更新，請重新載入後再試。",
};

function localGroupKey(): string {
  nextLocalGroupKey += 1;
  return `new-group-${Date.now()}-${nextLocalGroupKey}`;
}

function messageFor(error: unknown): string {
  if (error instanceof TeacherApiError) {
    return errorMessages[error.code] ?? "無法完成分組預設操作，請再試一次。";
  }
  return "無法完成分組預設操作，請再試一次。";
}

function normalized(value: string): string {
  return value.trim().normalize("NFKC");
}

function editorFromDetail(detail: GroupPresetDetail): PresetEditorDraft {
  return {
    presetId: detail.preset.id,
    name: detail.preset.name,
    groups: detail.groups
      .slice()
      .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
      .map((group) => ({ key: group.id, id: group.id, name: group.name, position: group.position })),
    assignments: detail.members.map((member) => ({ groupId: member.groupId, studentId: member.studentId })),
  };
}

function reindex(groups: EditorGroup[]): EditorGroup[] {
  return groups.map((group, index) => ({ ...group, position: index }));
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-TW");
}

export function GroupPresetPage({ api, classrooms, initialClassroomId, onBack, onDirtyChange }: GroupPresetPageProps) {
  const initialId = initialClassroomId && classrooms.some((classroom) => classroom.id === initialClassroomId)
    ? initialClassroomId
    : classrooms[0]?.id ?? "";
  const [classroomId, setClassroomId] = useState(initialId);
  const [students, setStudents] = useState<Student[]>([]);
  const [presets, setPresets] = useState<GroupPresetSummary[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PresetEditorDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(Boolean(initialId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newPresetName, setNewPresetName] = useState("");

  const sortedStudents = useMemo(
    () => students.slice().sort((left, right) => left.seat_number - right.seat_number || left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
    [students],
  );

  const markDirty = (next: boolean) => {
    setDirty(next);
    onDirtyChange(next);
  };

  const setDraftAndDirty = (next: PresetEditorDraft) => {
    setDraft(next);
    markDirty(true);
    setNotice("");
  };

  async function loadClassroom(nextClassroomId: string, preferredPresetId?: string) {
    if (!nextClassroomId) {
      setStudents([]);
      setPresets([]);
      setSelectedPresetId(null);
      setDraft(null);
      markDirty(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const [nextPresets, nextStudents] = await Promise.all([
        api.listGroupPresets(nextClassroomId),
        api.listStudents(nextClassroomId),
      ]);
      const nextPresetId = preferredPresetId && nextPresets.some((preset) => preset.id === preferredPresetId)
        ? preferredPresetId
        : nextPresets[0]?.id ?? null;
      let nextDraft: PresetEditorDraft | null = null;
      if (nextPresetId) {
        nextDraft = editorFromDetail(await api.getGroupPreset(nextClassroomId, nextPresetId));
      }
      setPresets(nextPresets);
      setStudents(nextStudents);
      setSelectedPresetId(nextPresetId);
      setDraft(nextDraft);
      markDirty(false);
    } catch (cause) {
      setError(messageFor(cause));
      setPresets([]);
      setStudents([]);
      setSelectedPresetId(null);
      setDraft(null);
      markDirty(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadClassroom(classroomId);
  }, [classroomId]);

  const selectPreset = async (presetId: string) => {
    if (presetId === selectedPresetId) return;
    if (dirty && !window.confirm("尚有未儲存的變更，確定要切換分組預設嗎？")) return;
    setLoading(true);
    setError("");
    try {
      const detail = await api.getGroupPreset(classroomId, presetId);
      setSelectedPresetId(presetId);
      setDraft(editorFromDetail(detail));
      markDirty(false);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setLoading(false);
    }
  };

  const changeClassroom = (nextClassroomId: string) => {
    if (dirty && !window.confirm("尚有未儲存的變更，確定要切換班級嗎？")) return;
    setClassroomId(nextClassroomId);
  };

  const createPreset = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newPresetName.trim()) {
      setError("請輸入分組預設名稱。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const detail = await api.createGroupPreset({ classroomId, name: newPresetName });
      const nextPresets = await api.listGroupPresets(classroomId);
      setPresets(nextPresets);
      setSelectedPresetId(detail.preset.id);
      setDraft(editorFromDetail(detail));
      setNewPresetName("");
      markDirty(false);
      setNotice("已建立分組預設，請新增組別並儲存。");
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSaving(false);
    }
  };

  const updateDraftGroup = (key: string, name: string) => {
    if (!draft) return;
    setDraftAndDirty({ ...draft, groups: draft.groups.map((group) => group.key === key ? { ...group, name } : group) });
  };

  const addGroup = () => {
    if (!draft) return;
    const group: EditorGroup = { key: localGroupKey(), name: `第 ${draft.groups.length + 1} 組`, position: draft.groups.length };
    setDraftAndDirty({ ...draft, groups: [...draft.groups, group] });
  };

  const removeGroup = (group: EditorGroup) => {
    if (!draft) return;
    if (!window.confirm("刪除此組後，組內學生會變成未分組。")) return;
    const groups = reindex(draft.groups.filter((item) => item.key !== group.key));
    const assignments = draft.assignments.filter((assignment) => assignment.groupId !== group.key);
    setDraftAndDirty({ ...draft, groups, assignments });
  };

  const moveGroup = (index: number, direction: -1 | 1) => {
    if (!draft) return;
    const target = index + direction;
    if (target < 0 || target >= draft.groups.length) return;
    const groups = draft.groups.slice();
    const current = groups[index];
    const next = groups[target];
    if (!current || !next) return;
    groups[index] = next;
    groups[target] = current;
    setDraftAndDirty({ ...draft, groups: reindex(groups) });
  };

  const assignStudent = (studentId: string, groupId: string) => {
    if (!draft) return;
    const assignments = draft.assignments.filter((assignment) => assignment.studentId !== studentId);
    if (groupId) assignments.push({ groupId, studentId });
    setDraftAndDirty({ ...draft, assignments });
  };

  const savePreset = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError("請輸入分組預設名稱。");
      return;
    }
    const names = new Set<string>();
    for (const group of draft.groups) {
      const groupName = normalized(group.name);
      if (!groupName) {
        setError("請輸入組別名稱。");
        return;
      }
      if (names.has(groupName)) {
        setError("同一個分組預設內不能有重複的組別名稱。");
        return;
      }
      names.add(groupName);
    }
    setSaving(true);
    setError("");
    try {
      const detail = await api.updateGroupPreset({
        classroomId,
        presetId: draft.presetId,
        name,
        groups: draft.groups.map((group) => ({ key: group.key, id: group.id, name: group.name, position: group.position })),
        assignments: draft.assignments,
      });
      const nextPresets = await api.listGroupPresets(classroomId);
      setPresets(nextPresets);
      setSelectedPresetId(detail.preset.id);
      setDraft(editorFromDetail(detail));
      markDirty(false);
      setNotice("分組預設已儲存。");
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSaving(false);
    }
  };

  const cancelChanges = () => {
    if (!draft || !dirty) return;
    void api.getGroupPreset(classroomId, draft.presetId)
      .then((detail) => {
        setDraft(editorFromDetail(detail));
        markDirty(false);
        setError("");
        setNotice("已取消未儲存的變更。");
      })
      .catch((cause: unknown) => setError(messageFor(cause)));
  };

  const deletePreset = async (preset: GroupPresetSummary) => {
    if (dirty && preset.id === selectedPresetId && !window.confirm("尚有未儲存的變更，確定要刪除目前分組預設嗎？")) return;
    if (!window.confirm("刪除分組預設不會刪除學生，也不會影響已建立的課堂分組紀錄。")) return;
    setSaving(true);
    setError("");
    try {
      await api.deleteGroupPreset(classroomId, preset.id);
      await loadClassroom(classroomId);
      setNotice("分組預設已刪除。");
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSaving(false);
    }
  };

  const assignmentByStudent = useMemo(() => new Map(draft?.assignments.map((assignment) => [assignment.studentId, assignment.groupId]) ?? []), [draft]);
  const selectedClassroom = classrooms.find((classroom) => classroom.id === classroomId);

  return <div className="grouping-page">
    <div className="page-heading compact">
      <div><p className="eyebrow">教師工作區</p><h2>分組設定</h2><p className="intro">為班級建立可重複使用的分組預設，並在儲存時一次套用完整指派。</p></div>
      <button className="button ghost" type="button" onClick={onBack}>返回班級</button>
    </div>
    {error && <div className="error-banner" role="alert"><strong>無法完成此操作。</strong><span>{error}</span><button type="button" onClick={() => setError("")}>關閉</button></div>}
    {notice && <div className="success-banner" role="status">{notice}</div>}
    {classrooms.length === 0 ? <div className="state-card"><h3>請先建立班級</h3><p>建立班級後，才能設定分組預設。</p></div> : <>
      <label className="select-label grouping-classroom-select" htmlFor="grouping-classroom">班級<select id="grouping-classroom" value={classroomId} onChange={(event) => changeClassroom(event.target.value)}>{classrooms.map((classroom) => <option key={classroom.id} value={classroom.id}>{classroom.name}</option>)}</select></label>
      {loading ? <div className="state-card"><span className="spinner" />正在載入分組設定…</div> : <div className="grouping-layout">
        <section className="list-card preset-list-card" aria-label="分組預設清單">
          <div className="list-card-header"><div><h3>分組預設</h3><small>{selectedClassroom?.name ?? ""}</small></div><span>{presets.length}</span></div>
          <form className="mini-form" onSubmit={(event) => void createPreset(event)}>
            <label className="field" htmlFor="new-preset-name"><span>建立分組預設</span><input id="new-preset-name" value={newPresetName} onChange={(event) => setNewPresetName(event.target.value)} placeholder="例如：平時分組" /></label>
            <button className="button primary compact-button" disabled={saving} type="submit">建立分組預設</button>
          </form>
          {presets.length === 0 ? <div className="empty-state compact-empty"><span>＋</span><p>目前還沒有分組預設。</p><button className="button ghost compact-button" type="button" onClick={() => document.getElementById("new-preset-name")?.focus()}>建立分組預設</button></div> : <ul className="preset-list">{presets.map((preset) => <li className={preset.id === selectedPresetId ? "selected" : ""} key={preset.id}>
            <button aria-pressed={preset.id === selectedPresetId} className="preset-select" type="button" onClick={() => void selectPreset(preset.id)}><strong>{preset.name}</strong><small>{preset.groupCount} 個組別 · {preset.assignedStudentCount} 位學生</small><small>更新於 {formatUpdatedAt(preset.updatedAt)}</small></button>
            <button className="text-button danger" type="button" disabled={saving} onClick={() => void deletePreset(preset)}>刪除</button>
          </li>)}</ul>}
        </section>
        {!draft ? <section className="form-card editor-empty"><h3>尚未選取分組預設</h3><p>請先建立或選取一個分組預設。</p></section> : <section className="form-card preset-editor" aria-label="分組預設編輯器">
          <div className="editor-title-row"><div><p className="eyebrow">分組預設</p><h3>編輯「{draft.name}」</h3></div>{dirty && <span className="dirty-pill">尚有未儲存的變更</span>}</div>
          <label className="field" htmlFor="preset-name"><span>預設名稱</span><input id="preset-name" value={draft.name} onChange={(event) => setDraftAndDirty({ ...draft, name: event.target.value })} /></label>
          <div className="group-editor-section"><div className="editor-subheading"><span>組別</span><button className="button ghost compact-button" type="button" onClick={addGroup}>新增組別</button></div>
            {draft.groups.length === 0 ? <p className="grouping-note">尚未建立組別。新增組別後即可分配學生。</p> : <ul className="group-editor-list">{draft.groups.map((group, index) => <li key={group.key}><label className="field"><span className="sr-only">第 {index + 1} 組名稱</span><input aria-label={`第 ${index + 1} 組名稱`} value={group.name} onChange={(event) => updateDraftGroup(group.key, event.target.value)} /></label><div className="row-actions"><button className="icon-button" disabled={index === 0} type="button" aria-label={`第 ${index + 1} 組上移`} onClick={() => moveGroup(index, -1)}>↑</button><button className="icon-button" disabled={index === draft.groups.length - 1} type="button" aria-label={`第 ${index + 1} 組下移`} onClick={() => moveGroup(index, 1)}>↓</button><button className="text-button danger" aria-label={`第 ${index + 1} 組刪除`} type="button" onClick={() => removeGroup(group)}>刪除</button></div></li>)}</ul>}
          </div>
          <div className="group-editor-section"><div className="editor-subheading"><span>學生分組</span><small>學生依座號排序；未指派者顯示為未分組。</small></div><div className="group-student-table-scroll"><table className="group-student-table"><caption className="sr-only">{selectedClassroom?.name ?? "班級"}學生分組指派</caption><thead><tr><th scope="col">座號</th><th scope="col">姓名</th><th scope="col">分組</th></tr></thead><tbody>{sortedStudents.map((student) => <tr key={student.id}><th scope="row">{student.seat_number}</th><td>{student.name}</td><td><label className="sr-only" htmlFor={`student-group-${student.id}`}>{student.name} 分組</label><select id={`student-group-${student.id}`} value={assignmentByStudent.get(student.id) ?? ""} onChange={(event) => assignStudent(student.id, event.target.value)}><option value="">未分組</option>{draft.groups.map((group) => <option key={group.key} value={group.key}>{group.name || "未命名組別"}</option>)}</select></td></tr>)}</tbody></table>{sortedStudents.length === 0 && <p className="grouping-note">這個班級尚未有學生。</p>}</div></div>
          <div className="form-actions"><button className="button primary" disabled={!dirty || saving} type="button" onClick={() => void savePreset()}>{saving ? "儲存中…" : "儲存"}</button><button className="button ghost" disabled={!dirty || saving} type="button" onClick={cancelChanges}>取消變更</button></div>
        </section>}
      </div>}
    </>}
  </div>;
}

export type { GroupingApi };
