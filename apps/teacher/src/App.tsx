import { useEffect, useMemo, useState } from "react";
import { APP_NAME } from "@classtools/shared";
import { teacherApi, TeacherApiError } from "./services/teacherApi";
import type { Classroom, Course, Lesson, Student, TeacherApi } from "./types/teacher";
import { QuestionBankPage } from "./features/question-bank/QuestionBankPage";

type Page = "home" | "classrooms" | "students" | "courses" | "lessons" | "question-bank";
const nav: Array<{ id: Page; label: string }> = [
  { id: "home", label: "Home" }, { id: "classrooms", label: "Classrooms" }, { id: "students", label: "Students" },
  { id: "courses", label: "Courses" }, { id: "lessons", label: "Lessons" }, { id: "question-bank", label: "Question Bank" },
];
const later = ["Sessions", "Settings"];

interface AppProps { api?: TeacherApi }

export function App({ api = teacherApi }: AppProps) {
  const [page, setPage] = useState<Page>("home");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [classrooms, setClassrooms] = useState<Classroom[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);

  const run = async (operation: () => Promise<void>) => {
    setError("");
    try { await operation(); } catch (cause) { setError(cause instanceof TeacherApiError ? cause.message : "Something went wrong. Please try again."); }
  };
  const refresh = async () => run(async () => {
    const [storage, nextClassrooms, nextCourses] = await Promise.all([api.getLocalDatabaseStatus(), api.listClassrooms(), api.listCourses()]);
    if (!storage.database_open) throw new Error("Local storage is unavailable.");
    setClassrooms(nextClassrooms); setCourses(nextCourses); setStatus("ready");
  });
  useEffect(() => { void refresh(); }, []);

  const pageTitle = useMemo(() => nav.find((item) => item.id === page)?.label ?? "Home", [page]);
  return <div className="teacher-shell">
    <header className="teacher-header"><div><p className="eyebrow">Teacher workspace</p><h1>{APP_NAME}</h1></div><span className="phase-badge">Phase 5</span></header>
    <div className="teacher-body">
      <nav aria-label="Teacher navigation" className="teacher-nav">
        {nav.map((item) => <button className={`nav-item ${page === item.id ? "active" : ""}`} key={item.id} onClick={() => setPage(item.id)} type="button">{item.label}</button>)}
        <div className="nav-divider" />
        {later.map((item) => <button className="nav-item disabled" disabled key={item} type="button">{item}<span>Later</span></button>)}
      </nav>
      <main className="teacher-main">
        {error && <div className="error-banner" role="alert"><strong>Couldn’t complete that action.</strong><span>{error}</span><button onClick={() => setError("")} type="button">Dismiss</button></div>}
        {status === "loading" && <div className="state-card"><span className="spinner" />Loading local workspace…</div>}
        {status === "error" && <div className="state-card"><h2>Local storage unavailable</h2><p>{error || "The local database could not be opened."}</p><button className="button primary" onClick={() => { setStatus("loading"); void refresh(); }} type="button">Retry</button></div>}
        {status === "ready" && page === "home" && <Home classrooms={classrooms} courses={courses} onNavigate={setPage} />}
        {status === "ready" && page === "classrooms" && <Classrooms api={api} data={classrooms} onChange={setClassrooms} onError={setError} />}
        {status === "ready" && page === "students" && <Students api={api} classrooms={classrooms} onError={setError} />}
        {status === "ready" && page === "courses" && <Courses api={api} data={courses} onChange={setCourses} onError={setError} />}
        {status === "ready" && page === "lessons" && <Lessons api={api} courses={courses} onError={setError} />}
        {status === "ready" && page === "question-bank" && <QuestionBankPage api={api} onError={setError} />}
        {status === "ready" && page !== "home" && <p className="page-kicker">Teacher workspace / {pageTitle}</p>}
      </main>
    </div>
  </div>;
}

function Home({ classrooms, courses, onNavigate }: { classrooms: Classroom[]; courses: Course[]; onNavigate: (page: Page) => void }) {
  return <><div className="page-heading"><div><p className="eyebrow">Overview</p><h2>Ready for your next class.</h2><p className="intro">Manage your local teaching workspace from one calm, focused place.</p></div><span className="ready-pill"><span />Local storage ready</span></div><section className="overview-grid"><button className="overview-card" onClick={() => onNavigate("classrooms")} type="button"><span className="card-label">Classrooms</span><strong>{classrooms.length}</strong><small>Manage your groups and students</small></button><button className="overview-card" onClick={() => onNavigate("courses")} type="button"><span className="card-label">Courses</span><strong>{courses.length}</strong><small>Organize your lesson plans</small></button><button className="overview-card" onClick={() => onNavigate("question-bank")} type="button"><span className="card-label">Question Bank</span><strong>Author</strong><small>Create validated question sets and previews</small></button></section></>;
}

function Classrooms({ api, data, onChange, onError }: { api: TeacherApi; data: Classroom[]; onChange: (items: Classroom[]) => void; onError: (message: string) => void }) {
  const [editing, setEditing] = useState<Classroom | null>(null); const [name, setName] = useState(""); const [year, setYear] = useState(""); const [saving, setSaving] = useState(false);
  const reset = () => { setEditing(null); setName(""); setYear(""); };
  const submit = async (event: React.FormEvent) => { event.preventDefault(); if (!name.trim()) return onError("Classroom name is required."); setSaving(true); try { const item = editing ? await api.updateClassroom(editing.id, { name, academic_year: year || null }) : await api.createClassroom({ name, academic_year: year || null }); onChange(editing ? data.map((row) => row.id === item.id ? item : row) : [...data, item]); reset(); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "Could not save classroom."); } finally { setSaving(false); } };
  const remove = async (item: Classroom) => { if (!window.confirm(`Delete ${item.name}? Students must be removed first.`)) return; try { await api.deleteClassroom(item.id); onChange(data.filter((row) => row.id !== item.id)); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "Could not delete classroom."); } };
  return <><PageHeading title="Classrooms" description="Create the groups you teach and keep their academic year close at hand." /><div className="split-layout"><form className="form-card" onSubmit={submit}><h3>{editing ? "Edit classroom" : "New classroom"}</h3><Field label="Classroom name" value={name} onChange={setName} placeholder="e.g. 3A Mathematics" /><Field label="Academic year" value={year} onChange={setYear} placeholder="Optional" /><div className="form-actions"><button className="button primary" disabled={saving} type="submit">{saving ? "Saving…" : editing ? "Save changes" : "Create classroom"}</button>{editing && <button className="button ghost" onClick={reset} type="button">Cancel</button>}</div></form><section className="list-card" aria-label="Classrooms list"><div className="list-card-header"><h3>Your classrooms</h3><span>{data.length}</span></div>{data.length === 0 ? <EmptyState text="No classrooms yet. Create your first group." /> : <ul className="entity-list">{data.map((item) => <li key={item.id}><div><strong>{item.name}</strong><small>{item.academic_year || "Academic year not set"}</small></div><div className="row-actions"><button className="text-button" onClick={() => { setEditing(item); setName(item.name); setYear(item.academic_year ?? ""); }} type="button">Edit</button><button className="text-button danger" onClick={() => void remove(item)} type="button">Delete</button></div></li>)}</ul>}</section></div></>;
}

function Students({ api, classrooms, onError }: { api: TeacherApi; classrooms: Classroom[]; onError: (message: string) => void }) {
  const [classId, setClassId] = useState(classrooms[0]?.id ?? ""); const [data, setData] = useState<Student[]>([]); const [editing, setEditing] = useState<Student | null>(null); const [seat, setSeat] = useState(""); const [name, setName] = useState(""); const [saving, setSaving] = useState(false);
  useEffect(() => { if (classId) void api.listStudents(classId).then(setData).catch((cause) => onError(cause instanceof TeacherApiError ? cause.message : "Could not load students.")); }, [classId]);
  const reset = () => { setEditing(null); setSeat(""); setName(""); };
  const submit = async (event: React.FormEvent) => { event.preventDefault(); const numeric = Number(seat); if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 1000) return onError("Seat number must be a positive whole number."); if (!name.trim()) return onError("Student name is required."); setSaving(true); try { const item = editing ? await api.updateStudent(editing.id, { seat_number: numeric, name }) : await api.createStudent({ class_id: classId, seat_number: numeric, name }); setData(editing ? data.map((row) => row.id === item.id ? item : row) : [...data, item].sort((a, b) => a.seat_number - b.seat_number)); reset(); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "Could not save student."); } finally { setSaving(false); } };
  const remove = async (item: Student) => { if (!window.confirm(`Delete ${item.name}?`)) return; try { await api.deleteStudent(item.id); setData(data.filter((row) => row.id !== item.id)); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "Could not delete student."); } };
  return <><PageHeading title="Students" description="Keep a clear, seat-ordered roster for the selected classroom." /><label className="select-label" htmlFor="student-class">Classroom<select id="student-class" value={classId} onChange={(event) => { setClassId(event.target.value); reset(); }}><option value="">Select a classroom</option>{classrooms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{classId && <div className="split-layout"><form className="form-card" onSubmit={submit}><h3>{editing ? "Edit student" : "Add student"}</h3><Field label="Seat number" value={seat} onChange={setSeat} placeholder="1" type="number" /><Field label="Student name" value={name} onChange={setName} placeholder="Full name" /><div className="form-actions"><button className="button primary" disabled={saving} type="submit">{saving ? "Saving…" : editing ? "Save changes" : "Add student"}</button>{editing && <button className="button ghost" onClick={reset} type="button">Cancel</button>}</div></form><section className="list-card"><div className="list-card-header"><h3>Roster</h3><span>{data.length}</span></div>{data.length === 0 ? <EmptyState text="No students in this classroom yet." /> : <ul className="entity-list">{data.map((item) => <li key={item.id}><div className="seat"><b>{item.seat_number}</b><strong>{item.name}</strong></div><div className="row-actions"><button className="text-button" onClick={() => { setEditing(item); setSeat(String(item.seat_number)); setName(item.name); }} type="button">Edit</button><button className="text-button danger" onClick={() => void remove(item)} type="button">Delete</button></div></li>)}</ul>}</section></div>}</>;
}

function Courses({ api, data, onChange, onError }: { api: TeacherApi; data: Course[]; onChange: (items: Course[]) => void; onError: (message: string) => void }) {
  const [editing, setEditing] = useState<Course | null>(null); const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [saving, setSaving] = useState(false); const reset = () => { setEditing(null); setName(""); setDescription(""); };
  const submit = async (event: React.FormEvent) => { event.preventDefault(); if (!name.trim()) return onError("Course name is required."); setSaving(true); try { const item = editing ? await api.updateCourse(editing.id, { name, description: description || null }) : await api.createCourse({ name, description: description || null }); onChange(editing ? data.map((row) => row.id === item.id ? item : row) : [...data, item]); reset(); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "Could not save course."); } finally { setSaving(false); } };
  const remove = async (item: Course) => { if (!window.confirm(`Delete ${item.name}? Lessons must be removed first.`)) return; try { await api.deleteCourse(item.id); onChange(data.filter((row) => row.id !== item.id)); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "Could not delete course."); } };
  return <><PageHeading title="Courses" description="Organize reusable course areas before you add lessons." /><div className="split-layout"><form className="form-card" onSubmit={submit}><h3>{editing ? "Edit course" : "New course"}</h3><Field label="Course name" value={name} onChange={setName} placeholder="e.g. Geometry" /><label className="field"><span>Description <em>Optional</em></span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="A short note for your teaching plan" rows={4} /></label><div className="form-actions"><button className="button primary" disabled={saving} type="submit">{saving ? "Saving…" : editing ? "Save changes" : "Create course"}</button>{editing && <button className="button ghost" onClick={reset} type="button">Cancel</button>}</div></form><section className="list-card"><div className="list-card-header"><h3>Your courses</h3><span>{data.length}</span></div>{data.length === 0 ? <EmptyState text="No courses yet. Create your first course." /> : <ul className="entity-list">{data.map((item) => <li key={item.id}><div><strong>{item.name}</strong><small>{item.description || "No description"}</small></div><div className="row-actions"><button className="text-button" onClick={() => { setEditing(item); setName(item.name); setDescription(item.description ?? ""); }} type="button">Edit</button><button className="text-button danger" onClick={() => void remove(item)} type="button">Delete</button></div></li>)}</ul>}</section></div></>;
}

function Lessons({ api, courses, onError }: { api: TeacherApi; courses: Course[]; onError: (message: string) => void }) {
  const [courseId, setCourseId] = useState(courses[0]?.id ?? ""); const [data, setData] = useState<Lesson[]>([]); const [editing, setEditing] = useState<Lesson | null>(null); const [title, setTitle] = useState(""); const [description, setDescription] = useState(""); const [position, setPosition] = useState("0"); const [saving, setSaving] = useState(false);
  useEffect(() => { if (courseId) void api.listLessons(courseId).then(setData).catch((cause) => onError(cause instanceof TeacherApiError ? cause.message : "Could not load lessons.")); }, [courseId]);
  const reset = () => { setEditing(null); setTitle(""); setDescription(""); setPosition(String(data.length)); };
  const submit = async (event: React.FormEvent) => { event.preventDefault(); const numeric = Number(position); if (!title.trim()) return onError("Lesson title is required."); if (!Number.isInteger(numeric) || numeric < 0) return onError("Position must be zero or greater."); setSaving(true); try { const item = editing ? await api.updateLesson(editing.id, { title, description: description || null, position: numeric }) : await api.createLesson({ course_id: courseId, title, description: description || null, position: numeric }); setData((editing ? data.map((row) => row.id === item.id ? item : row) : [...data, item]).sort((a, b) => a.position - b.position)); reset(); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "Could not save lesson."); } finally { setSaving(false); } };
  const remove = async (item: Lesson) => { if (!window.confirm(`Delete ${item.title}?`)) return; try { await api.deleteLesson(item.id); setData(data.filter((row) => row.id !== item.id)); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "Could not delete lesson."); } };
  return <><PageHeading title="Lessons" description="Build a simple ordered lesson outline for each course." /><label className="select-label" htmlFor="lesson-course">Course<select id="lesson-course" value={courseId} onChange={(event) => { setCourseId(event.target.value); reset(); }}><option value="">Select a course</option>{courses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{courseId && <div className="split-layout"><form className="form-card" onSubmit={submit}><h3>{editing ? "Edit lesson" : "New lesson"}</h3><Field label="Lesson title" value={title} onChange={setTitle} placeholder="e.g. Triangle properties" /><Field label="Position" value={position} onChange={setPosition} type="number" /><label className="field"><span>Description <em>Optional</em></span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} /></label><div className="form-actions"><button className="button primary" disabled={saving} type="submit">{saving ? "Saving…" : editing ? "Save changes" : "Create lesson"}</button>{editing && <button className="button ghost" onClick={reset} type="button">Cancel</button>}</div></form><section className="list-card"><div className="list-card-header"><h3>Lesson outline</h3><span>{data.length}</span></div>{data.length === 0 ? <EmptyState text="No lessons yet. Add the first lesson." /> : <ul className="entity-list">{data.map((item) => <li key={item.id}><div className="seat"><b>{item.position + 1}</b><div><strong>{item.title}</strong><small>{item.description || "No description"}</small></div></div><div className="row-actions"><button className="text-button" onClick={() => { setEditing(item); setTitle(item.title); setDescription(item.description ?? ""); setPosition(String(item.position)); }} type="button">Edit</button><button className="text-button danger" onClick={() => void remove(item)} type="button">Delete</button></div></li>)}</ul>}</section></div>}</>;
}

function PageHeading({ title, description }: { title: string; description: string }) { return <div className="page-heading compact"><div><p className="eyebrow">Teacher workspace</p><h2>{title}</h2><p className="intro">{description}</p></div></div>; }
function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) { return <label className="field"><span>{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>; }
function EmptyState({ text }: { text: string }) { return <div className="empty-state"><span>✦</span><p>{text}</p></div>; }
