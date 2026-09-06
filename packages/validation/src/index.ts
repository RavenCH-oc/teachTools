import { z } from "zod";
export * from "./peer-review-setup";

export const applicationIdentifierSchema = z.string().trim().min(1, "Application identifier must not be empty");
export const validateApplicationIdentifier = (value: string): string => applicationIdentifierSchema.parse(value);

const nonEmptyId = z.string().trim().min(1).max(120);
const metadataSchema = z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 32_768, "Metadata is too large");
export const choiceOptionSchema = z.object({ id: nonEmptyId, text: z.string().trim().min(1).max(500) });
const unique = (values: string[]): boolean => new Set(values).size === values.length;
const optionListSchema = z.array(choiceOptionSchema).min(2).max(100).refine((options) => unique(options.map((option) => option.id)), "Option IDs must be unique");

export const normalizationSchema = z.object({ trim: z.boolean(), unicodeNormalization: z.literal("NFKC"), caseSensitive: z.boolean() });
export const trueFalseAnswerConfigSchema = z.object({ correctAnswer: z.boolean() }).strict();
export const singleChoiceAnswerConfigSchema = z.object({ options: optionListSchema, correctOptionId: nonEmptyId }).superRefine((config, context) => {
  if (!config.options.some((option) => option.id === config.correctOptionId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["correctOptionId"], message: "Correct option must exist" });
});
export const multipleChoiceAnswerConfigSchema = z.object({ options: optionListSchema, correctOptionIds: z.array(nonEmptyId).min(1) }).superRefine((config, context) => {
  if (!unique(config.correctOptionIds)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["correctOptionIds"], message: "Correct option IDs must be unique" });
  const optionIds = new Set(config.options.map((option) => option.id));
  if (config.correctOptionIds.some((id) => !optionIds.has(id))) context.addIssue({ code: z.ZodIssueCode.custom, path: ["correctOptionIds"], message: "Correct option must exist" });
});
export const fillBlankDefinitionSchema = z.object({ id: nonEmptyId, acceptedAnswers: z.array(z.string()).min(1) }).superRefine((blank, context) => {
  const normalized = blank.acceptedAnswers.map((answer) => answer.normalize("NFKC").trim().toLocaleLowerCase());
  if (normalized.some((answer) => answer.length === 0)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["acceptedAnswers"], message: "Accepted answers must not be empty" });
  if (!unique(normalized)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["acceptedAnswers"], message: "Accepted answers must be unique after normalization" });
});
export const fillBlankAnswerConfigSchema = z.object({ blanks: z.array(fillBlankDefinitionSchema).min(1), normalization: normalizationSchema }).superRefine((config, context) => {
  if (!unique(config.blanks.map((blank) => blank.id))) context.addIssue({ code: z.ZodIssueCode.custom, path: ["blanks"], message: "Blank IDs must be unique" });
});
export const essayAnswerConfigSchema = z.object({ rubricReference: z.string().trim().max(500).optional() }).strict();

const questionCommonSchema = { questionSetId: nonEmptyId, prompt: z.string().trim().min(1).max(10_000), points: z.number().finite().int().positive(), position: z.number().int().min(0), metadata: metadataSchema, configVersion: z.literal(1) };
export const questionDraftSchema = z.discriminatedUnion("type", [
  z.object({ ...questionCommonSchema, type: z.literal("true_false"), answerConfig: trueFalseAnswerConfigSchema }),
  z.object({ ...questionCommonSchema, type: z.literal("single_choice"), answerConfig: singleChoiceAnswerConfigSchema }),
  z.object({ ...questionCommonSchema, type: z.literal("multiple_choice"), answerConfig: multipleChoiceAnswerConfigSchema }),
  z.object({ ...questionCommonSchema, type: z.literal("fill_blank"), answerConfig: fillBlankAnswerConfigSchema }),
  z.object({ ...questionCommonSchema, type: z.literal("essay"), answerConfig: essayAnswerConfigSchema }),
]);
const questionIdentity = { id: nonEmptyId, createdAt: z.string().min(1), updatedAt: z.string().min(1) };
export const questionSchema = z.discriminatedUnion("type", [
  z.object({ ...questionIdentity, ...questionCommonSchema, type: z.literal("true_false"), answerConfig: trueFalseAnswerConfigSchema }),
  z.object({ ...questionIdentity, ...questionCommonSchema, type: z.literal("single_choice"), answerConfig: singleChoiceAnswerConfigSchema }),
  z.object({ ...questionIdentity, ...questionCommonSchema, type: z.literal("multiple_choice"), answerConfig: multipleChoiceAnswerConfigSchema }),
  z.object({ ...questionIdentity, ...questionCommonSchema, type: z.literal("fill_blank"), answerConfig: fillBlankAnswerConfigSchema }),
  z.object({ ...questionIdentity, ...questionCommonSchema, type: z.literal("essay"), answerConfig: essayAnswerConfigSchema }),
]);
export const createQuestionSetInputSchema = z.object({ lessonId: nonEmptyId.nullish(), title: z.string().trim().min(1).max(200), description: z.string().trim().max(2_000).nullish() });
export const questionSetSchema = createQuestionSetInputSchema.extend({ id: nonEmptyId, lessonId: nonEmptyId.nullable(), description: z.string().nullable(), createdAt: z.string().min(1), updatedAt: z.string().min(1) });
export const studentAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("true_false"), value: z.boolean() }),
  z.object({ type: z.literal("single_choice"), optionId: nonEmptyId }),
  z.object({ type: z.literal("multiple_choice"), optionIds: z.array(nonEmptyId) }),
  z.object({ type: z.literal("fill_blank"), values: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("essay"), text: z.string() }),
]);
export type QuestionDraftInput = z.infer<typeof questionDraftSchema>;
export type QuestionInput = z.infer<typeof questionSchema>;
