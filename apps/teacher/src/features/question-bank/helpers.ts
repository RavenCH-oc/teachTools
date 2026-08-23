import type { CreateQuestionInput, Question, QuestionAsset, QuestionDraft, QuestionPublicView, QuestionSet, QuestionType } from "@classtools/domain";
import { questionDraftSchema } from "@classtools/validation";
import { newStableId } from "./ids";

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  true_false: "是非題",
  single_choice: "單選題",
  multiple_choice: "複選題",
  fill_blank: "填空題",
  essay: "申論題",
};

export function defaultConfig(type: QuestionType): QuestionDraft["answerConfig"] {
  switch (type) {
    case "true_false": return { correctAnswer: true };
    case "single_choice": { const first = newStableId("option"); return { options: [{ id: first, text: "" }, { id: newStableId("option"), text: "" }], correctOptionId: first }; }
    case "multiple_choice": return { options: [{ id: newStableId("option"), text: "" }, { id: newStableId("option"), text: "" }], correctOptionIds: [] };
    case "fill_blank": return { blanks: [{ id: newStableId("blank"), acceptedAnswers: [""] }], normalization: { trim: true, unicodeNormalization: "NFKC", caseSensitive: false } };
    case "essay": return {};
  }
}

export function newDraft(questionSetId: string, type: QuestionType, position: number): QuestionDraft {
  return { questionSetId, type, prompt: "", points: 1, position, metadata: {}, configVersion: 1, answerConfig: defaultConfig(type) } as QuestionDraft;
}

export function questionToDraft(question: Question): QuestionDraft {
  const draft = { ...question } as Partial<Question>;
  delete draft.id; delete draft.createdAt; delete draft.updatedAt;
  return draft as QuestionDraft;
}

export type QuestionPreviewModel = QuestionPublicView & { options?: Array<{ id: string; text: string }>; blankCount?: number };
export function questionToPublicView(question: Question, assets: QuestionAsset[] = []): QuestionPreviewModel {
  const { answerConfig, ...publicQuestion } = question;
  const publicAssets = assets.map(({ id, assetType, displayName, mimeType, sizeBytes, position, pageReference }) => ({ id, assetType, displayName, mimeType, sizeBytes, position, pageReference }));
  if (question.type === "single_choice" || question.type === "multiple_choice") return { ...publicQuestion, assets: publicAssets, options: (answerConfig as Extract<Question["answerConfig"], { options: unknown[] }>).options };
  if (question.type === "fill_blank") return { ...publicQuestion, assets: publicAssets, blankCount: (answerConfig as Extract<Question["answerConfig"], { blanks: unknown[] }>).blanks.length };
  return { ...publicQuestion, assets: publicAssets };
}

export function validateDraft(draft: QuestionDraft): string[] {
  const result = questionDraftSchema.safeParse(draft);
  if (result.success) return [];
  return result.error.issues.map((issue) => `${issue.path.join(".") || "題目"}: ${issue.message}`);
}

/** Keep schema paths available to tests/logging, but never expose them as the primary UI error. */
export function questionValidationMessage(draft: QuestionDraft, validationError: string): string {
  if (draft.type === "fill_blank" && validationError.includes("acceptedAnswers")) {
    return validationError.includes("unique after normalization")
      ? "每個填空的可接受答案不可重複。"
      : "每個填空至少需要一個可接受答案。";
  }
  if (validationError.includes("prompt")) return "請輸入題目內容。";
  if (validationError.includes("points")) return "分數必須是正整數。";
  if (validationError.includes("options")) return "請檢查選項與正確答案設定。";
  return "題目資料無效，請檢查欄位後再試。";
}

export function asCreateInput(draft: QuestionDraft): CreateQuestionInput {
  return draft;
}

export function displaySet(set: QuestionSet, lessonName?: string): string {
  return `${set.title}${lessonName ? ` · ${lessonName}` : " · 不綁定課程單元"}`;
}
