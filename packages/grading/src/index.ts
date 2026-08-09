import type { FillBlankQuestion, Question, StudentAnswer } from "@classtools/domain";

export const GRADING_PACKAGE_VERSION = 2 as const;
export interface GradePart { id: string; correct: boolean }
export type GradeResult =
  | { status: "graded"; correct: boolean; score: number; maxScore: number; parts?: GradePart[] }
  | { status: "pending"; score: null; maxScore: number };
export type GradingErrorCode = "invalid_answer" | "invalid_question_configuration" | "unsupported_question_version";
export class GradingError extends Error {
  readonly code: GradingErrorCode;
  constructor(code: GradingErrorCode, message: string) { super(message); this.name = "GradingError"; this.code = code; }
}
const invalidAnswer = (message: string): never => { throw new GradingError("invalid_answer", message); };

export function normalizeAnswer(value: string, config: FillBlankQuestion["answerConfig"]["normalization"]): string {
  const normalized = config.unicodeNormalization === "NFKC" ? value.normalize("NFKC") : value;
  const trimmed = config.trim ? normalized.trim() : normalized;
  return config.caseSensitive ? trimmed : trimmed.toLocaleLowerCase();
}
function ensurePoints(question: Question): number {
  if (question.configVersion !== 1 || !Number.isInteger(question.points) || !Number.isFinite(question.points) || question.points <= 0) throw new GradingError(question.configVersion !== 1 ? "unsupported_question_version" : "invalid_question_configuration", "Question points or config version is invalid");
  return question.points;
}
export function gradeQuestion(question: Question, answer: StudentAnswer): GradeResult {
  const maxScore = ensurePoints(question);
  if (question.type !== answer.type) invalidAnswer("Answer type does not match the question type");
  switch (question.type) {
    case "true_false": {
      const typed = answer as Extract<StudentAnswer, { type: "true_false" }>;
      if (typeof typed.value !== "boolean") invalidAnswer("True/false answer must be boolean");
      const correct = typed.value === question.answerConfig.correctAnswer;
      return { status: "graded", correct, score: correct ? maxScore : 0, maxScore };
    }
    case "single_choice": {
      const typed = answer as Extract<StudentAnswer, { type: "single_choice" }>;
      const ids = new Set(question.answerConfig.options.map((option) => option.id));
      if (!ids.has(typed.optionId)) invalidAnswer("Unknown choice option");
      const correct = typed.optionId === question.answerConfig.correctOptionId;
      return { status: "graded", correct, score: correct ? maxScore : 0, maxScore };
    }
    case "multiple_choice": {
      const typed = answer as Extract<StudentAnswer, { type: "multiple_choice" }>;
      const ids = new Set(question.answerConfig.options.map((option) => option.id));
      if (new Set(typed.optionIds).size !== typed.optionIds.length || typed.optionIds.some((id) => !ids.has(id))) invalidAnswer("Multiple-choice answer contains invalid option IDs");
      const expected = new Set(question.answerConfig.correctOptionIds);
      const correct = expected.size === typed.optionIds.length && typed.optionIds.every((id) => expected.has(id));
      return { status: "graded", correct, score: correct ? maxScore : 0, maxScore };
    }
    case "fill_blank": return gradeFillBlank(question, (answer as Extract<StudentAnswer, { type: "fill_blank" }>).values, maxScore);
    case "essay":
      if (typeof (answer as Extract<StudentAnswer, { type: "essay" }>).text !== "string") invalidAnswer("Essay answer must be text");
      return { status: "pending", score: null, maxScore };
  }
}
function gradeFillBlank(question: FillBlankQuestion, values: Record<string, string>, maxScore: number): GradeResult {
  const blanks = question.answerConfig.blanks;
  const known = new Set(blanks.map((blank) => blank.id));
  if (Object.keys(values).some((id) => !known.has(id))) invalidAnswer("Unknown fill-blank ID");
  const parts = blanks.map((blank) => {
    const value = values[blank.id];
    const accepted = blank.acceptedAnswers.map((answer) => normalizeAnswer(answer, question.answerConfig.normalization));
    const correct = value !== undefined && accepted.includes(normalizeAnswer(value, question.answerConfig.normalization));
    return { id: blank.id, correct };
  });
  const correct = parts.every((part) => part.correct);
  return { status: "graded", correct, score: correct ? maxScore : 0, maxScore, parts };
}
