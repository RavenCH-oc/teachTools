import { useEffect, useMemo, useState } from "react";
import { APP_NAME } from "@classtools/shared";
import { teacherApi, TeacherApiError } from "./services/teacherApi";
import type { AnalysisSession } from "./features/session-analysis/SessionAnalysisPage";
import { SessionAnalysisPage } from "./features/session-analysis/SessionAnalysisPage";
import { SessionHistoryPage } from "./features/session-analysis/SessionHistoryPage";
import type { Classroom, Course, Lesson, Student, TeacherApi } from "./types/teacher";
import { QuestionBankPage } from "./features/question-bank/QuestionBankPage";
import { LocalServerPanel } from "./features/local-server/LocalServerPanel";
import { LocalSessionLobbyPage } from "./features/local-session/LocalSessionLobbyPage";
import { LiveQuizPage } from "./features/live-quiz/LiveQuizPage";

type Page = "home" | "classrooms" | "students" | "courses" | "lessons" | "question-bank" | "local-session" | "live-quiz" | "session-history" | "session-analysis";
const nav: Array<{ id: Page; label: string }> = [
  { id: "home", label: "首頁" }, { id: "classrooms", label: "班級" }, { id: "students", label: "學生" },
  { id: "courses", label: "課程" }, { id: "lessons", label: "課程單元" }, { id: "question-bank", label: "題庫" }, { id: "local-session", label: "課堂" }, { id: "live-quiz", label: "即時測驗" }, { id: "session-history", label: "課堂紀錄" },
];
const later = ["設定"];

interface AppProps { api?: TeacherApi }

export function App({ api = teacherApi }: AppProps) {
  const [page, setPage] = useState<Page>("home");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [classrooms, setClassrooms] = useState<Classroom[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [hasQuestionDraft, setHasQuestionDraft] = useState(false);
  const [analysisContext, setAnalysisContext] = useState<{ session: AnalysisSession; returnPage: "session-history" | "live-quiz" } | null>(null);

  const run = async (operation: () => Promise<void>) => {
    setError("");
    try { await operation(); } catch (cause) { setError(cause instanceof TeacherApiError ? cause.message : "操作未完成，請再試一次。"); }
  };
  const refresh = async () => run(async () => {
    const [storage, nextClassrooms, nextCourses] = await Promise.all([api.getLocalDatabaseStatus(), api.listClassrooms(), api.listCourses()]);
    if (!storage.database_open) throw new Error("Local storage is unavailable.");
    setClassrooms(nextClassrooms); setCourses(nextCourses); setStatus("ready");
  });
  useEffect(() => { void refresh(); }, []);

  const pageTitle = useMemo(() => nav.find((item) => item.id === page)?.label ?? (page === "session-analysis" ? "課堂統計" : "首頁"), [page]);
  const navigate = (next: Page) => {
    if (page === "question-bank" && hasQuestionDraft && next !== page) {
      setError("請先建立或取消目前的題目草稿，再離開題庫。");
      return;
    }
    setError(""); setPage(next);
  };
  const openAnalysis = (session: AnalysisSession, returnPage: "session-history" | "live-quiz") => { setAnalysisContext({ session, returnPage }); setError(""); setPage("session-analysis"); };
  return <div className="teacher-shell">
    <header className="teacher-header"><div><p className="eyebrow">教師工作區</p><h1>{APP_NAME}</h1></div><span className="phase-badge">第 9 階段</span></header>
    <div className="teacher-body">
      <nav aria-label="教師導覽" className="teacher-nav">
        {nav.map((item) => <button className={`nav-item ${page === item.id ? "active" : ""}`} key={item.id} onClick={() => navigate(item.id)} type="button">{item.label}</button>)}
        <div className="nav-divider" />
        {later.map((item) => <button className="nav-item disabled" disabled key={item} type="button">{item}<span>後續階段</span></button>)}
      </nav>
      <main className="teacher-main">
        {error && <div className="error-banner" role="alert"><strong>無法完成此操作。</strong><span>{error}</span><button onClick={() => setError("")} type="button">關閉</button></div>}
        {status === "loading" && <div className="state-card"><span className="spinner" />正在載入本機工作區…</div>}
        {status === "error" && <div className="state-card"><h2>本機儲存空間無法使用</h2><p>{error || "無法開啟本機資料庫。"}</p><button className="button primary" onClick={() => { setStatus("loading"); void refresh(); }} type="button">重試</button></div>}
        {status === "ready" && page === "home" && <Home api={api} classrooms={classrooms} courses={courses} onNavigate={navigate} />}
        {status === "ready" && page === "classrooms" && <Classrooms api={api} data={classrooms} onChange={setClassrooms} onError={setError} onOpenSessionHistory={() => navigate("session-history")} />}
        {status === "ready" && page === "students" && <Students api={api} classrooms={classrooms} onError={setError} />}
        {status === "ready" && page === "courses" && <Courses api={api} data={courses} onChange={setCourses} onError={setError} />}
        {status === "ready" && page === "lessons" && <Lessons api={api} courses={courses} onError={setError} />}
        {status === "ready" && page === "question-bank" && <QuestionBankPage api={api} onDraftStateChange={setHasQuestionDraft} onError={setError} />}
        {status === "ready" && page === "local-session" && <LocalSessionLobbyPage api={api} classrooms={classrooms} onError={setError} onClearError={() => setError("")} onOpenLiveQuiz={() => navigate("live-quiz")} />}
        {status === "ready" && page === "live-quiz" && <LiveQuizPage api={api as Required<Pick<TeacherApi, "getLocalServerStatus" | "getActiveLocalSession" | "listQuestionSets" | "listQuestions" | "startLocalSession" | "publishSessionQuestion" | "listSessionQuestions" | "openSessionQuestion" | "lockSessionQuestion" | "reopenSessionQuestion" | "revealSessionQuestion" | "getSessionQuestionProgress" | "getQuestionStatistics">>} onError={setError} onOpenSessionAnalysis={(session) => openAnalysis(session, "live-quiz")} />}
        {status === "ready" && page === "session-history" && <SessionHistoryPage api={api as Required<Pick<TeacherApi, "listClassroomSessionHistory">>} classrooms={classrooms} onOpenSessionAnalysis={(session) => openAnalysis(session, "session-history")} />}
        {status === "ready" && page === "session-analysis" && analysisContext && <SessionAnalysisPage api={api as Required<Pick<TeacherApi, "getSessionStatistics" | "getDifficultQuestions" | "listSessionQuestions">>} session={analysisContext.session} onBack={() => navigate(analysisContext.returnPage)} />}
        {status === "ready" && page !== "home" && <p className="page-kicker">教師工作區 / {pageTitle}</p>}
      </main>
    </div>
  </div>;
}

function Home({ api, classrooms, courses, onNavigate }: { api: TeacherApi; classrooms: Classroom[]; courses: Course[]; onNavigate: (page: Page) => void }) {
  return <><div className="page-heading"><div><p className="eyebrow">總覽</p><h2>準備好開始下一堂課。</h2><p className="intro">在一個清晰、專注的空間中管理你的本機教學工作區。</p></div><span className="ready-pill"><span />本機儲存空間已就緒</span></div><section className="overview-grid"><button className="overview-card" onClick={() => onNavigate("classrooms")} type="button"><span className="card-label">班級</span><strong>{classrooms.length}</strong><small>管理班級與學生</small></button><button className="overview-card" onClick={() => onNavigate("courses")} type="button"><span className="card-label">課程</span><strong>{courses.length}</strong><small>整理教學計畫</small></button><button className="overview-card" onClick={() => onNavigate("question-bank")} type="button"><span className="card-label">題庫</span><strong>編輯</strong><small>建立經驗證的題組與預覽</small></button></section><LocalServerPanel api={api} /></>;
}

function Classrooms({ api, data, onChange, onError, onOpenSessionHistory }: { api: TeacherApi; data: Classroom[]; onChange: (items: Classroom[]) => void; onError: (message: string) => void; onOpenSessionHistory: () => void }) {
  const [editing, setEditing] = useState<Classroom | null>(null); const [name, setName] = useState(""); const [year, setYear] = useState(""); const [saving, setSaving] = useState(false);
  const reset = () => { setEditing(null); setName(""); setYear(""); };
  const submit = async (event: React.FormEvent) => { event.preventDefault(); if (!name.trim()) return onError("請輸入班級名稱。"); setSaving(true); try { const item = editing ? await api.updateClassroom(editing.id, { name, academic_year: year || null }) : await api.createClassroom({ name, academic_year: year || null }); onChange(editing ? data.map((row) => row.id === item.id ? item : row) : [...data, item]); reset(); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "無法儲存班級。"); } finally { setSaving(false); } };
  const remove = async (item: Classroom) => { if (!window.confirm(`確定要刪除「${item.name}」嗎？請先移除其中的學生。`)) return; try { await api.deleteClassroom(item.id); onChange(data.filter((row) => row.id !== item.id)); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "無法刪除班級。"); } };
  return <><div className="page-heading compact"><div><p className="eyebrow">教師工作區</p><h2>班級</h2><p className="intro">建立授課班級，並保留學年度資訊。</p></div><button className="button ghost" type="button" onClick={onOpenSessionHistory}>課堂紀錄</button></div><div className="split-layout"><form className="form-card" onSubmit={submit}><h3>{editing ? "編輯班級" : "新增班級"}</h3><Field label="班級名稱" value={name} onChange={setName} placeholder="例如：三年甲班" /><Field label="學年度" value={year} onChange={setYear} placeholder="選填" /><div className="form-actions"><button className="button primary" disabled={saving} type="submit">{saving ? "儲存中…" : editing ? "儲存變更" : "建立班級"}</button>{editing && <button className="button ghost" onClick={reset} type="button">取消</button>}</div></form><section className="list-card" aria-label="班級清單"><div className="list-card-header"><h3>我的班級</h3><span>{data.length}</span></div>{data.length === 0 ? <EmptyState text="尚未建立班級。請建立第一個班級。" /> : <ul className="entity-list">{data.map((item) => <li key={item.id}><div><strong>{item.name}</strong><small>{item.academic_year || "未設定學年度"}</small></div><div className="row-actions"><button className="text-button" onClick={() => { setEditing(item); setName(item.name); setYear(item.academic_year ?? ""); }} type="button">編輯</button><button className="text-button danger" onClick={() => void remove(item)} type="button">刪除</button></div></li>)}</ul>}</section></div></>;
}

function Students({ api, classrooms, onError }: { api: TeacherApi; classrooms: Classroom[]; onError: (message: string) => void }) {
  const [classId, setClassId] = useState(classrooms[0]?.id ?? ""); const [data, setData] = useState<Student[]>([]); const [editing, setEditing] = useState<Student | null>(null); const [seat, setSeat] = useState(""); const [name, setName] = useState(""); const [saving, setSaving] = useState(false);
  useEffect(() => { if (classId) void api.listStudents(classId).then(setData).catch((cause) => onError(cause instanceof TeacherApiError ? cause.message : "無法載入學生資料。")); }, [classId]);
  const reset = () => { setEditing(null); setSeat(""); setName(""); };
  const submit = async (event: React.FormEvent) => { event.preventDefault(); const numeric = Number(seat); if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 1000) return onError("座號必須為正整數。"); if (!name.trim()) return onError("請輸入學生姓名。"); setSaving(true); try { const item = editing ? await api.updateStudent(editing.id, { seat_number: numeric, name }) : await api.createStudent({ class_id: classId, seat_number: numeric, name }); setData(editing ? data.map((row) => row.id === item.id ? item : row) : [...data, item].sort((a, b) => a.seat_number - b.seat_number)); reset(); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "無法儲存學生資料。"); } finally { setSaving(false); } };
  const remove = async (item: Student) => { if (!window.confirm(`確定要刪除「${item.name}」嗎？`)) return; try { await api.deleteStudent(item.id); setData(data.filter((row) => row.id !== item.id)); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "無法刪除學生資料。"); } };
  return <><PageHeading title="學生" description="為所選班級維護清楚、依座號排序的名冊。" /><label className="select-label" htmlFor="student-class">班級<select id="student-class" value={classId} onChange={(event) => { setClassId(event.target.value); reset(); }}><option value="">請選擇班級</option>{classrooms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{classId && <div className="split-layout"><form className="form-card" onSubmit={submit}><h3>{editing ? "編輯學生" : "新增學生"}</h3><Field label="座號" value={seat} onChange={setSeat} placeholder="1" type="number" /><Field label="學生姓名" value={name} onChange={setName} placeholder="姓名" /><div className="form-actions"><button className="button primary" disabled={saving} type="submit">{saving ? "儲存中…" : editing ? "儲存變更" : "新增學生"}</button>{editing && <button className="button ghost" onClick={reset} type="button">取消</button>}</div></form><section className="list-card"><div className="list-card-header"><h3>名冊</h3><span>{data.length}</span></div>{data.length === 0 ? <EmptyState text="這個班級尚未有學生。" /> : <ul className="entity-list">{data.map((item) => <li key={item.id}><div className="seat"><b>{item.seat_number}</b><strong>{item.name}</strong></div><div className="row-actions"><button className="text-button" onClick={() => { setEditing(item); setSeat(String(item.seat_number)); setName(item.name); }} type="button">編輯</button><button className="text-button danger" onClick={() => void remove(item)} type="button">刪除</button></div></li>)}</ul>}</section></div>}</>;
}

function Courses({ api, data, onChange, onError }: { api: TeacherApi; data: Course[]; onChange: (items: Course[]) => void; onError: (message: string) => void }) {
  const [editing, setEditing] = useState<Course | null>(null); const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [saving, setSaving] = useState(false); const reset = () => { setEditing(null); setName(""); setDescription(""); };
  const submit = async (event: React.FormEvent) => { event.preventDefault(); if (!name.trim()) return onError("請輸入課程名稱。"); setSaving(true); try { const item = editing ? await api.updateCourse(editing.id, { name, description: description || null }) : await api.createCourse({ name, description: description || null }); onChange(editing ? data.map((row) => row.id === item.id ? item : row) : [...data, item]); reset(); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "無法儲存課程。"); } finally { setSaving(false); } };
  const remove = async (item: Course) => { if (!window.confirm(`確定要刪除「${item.name}」嗎？請先移除其中的課程單元。`)) return; try { await api.deleteCourse(item.id); onChange(data.filter((row) => row.id !== item.id)); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "無法刪除課程。"); } };
  return <><PageHeading title="課程" description="在建立課程單元前，先整理可重複使用的課程。" /><div className="split-layout"><form className="form-card" onSubmit={submit}><h3>{editing ? "編輯課程" : "新增課程"}</h3><Field label="課程名稱" value={name} onChange={setName} placeholder="例如：幾何" /><label className="field"><span>說明 <em>選填</em></span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="寫下教學計畫的簡短備註" rows={4} /></label><div className="form-actions"><button className="button primary" disabled={saving} type="submit">{saving ? "儲存中…" : editing ? "儲存變更" : "建立課程"}</button>{editing && <button className="button ghost" onClick={reset} type="button">取消</button>}</div></form><section className="list-card"><div className="list-card-header"><h3>我的課程</h3><span>{data.length}</span></div>{data.length === 0 ? <EmptyState text="尚未建立課程。請建立第一門課程。" /> : <ul className="entity-list">{data.map((item) => <li key={item.id}><div><strong>{item.name}</strong><small>{item.description || "未填寫說明"}</small></div><div className="row-actions"><button className="text-button" onClick={() => { setEditing(item); setName(item.name); setDescription(item.description ?? ""); }} type="button">編輯</button><button className="text-button danger" onClick={() => void remove(item)} type="button">刪除</button></div></li>)}</ul>}</section></div></>;
}

function Lessons({ api, courses, onError }: { api: TeacherApi; courses: Course[]; onError: (message: string) => void }) {
  const [courseId, setCourseId] = useState(courses[0]?.id ?? ""); const [data, setData] = useState<Lesson[]>([]); const [editing, setEditing] = useState<Lesson | null>(null); const [title, setTitle] = useState(""); const [description, setDescription] = useState(""); const [position, setPosition] = useState("0"); const [saving, setSaving] = useState(false);
  useEffect(() => { if (courseId) void api.listLessons(courseId).then(setData).catch((cause) => onError(cause instanceof TeacherApiError ? cause.message : "無法載入課程單元。")); }, [courseId]);
  const reset = () => { setEditing(null); setTitle(""); setDescription(""); setPosition(String(data.length)); };
  const submit = async (event: React.FormEvent) => { event.preventDefault(); const numeric = Number(position); if (!title.trim()) return onError("請輸入課程單元標題。"); if (!Number.isInteger(numeric) || numeric < 0) return onError("排序位置必須為零或正整數。"); setSaving(true); try { const item = editing ? await api.updateLesson(editing.id, { title, description: description || null, position: numeric }) : await api.createLesson({ course_id: courseId, title, description: description || null, position: numeric }); setData((editing ? data.map((row) => row.id === item.id ? item : row) : [...data, item]).sort((a, b) => a.position - b.position)); reset(); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "無法儲存課程單元。"); } finally { setSaving(false); } };
  const remove = async (item: Lesson) => { if (!window.confirm(`確定要刪除「${item.title}」嗎？`)) return; try { await api.deleteLesson(item.id); setData(data.filter((row) => row.id !== item.id)); } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "無法刪除課程單元。"); } };
  return <><PageHeading title="課程單元" description="為每門課程建立簡潔、有順序的課程大綱。" /><label className="select-label" htmlFor="lesson-course">課程<select id="lesson-course" value={courseId} onChange={(event) => { setCourseId(event.target.value); reset(); }}><option value="">請選擇課程</option>{courses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{courseId && <div className="split-layout"><form className="form-card" onSubmit={submit}><h3>{editing ? "編輯課程單元" : "新增課程單元"}</h3><Field label="課程單元標題" value={title} onChange={setTitle} placeholder="例如：三角形性質" /><Field label="排序位置" value={position} onChange={setPosition} type="number" /><label className="field"><span>說明 <em>選填</em></span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} /></label><div className="form-actions"><button className="button primary" disabled={saving} type="submit">{saving ? "儲存中…" : editing ? "儲存變更" : "建立課程單元"}</button>{editing && <button className="button ghost" onClick={reset} type="button">取消</button>}</div></form><section className="list-card"><div className="list-card-header"><h3>課程大綱</h3><span>{data.length}</span></div>{data.length === 0 ? <EmptyState text="尚未建立課程單元。請新增第一個課程單元。" /> : <ul className="entity-list">{data.map((item) => <li key={item.id}><div className="seat"><b>{item.position + 1}</b><div><strong>{item.title}</strong><small>{item.description || "未填寫說明"}</small></div></div><div className="row-actions"><button className="text-button" onClick={() => { setEditing(item); setTitle(item.title); setDescription(item.description ?? ""); setPosition(String(item.position)); }} type="button">編輯</button><button className="text-button danger" onClick={() => void remove(item)} type="button">刪除</button></div></li>)}</ul>}</section></div>}</>;
}

function PageHeading({ title, description }: { title: string; description: string }) { return <div className="page-heading compact"><div><p className="eyebrow">教師工作區</p><h2>{title}</h2><p className="intro">{description}</p></div></div>; }
function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) { return <label className="field"><span>{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>; }
function EmptyState({ text }: { text: string }) { return <div className="empty-state"><span>✦</span><p>{text}</p></div>; }
