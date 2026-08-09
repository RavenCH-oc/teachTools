import { useEffect, useMemo, useState } from "react";
import type { Question, QuestionSet } from "@classtools/domain";
import type { Course, Lesson, TeacherApi } from "../../types/teacher";
import { TeacherApiError } from "../../services/teacherApi";
import { QuestionSetList } from "./QuestionSetList";
import { QuestionList } from "./QuestionList";
import { QuestionEditor } from "./editors/QuestionEditor";

export function QuestionBankPage({ api, onError }: { api: TeacherApi; onError: (message: string) => void }) {
  const [sets, setSets] = useState<QuestionSet[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const selectedSet = useMemo(() => sets.find((set) => set.id === selectedSetId) ?? null, [sets, selectedSetId]);
  const selectedQuestion = useMemo(() => questions.find((question) => question.id === selectedQuestionId) ?? null, [questions, selectedQuestionId]);
  const loadSets = async () => {
    setLoading(true);
    try {
      const [nextSets, nextCourses] = await Promise.all([api.listQuestionSets(), api.listCourses()]);
      const nextLessons = await api.listAllLessons();
      setSets(nextSets); setCourses(nextCourses); setLessons(nextLessons);
      const nextId = selectedSetId && nextSets.some((set) => set.id === selectedSetId) ? selectedSetId : nextSets[0]?.id ?? null;
      setSelectedSetId(nextId);
    } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "Could not load Question Bank."); }
    finally { setLoading(false); }
  };
  const loadQuestions = async (setId: string | null) => {
    if (!setId) { setQuestions([]); setSelectedQuestionId(null); return; }
    setQuestionsLoading(true);
    try { const next = await api.listQuestions(setId); setQuestions(next); setSelectedQuestionId((current) => current && next.some((question) => question.id === current) ? current : next[0]?.id ?? null); }
    catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "Could not load questions."); }
    finally { setQuestionsLoading(false); }
  };
  useEffect(() => { void loadSets(); }, []);
  useEffect(() => { void loadQuestions(selectedSetId); setCreating(false); }, [selectedSetId]);
  const selectSet = (id: string) => { setSelectedSetId(id || null); setSelectedQuestionId(null); setCreating(false); };
  const saveSetList = (next: QuestionSet[]) => { setSets(next); };
  const removeQuestion = async (question: Question) => {
    if (!window.confirm("Delete this question? This cannot be undone.")) return;
    try { await api.deleteQuestion(question.id); const next = questions.filter((row) => row.id !== question.id); setQuestions(next); setSelectedQuestionId(next[0]?.id ?? null); }
    catch { onError("Could not delete question."); }
  };
  const saveQuestion = (question: Question) => { setQuestions((current) => current.some((row) => row.id === question.id) ? current.map((row) => row.id === question.id ? question : row) : [...current, question].sort((a, b) => a.position - b.position)); setSelectedQuestionId(question.id); setCreating(false); };
  if (loading) return <div className="state-card"><span className="spinner" />Loading Question Bank…</div>;
  return <><div className="page-heading compact"><div><p className="eyebrow">Teacher workspace / Question Bank</p><h2>Build question sets with confidence.</h2><p className="intro">Author, validate, preview, and order questions locally. Student answering stays out of this phase.</p></div></div><div className="question-bank-layout"><QuestionSetList api={api} sets={sets} selectedId={selectedSetId} courses={courses} lessons={lessons} onSelect={selectSet} onChange={saveSetList} onError={onError} />{selectedSet ? <>{questionsLoading ? <section className="question-list-panel state-card"><span className="spinner" />Loading questions…</section> : <QuestionList api={api} set={selectedSet} questions={questions} selectedId={selectedQuestionId} onSelect={(id) => { setSelectedQuestionId(id); setCreating(false); }} onChange={setQuestions} onNew={() => { setCreating(true); setSelectedQuestionId(null); }} onDelete={(question) => void removeQuestion(question)} onError={onError} />}<div className="editor-column">{creating ? <QuestionEditor api={api} questionSetId={selectedSet.id} question={null} position={questions.length} onSaved={saveQuestion} onCancel={() => setCreating(false)} onError={onError} /> : selectedQuestion ? <QuestionEditor api={api} questionSetId={selectedSet.id} question={selectedQuestion} position={selectedQuestion.position} onSaved={saveQuestion} onCancel={() => setSelectedQuestionId(null)} onError={onError} /> : <div className="state-card editor-empty"><h3>Select a question</h3><p>Choose a question to edit, or create a new one from the list.</p></div>}</div></> : <div className="state-card editor-empty"><h3>Your Question Bank is ready</h3><p>Create a Question Set to start authoring.</p></div>}</div></>;
}
