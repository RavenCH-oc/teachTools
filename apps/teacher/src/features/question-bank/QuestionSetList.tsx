import { useState } from "react";
import type { Course, Lesson, TeacherApi } from "../../types/teacher";
import type { TeacherApiError } from "../../services/teacherApi";
import type { QuestionSet } from "@classtools/domain";

interface Props {
  api: TeacherApi;
  sets: QuestionSet[];
  selectedId: string | null;
  courses: Course[];
  lessons: Lesson[];
  onSelect: (id: string) => void;
  onChange: (sets: QuestionSet[]) => void;
  onError: (message: string) => void;
}

export function QuestionSetList({ api, sets, selectedId, courses, lessons, onSelect, onChange, onError }: Props) {
  const [editing, setEditing] = useState<QuestionSet | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [lessonId, setLessonId] = useState("");
  const [saving, setSaving] = useState(false);
  const reset = () => { setEditing(null); setTitle(""); setDescription(""); setLessonId(""); };
  const edit = (set: QuestionSet) => { setEditing(set); setTitle(set.title); setDescription(set.description ?? ""); setLessonId(set.lessonId ?? ""); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return onError("Question Set title is required.");
    setSaving(true);
    try {
      const request = { title: title.trim(), description: description.trim() || null, lessonId: lessonId || null };
      const item = editing ? await api.updateQuestionSet(editing.id, request) : await api.createQuestionSet(request);
      onChange(editing ? sets.map((row) => row.id === item.id ? item : row) : [...sets, item]);
      onSelect(item.id); reset();
    } catch (cause) { onError(cause instanceof Error ? cause.message : "Could not save Question Set."); }
    finally { setSaving(false); }
  };
  const remove = async (set: QuestionSet) => {
    if (!window.confirm(`Delete ${set.title}? Questions in this set must be removed first.`)) return;
    try { await api.deleteQuestionSet(set.id); onChange(sets.filter((row) => row.id !== set.id)); if (selectedId === set.id) onSelect(""); }
    catch (cause) {
      const error = cause as TeacherApiError;
      onError(error?.code === "conflict" ? "This Question Set still contains questions. Delete the questions first." : "Could not delete Question Set.");
    }
  };
  return <section className="question-set-panel" aria-label="Question Sets">
    <div className="list-card-header"><h3>Question Sets</h3><span>{sets.length}</span></div>
    <form className="mini-form" onSubmit={submit}>
      <label className="field"><span>{editing ? "Edit title" : "New title"}</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} placeholder="e.g. Fractions review" /></label>
      <label className="field"><span>Description <em>Optional</em></span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} rows={2} /></label>
      <label className="field"><span>Lesson <em>Optional</em></span><select value={lessonId} onChange={(event) => setLessonId(event.target.value)}><option value="">Standalone Question Set</option>{courses.map((course) => <optgroup key={course.id} label={course.name}>{lessons.filter((lesson) => lesson.course_id === course.id).map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.title}</option>)}</optgroup>)}</select></label>
      <div className="form-actions"><button className="button primary" disabled={saving} type="submit">{saving ? "Saving…" : editing ? "Save set" : "Create set"}</button>{editing && <button className="button ghost" onClick={reset} type="button">Cancel</button>}</div>
    </form>
    {sets.length === 0 ? <div className="empty-state compact-empty"><span>＋</span><p>Create your first Question Set.</p></div> : <ul className="entity-list question-set-list">{sets.map((set) => <li className={selectedId === set.id ? "selected" : ""} key={set.id}><button className="entity-select" onClick={() => onSelect(set.id)} type="button"><strong>{set.title}</strong><small>{set.lessonId ? lessons.find((lesson) => lesson.id === set.lessonId)?.title ?? "Lesson" : "Standalone"}</small></button><div className="row-actions"><button className="text-button" onClick={() => edit(set)} type="button">Edit</button><button className="text-button danger" onClick={() => void remove(set)} type="button">Delete</button></div></li>)}</ul>}
  </section>;
}
