import { useEffect, useMemo, useState } from "react";
import type { Question, QuestionSet } from "@classtools/domain";
import type { Course, Lesson, TeacherApi } from "../../types/teacher";
import { TeacherApiError } from "../../services/teacherApi";
import { QuestionSetList } from "./QuestionSetList";
import { QuestionList } from "./QuestionList";
import { QuestionEditor } from "./editors/QuestionEditor";

export function QuestionBankPage({ api, onError, onDraftStateChange }: { api: TeacherApi; onError: (message: string) => void; onDraftStateChange?: (active: boolean) => void }) {
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
    } catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "無法載入題庫。"); }
    finally { setLoading(false); }
  };
  const loadQuestions = async (setId: string | null) => {
    if (!setId) { setQuestions([]); setSelectedQuestionId(null); return; }
    setQuestionsLoading(true);
    try { const next = await api.listQuestions(setId); setQuestions(next); setSelectedQuestionId((current) => current && next.some((question) => question.id === current) ? current : next[0]?.id ?? null); }
    catch (cause) { onError(cause instanceof TeacherApiError ? cause.message : "無法載入題目。"); }
    finally { setQuestionsLoading(false); }
  };
  useEffect(() => { void loadSets(); }, []);
  useEffect(() => { void loadQuestions(selectedSetId); setCreating(false); }, [selectedSetId]);
  useEffect(() => { onDraftStateChange?.(creating); }, [creating, onDraftStateChange]);
  useEffect(() => () => { onDraftStateChange?.(false); }, [onDraftStateChange]);
  const requireDraftResolution = () => {
    if (!creating) return false;
    onError("請先建立或取消目前的題目草稿，再切換題目或離開題庫。");
    return true;
  };
  const selectSet = (id: string) => {
    if (requireDraftResolution()) return;
    setSelectedSetId(id || null); setSelectedQuestionId(null); setCreating(false);
  };
  const saveSetList = (next: QuestionSet[]) => { setSets(next); };
  const removeQuestion = async (question: Question) => {
    if (!window.confirm("確定要刪除這個題目嗎？此操作無法復原。")) return;
    try { await api.deleteQuestion(question.id); const next = questions.filter((row) => row.id !== question.id); setQuestions(next); setSelectedQuestionId(next[0]?.id ?? null); }
    catch { onError("無法刪除題目。"); }
  };
  const saveQuestion = (question: Question) => { setQuestions((current) => current.some((row) => row.id === question.id) ? current.map((row) => row.id === question.id ? question : row) : [...current, question].sort((a, b) => a.position - b.position)); setSelectedQuestionId(question.id); setCreating(false); };
  if (loading) return <div className="state-card"><span className="spinner" />正在載入題庫…</div>;
  return <><div className="page-heading compact"><div><p className="eyebrow">教師工作區 / 題庫</p><h2>建立與管理題組</h2><p className="intro">在本機建立、驗證、預覽與排序題目。</p></div></div><div className="question-bank-layout"><QuestionSetList api={api} sets={sets} selectedId={selectedSetId} courses={courses} lessons={lessons} onSelect={selectSet} onChange={saveSetList} onError={onError} />{selectedSet ? <>{questionsLoading ? <section className="question-list-panel state-card"><span className="spinner" />正在載入題目…</section> : <QuestionList api={api} set={selectedSet} questions={questions} selectedId={selectedQuestionId} onSelect={(id) => { if (requireDraftResolution()) return; setSelectedQuestionId(id); setCreating(false); }} onChange={setQuestions} onNew={() => { if (creating) return; setCreating(true); setSelectedQuestionId(null); }} onDelete={(question) => { if (!requireDraftResolution()) void removeQuestion(question); }} onError={onError} />}<div className="editor-column">{creating ? <QuestionEditor api={api} questionSetId={selectedSet.id} question={null} position={questions.length} onSaved={saveQuestion} onCancel={() => setCreating(false)} onError={onError} /> : selectedQuestion ? <QuestionEditor api={api} questionSetId={selectedSet.id} question={selectedQuestion} position={selectedQuestion.position} onSaved={saveQuestion} onCancel={() => setSelectedQuestionId(null)} onError={onError} /> : <div className="state-card editor-empty"><h3>選擇題目</h3><p>選擇題目進行編輯，或從清單新增題目。</p></div>}</div></> : <div className="state-card editor-empty"><h3>題庫已就緒</h3><p>先建立題組，即可開始編寫題目。</p></div>}</div></>;
}
