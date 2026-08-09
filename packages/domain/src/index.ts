export const DOMAIN_PACKAGE_VERSION = 2 as const;

export type QuestionType =
  | "true_false"
  | "single_choice"
  | "multiple_choice"
  | "fill_blank"
  | "essay";

export interface ChoiceOption { id: string; text: string }
export interface FillBlankDefinition { id: string; acceptedAnswers: string[] }
export interface FillBlankNormalization { trim: boolean; unicodeNormalization: "NFKC"; caseSensitive: boolean }

export interface QuestionBase {
  id: string; questionSetId: string; prompt: string; points: number; position: number;
  metadata: Record<string, unknown>; configVersion: 1; createdAt: string; updatedAt: string;
}
export interface TrueFalseQuestion extends QuestionBase { type: "true_false"; answerConfig: { correctAnswer: boolean } }
export interface SingleChoiceQuestion extends QuestionBase { type: "single_choice"; answerConfig: { options: ChoiceOption[]; correctOptionId: string } }
export interface MultipleChoiceQuestion extends QuestionBase { type: "multiple_choice"; answerConfig: { options: ChoiceOption[]; correctOptionIds: string[] } }
export interface FillBlankQuestion extends QuestionBase { type: "fill_blank"; answerConfig: { blanks: FillBlankDefinition[]; normalization: FillBlankNormalization } }
export interface EssayQuestion extends QuestionBase { type: "essay"; answerConfig: { rubricReference?: string } }
export type Question = TrueFalseQuestion | SingleChoiceQuestion | MultipleChoiceQuestion | FillBlankQuestion | EssayQuestion;
export type QuestionDraft = Omit<Question, "id" | "createdAt" | "updatedAt">;
export type CreateQuestionInput = QuestionDraft;
export type UpdateQuestionInput = QuestionDraft & { id: string };

export interface QuestionSet { id: string; lessonId: string | null; title: string; description: string | null; createdAt: string; updatedAt: string }
export interface CreateQuestionSetInput { lessonId?: string | null; title: string; description?: string | null }
export interface UpdateQuestionSetInput extends CreateQuestionSetInput { id: string }

export type QuestionAssetType = "image" | "pdf";
export type QuestionAssetStatus = "ready" | "missing";
export interface QuestionAsset {
  id: string; questionId: string; assetType: QuestionAssetType; displayName: string; mimeType: string;
  sizeBytes: number; position: number; pageReference: number | null; createdAt: string; status: QuestionAssetStatus;
}
export interface QuestionAssetPreview extends QuestionAsset { assetUrl: string }
export interface QuestionPublicAsset {
  id: string; assetType: QuestionAssetType; displayName: string; mimeType: string;
  sizeBytes: number; position: number; pageReference: number | null;
}

export interface TrueFalseAnswer { type: "true_false"; value: boolean }
export interface SingleChoiceAnswer { type: "single_choice"; optionId: string }
export interface MultipleChoiceAnswer { type: "multiple_choice"; optionIds: string[] }
export interface FillBlankAnswer { type: "fill_blank"; values: Record<string, string> }
export interface EssayAnswer { type: "essay"; text: string }
export type StudentAnswer = TrueFalseAnswer | SingleChoiceAnswer | MultipleChoiceAnswer | FillBlankAnswer | EssayAnswer;
export type QuestionPublicView = Omit<Question, "answerConfig"> & {
  type: QuestionType;
  assets: QuestionPublicAsset[];
};

export interface Student { id: string; displayName: string; seatNumber: number | null }
export interface Session { id: string; state: "CREATED" | "LOBBY" | "ACTIVE" | "PAUSED" | "ENDED" | "ARCHIVED" }
export interface Submission { submissionId: string; questionId: string; answer: StudentAnswer }
