import type { CreateQuestionInput, Question, QuestionDraft, QuestionPublicView, QuestionSet, QuestionType } from "@classtools/domain";
import { questionDraftSchema } from "@classtools/validation";
import { newStableId } from "./ids";

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  true_false: "True / False",
  single_choice: "Single choice",
  multiple_choice: "Multiple choice",
  fill_blank: "Fill in the blank",
  essay: "Essay",
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
export function questionToPublicView(question: Question): QuestionPreviewModel {
  const { answerConfig, ...publicQuestion } = question;
  if (question.type === "single_choice" || question.type === "multiple_choice") return { ...publicQuestion, options: (answerConfig as Extract<Question["answerConfig"], { options: unknown[] }>).options };
  if (question.type === "fill_blank") return { ...publicQuestion, blankCount: (answerConfig as Extract<Question["answerConfig"], { blanks: unknown[] }>).blanks.length };
  return publicQuestion;
}

export function validateDraft(draft: QuestionDraft): string[] {
  const result = questionDraftSchema.safeParse(draft);
  if (result.success) return [];
  return result.error.issues.map((issue) => `${issue.path.join(".") || "Question"}: ${issue.message}`);
}

export function asCreateInput(draft: QuestionDraft): CreateQuestionInput {
  return draft;
}

export function displaySet(set: QuestionSet, lessonName?: string): string {
  return `${set.title}${lessonName ? ` · ${lessonName}` : " · Standalone"}`;
}
