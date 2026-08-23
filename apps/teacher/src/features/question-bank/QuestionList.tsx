import type { Question, QuestionSet } from "@classtools/domain";
import type { TeacherApi } from "../../types/teacher";
import { QUESTION_TYPE_LABELS } from "./helpers";

interface Props { api: TeacherApi; set: QuestionSet; questions: Question[]; selectedId: string | null; onSelect: (id: string) => void; onChange: (questions: Question[]) => void; onNew: () => void; onDelete: (question: Question) => void; onError: (message: string) => void }
export function QuestionList({ api, set, questions, selectedId, onSelect, onChange, onNew, onDelete, onError }: Props) {
  const move = async (index: number, direction: -1 | 1) => {
    const target = index + direction; if (target < 0 || target >= questions.length) return;
    const ordered = [...questions]; const first = ordered[index]; const second = ordered[target]; if (!first || !second) return; ordered[index] = second; ordered[target] = first;
    try { const saved = await api.reorderQuestions(set.id, ordered.map((question) => question.id)); onChange(saved); }
    catch { onError("無法儲存題目順序。"); }
  };
  return <section className="question-list-panel" aria-label="所選題組的題目"><div className="list-card-header"><div><h3>{set.title}</h3><small>{questions.length} 題</small></div><button className="button primary compact-button" onClick={onNew} type="button">＋ 新增題目</button></div>{questions.length === 0 ? <div className="empty-state"><span>＋</span><p>尚無題目。</p><button className="button ghost" onClick={onNew} type="button">建立第一題</button></div> : <ol className="question-list">{questions.map((question, index) => <li className={selectedId === question.id ? "selected" : ""} key={question.id}><button className="question-select" onClick={() => onSelect(question.id)} type="button"><span className="position-badge">{index + 1}</span><span><strong>{QUESTION_TYPE_LABELS[question.type]}</strong><small>{question.prompt || "未命名題目"}</small></span><b>{question.points} 分</b></button><div className="question-row-actions"><button aria-label={`將第 ${index + 1} 題上移`} disabled={index === 0} onClick={() => void move(index, -1)} type="button">↑</button><button aria-label={`將第 ${index + 1} 題下移`} disabled={index === questions.length - 1} onClick={() => void move(index, 1)} type="button">↓</button><button aria-label={`刪除第 ${index + 1} 題`} className="danger-icon" onClick={() => onDelete(question)} type="button">×</button></div></li>)}</ol>}</section>;
}
