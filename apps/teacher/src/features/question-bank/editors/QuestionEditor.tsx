import { useEffect, useMemo, useState } from "react";
import type { FillBlankQuestion, MultipleChoiceQuestion, Question, QuestionDraft, QuestionType, SingleChoiceQuestion, TrueFalseQuestion } from "@classtools/domain";
import type { TeacherApi } from "../../../types/teacher";
import { QuestionPreview, AnswerSummary } from "../QuestionPreview";
import { asCreateInput, defaultConfig, newDraft, QUESTION_TYPE_LABELS, questionToDraft, validateDraft } from "../helpers";
import { ChoiceEditor } from "./ChoiceEditor";
import { FillBlankEditor } from "./FillBlankEditor";
import { TrueFalseEditor } from "./TrueFalseEditor";

interface Props { api: TeacherApi; questionSetId: string; question: Question | null; position: number; onSaved: (question: Question) => void; onCancel: () => void; onError: (message: string) => void }
type EditorTrueFalse = Omit<TrueFalseQuestion, "id" | "createdAt" | "updatedAt">;
type EditorSingleChoice = Omit<SingleChoiceQuestion, "id" | "createdAt" | "updatedAt">;
type EditorMultipleChoice = Omit<MultipleChoiceQuestion, "id" | "createdAt" | "updatedAt">;
type EditorFillBlank = Omit<FillBlankQuestion, "id" | "createdAt" | "updatedAt">;
export function QuestionEditor({ api, questionSetId, question, position, onSaved, onCancel, onError }: Props) {
  const initialDraft = question ? questionToDraft(question) : newDraft(questionSetId, "true_false", position);
  const [draft, setDraft] = useState<QuestionDraft>(initialDraft);
  const [baseline, setBaseline] = useState(() => JSON.stringify(initialDraft));
  const [saving, setSaving] = useState(false);
  useEffect(() => { const next = question ? questionToDraft(question) : newDraft(questionSetId, "true_false", position); setDraft(next); setBaseline(JSON.stringify(next)); }, [question?.id, questionSetId, position]);
  const dirty = useMemo(() => JSON.stringify(draft) !== baseline, [draft, baseline]);
  const update = (patch: Partial<QuestionDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const changeType = (type: QuestionType) => {
    if (type === draft.type) return;
    if (!window.confirm("Changing the question type resets its type-specific answer settings. Continue?")) return;
    setDraft({ ...draft, type, answerConfig: defaultConfig(type) } as QuestionDraft);
  };
  const cancel = () => { if (dirty && !window.confirm("Discard unsaved changes?")) return; onCancel(); };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); const errors = validateDraft(draft); if (errors.length) return onError(errors[0] ?? "Question is invalid."); setSaving(true);
    try { const saved = question ? await api.updateQuestion(question.id, asCreateInput(draft)) : await api.createQuestion(asCreateInput(draft)); onSaved(saved); }
    catch { onError("The Question could not be saved. Please review the fields and try again."); }
    finally { setSaving(false); }
  };
  const trueFalse = draft as EditorTrueFalse;
  const singleChoice = draft as EditorSingleChoice;
  const multipleChoice = draft as EditorMultipleChoice;
  const fillBlank = draft as EditorFillBlank;
  return <div className="editor-column"><form className="form-card question-editor" onSubmit={save}><div className="editor-title-row"><div><p className="eyebrow">{question ? "Edit question" : "New question"}</p><h3>{question ? "Question details" : "Create a question"}</h3></div>{dirty && <span className="dirty-pill">Unsaved</span>}</div><label className="field"><span>Question type</span><select value={draft.type} onChange={(event) => changeType(event.target.value as QuestionType)}>{Object.entries(QUESTION_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field"><span>Prompt</span><textarea aria-label="Question prompt" value={draft.prompt} onChange={(event) => update({ prompt: event.target.value })} maxLength={10000} placeholder="Write the question prompt" rows={4} /></label><label className="field points-field"><span>Points</span><input min={1} step={1} type="number" value={draft.points} onChange={(event) => update({ points: Number(event.target.value) })} /></label>{draft.type === "true_false" && <TrueFalseEditor value={trueFalse.answerConfig.correctAnswer} onChange={(value) => update({ answerConfig: { correctAnswer: value } })} />}{draft.type === "single_choice" && <ChoiceEditor multiple={false} options={singleChoice.answerConfig.options} correctOptionId={singleChoice.answerConfig.correctOptionId} onChange={(options, correct) => update({ answerConfig: { options, correctOptionId: correct as string } })} />}{draft.type === "multiple_choice" && <ChoiceEditor multiple options={multipleChoice.answerConfig.options} correctOptionIds={multipleChoice.answerConfig.correctOptionIds} onChange={(options, correct) => update({ answerConfig: { options, correctOptionIds: correct as string[] } })} />}{draft.type === "fill_blank" && <FillBlankEditor blanks={fillBlank.answerConfig.blanks} onChange={(blanks) => update({ answerConfig: { ...fillBlank.answerConfig, blanks } })} />}{draft.type === "essay" && <p className="editor-note">Essay questions have no correct-answer field. Grading remains pending for future review workflows.</p>}<div className="form-actions"><button className="button primary" disabled={saving} type="submit">{saving ? "Saving…" : question ? "Save changes" : "Create question"}</button><button className="button ghost" onClick={cancel} type="button">Cancel</button></div></form>{question && <><QuestionPreview question={question} /><AnswerSummary question={question} /></>}</div>;
}
