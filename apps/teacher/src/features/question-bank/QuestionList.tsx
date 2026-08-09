import type { Question, QuestionSet } from "@classtools/domain";
import type { TeacherApi } from "../../types/teacher";
import { QUESTION_TYPE_LABELS } from "./helpers";

interface Props { api: TeacherApi; set: QuestionSet; questions: Question[]; selectedId: string | null; onSelect: (id: string) => void; onChange: (questions: Question[]) => void; onNew: () => void; onDelete: (question: Question) => void; onError: (message: string) => void }
export function QuestionList({ api, set, questions, selectedId, onSelect, onChange, onNew, onDelete, onError }: Props) {
  const move = async (index: number, direction: -1 | 1) => {
    const target = index + direction; if (target < 0 || target >= questions.length) return;
    const ordered = [...questions]; const first = ordered[index]; const second = ordered[target]; if (!first || !second) return; ordered[index] = second; ordered[target] = first;
    try { const saved = await api.reorderQuestions(set.id, ordered.map((question) => question.id)); onChange(saved); }
    catch { onError("Could not save Question order."); }
  };
  return <section className="question-list-panel" aria-label="Questions in selected set"><div className="list-card-header"><div><h3>{set.title}</h3><small>{questions.length} question{questions.length === 1 ? "" : "s"}</small></div><button className="button primary compact-button" onClick={onNew} type="button">＋ New question</button></div>{questions.length === 0 ? <div className="empty-state"><span>＋</span><p>No questions yet.</p><button className="button ghost" onClick={onNew} type="button">Create the first question</button></div> : <ol className="question-list">{questions.map((question, index) => <li className={selectedId === question.id ? "selected" : ""} key={question.id}><button className="question-select" onClick={() => onSelect(question.id)} type="button"><span className="position-badge">{index + 1}</span><span><strong>{QUESTION_TYPE_LABELS[question.type]}</strong><small>{question.prompt || "Untitled question"}</small></span><b>{question.points} pt</b></button><div className="question-row-actions"><button aria-label={`Move ${index + 1} up`} disabled={index === 0} onClick={() => void move(index, -1)} type="button">↑</button><button aria-label={`Move ${index + 1} down`} disabled={index === questions.length - 1} onClick={() => void move(index, 1)} type="button">↓</button><button aria-label={`Delete question ${index + 1}`} className="danger-icon" onClick={() => onDelete(question)} type="button">×</button></div></li>)}</ol>}</section>;
}
