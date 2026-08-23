import { useEffect, useMemo, useState } from "react";
import type {
  FillBlankQuestion,
  MultipleChoiceQuestion,
  Question,
  QuestionAsset,
  QuestionDraft,
  QuestionType,
  SingleChoiceQuestion,
  TrueFalseQuestion,
} from "@classtools/domain";
import type { DraftQuestionAsset, TeacherApi } from "../../../types/teacher";
import { QuestionPreview, AnswerSummary } from "../QuestionPreview";
import {
  asCreateInput,
  defaultConfig,
  newDraft,
  QUESTION_TYPE_LABELS,
  questionToDraft,
  questionValidationMessage,
  validateDraft,
} from "../helpers";
import { ChoiceEditor } from "./ChoiceEditor";
import { FillBlankEditor } from "./FillBlankEditor";
import { DraftQuestionAssetEditor, QuestionAssetEditor } from "./QuestionAssetEditor";
import { TrueFalseEditor } from "./TrueFalseEditor";

interface Props {
  api: TeacherApi;
  questionSetId: string;
  question: Question | null;
  position: number;
  onSaved: (question: Question) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}

type EditorTrueFalse = Omit<TrueFalseQuestion, "id" | "createdAt" | "updatedAt">;
type EditorSingleChoice = Omit<SingleChoiceQuestion, "id" | "createdAt" | "updatedAt">;
type EditorMultipleChoice = Omit<MultipleChoiceQuestion, "id" | "createdAt" | "updatedAt">;
type EditorFillBlank = Omit<FillBlankQuestion, "id" | "createdAt" | "updatedAt">;

export function QuestionEditor({ api, questionSetId, question, position, onSaved, onCancel, onError }: Props) {
  const initialDraft = question ? questionToDraft(question) : newDraft(questionSetId, "true_false", position);
  const [draft, setDraft] = useState<QuestionDraft>(initialDraft);
  const [baseline, setBaseline] = useState(() => JSON.stringify(initialDraft));
  const [saving, setSaving] = useState(false);
  const [assets, setAssets] = useState<QuestionAsset[]>([]);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftAssets, setDraftAssets] = useState<DraftQuestionAsset[]>([]);

  useEffect(() => {
    const next = question ? questionToDraft(question) : newDraft(questionSetId, "true_false", position);
    setDraft(next);
    setBaseline(JSON.stringify(next));
  }, [question?.id, questionSetId, position]);

  useEffect(() => {
    let active = true;
    if (!question) {
      setAssets([]);
      return () => { active = false; };
    }
    void api.listQuestionAssets(question.id)
      .then((next) => { if (active) setAssets(next); })
      .catch(() => { if (active) onError("無法載入題目附件。"); });
    return () => { active = false; };
  }, [api, question?.id]);

  useEffect(() => {
    let active = true;
    if (question) {
      setDraftId(null);
      setDraftAssets([]);
      return () => { active = false; };
    }
    setDraftId(null);
    setDraftAssets([]);
    void api.createQuestionDraft()
      .then((next) => { if (active) setDraftId(next.id); })
      .catch(() => { if (active) onError("無法準備題目草稿。請關閉後再試。"); });
    return () => { active = false; };
  }, [api, question?.id]);

  const dirty = useMemo(() => JSON.stringify(draft) !== baseline, [draft, baseline]);
  const update = (patch: Partial<QuestionDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const changeType = (type: QuestionType) => {
    if (type === draft.type) return;
    if (!window.confirm("變更題型會重設該題型的作答設定。要繼續嗎？")) return;
    setDraft({ ...draft, type, answerConfig: defaultConfig(type) } as QuestionDraft);
  };
  const cancel = async () => {
    if ((dirty || draftAssets.length > 0) && !window.confirm("要放棄尚未儲存的題目與附件嗎？")) return;
    if (!question && draftId) {
      setSaving(true);
      try {
        await api.discardQuestionDraft(draftId);
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : "無法清除題目草稿附件。");
        return;
      } finally {
        setSaving(false);
      }
    }
    onCancel();
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const errors = validateDraft(draft);
    if (errors.length) return onError(questionValidationMessage(draft, errors[0] ?? ""));
    setSaving(true);
    try {
      const input = asCreateInput(draft);
      const saved = question
        ? await api.updateQuestion(question.id, input)
        : draftId
          ? await api.createQuestionWithDraftAssets(input, draftId)
          : (() => { throw new Error("draft is not ready"); })();
      onSaved(saved);
    } catch {
      onError("無法儲存題目，請檢查欄位後再試。");
    } finally {
      setSaving(false);
    }
  };

  const trueFalse = draft as EditorTrueFalse;
  const singleChoice = draft as EditorSingleChoice;
  const multipleChoice = draft as EditorMultipleChoice;
  const fillBlank = draft as EditorFillBlank;

  return <div className="editor-column">
    <form className="form-card question-editor" onSubmit={save}>
      <div className="editor-title-row"><div><p className="eyebrow">{question ? "編輯題目" : "新增題目"}</p><h3>{question ? "題目詳細資料" : "建立題目"}</h3></div>{dirty && <span className="dirty-pill">尚未儲存</span>}</div>
      <label className="field"><span>題型</span><select aria-label="題型" value={draft.type} onChange={(event) => changeType(event.target.value as QuestionType)}>{Object.entries(QUESTION_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="field"><span>題目內容</span><textarea aria-label="題目內容" value={draft.prompt} onChange={(event) => update({ prompt: event.target.value })} maxLength={10000} placeholder="輸入題目內容" rows={4} /></label>
      <label className="field points-field"><span>分數</span><input min={1} step={1} type="number" value={draft.points} onChange={(event) => update({ points: Number(event.target.value) })} /></label>
      {draft.type === "true_false" && <TrueFalseEditor value={trueFalse.answerConfig.correctAnswer} onChange={(value) => update({ answerConfig: { correctAnswer: value } })} />}
      {draft.type === "single_choice" && <ChoiceEditor multiple={false} options={singleChoice.answerConfig.options} correctOptionId={singleChoice.answerConfig.correctOptionId} onChange={(options, correct) => update({ answerConfig: { options, correctOptionId: correct as string } })} />}
      {draft.type === "multiple_choice" && <ChoiceEditor multiple options={multipleChoice.answerConfig.options} correctOptionIds={multipleChoice.answerConfig.correctOptionIds} onChange={(options, correct) => update({ answerConfig: { options, correctOptionIds: correct as string[] } })} />}
      {draft.type === "fill_blank" && <FillBlankEditor blanks={fillBlank.answerConfig.blanks} onChange={(blanks) => update({ answerConfig: { ...fillBlank.answerConfig, blanks } })} />}
      {draft.type === "essay" && <p className="editor-note">申論題沒有正確答案欄位，將保持待評閱狀態。</p>}
      {question ? <QuestionAssetEditor api={api} assets={assets} onChange={setAssets} onError={onError} questionId={question.id} /> : <DraftQuestionAssetEditor api={api} assets={draftAssets} draftId={draftId} onChange={setDraftAssets} onError={onError} />}
      <div className="form-actions"><button className="button primary" disabled={saving || (!question && !draftId)} type="submit">{saving ? "儲存中…" : question ? "儲存變更" : "建立題目"}</button><button className="button ghost" disabled={saving} onClick={() => void cancel()} type="button">取消</button></div>
    </form>
    {question && <><QuestionPreview assets={assets} question={question} /><AnswerSummary question={question} /></>}
  </div>;
}
