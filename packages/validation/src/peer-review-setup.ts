import { z } from "zod";

// Teacher IPC only. No Student protocol, answers, response content or identities.
const id = z.string().min(1);
const count = z.number().int().nonnegative().safe();
export const peerReviewModeSchema = z.enum(["RANDOM_ONE_TO_ONE", "STUDENT_SELECT", "CROSS_GROUP"]);
export const peerReviewDraftSchema = z.object({
  session_id: id, session_question_id: id, mode: peerReviewModeSchema,
  max_reviews_per_target: z.number().int().positive().safe().nullable(),
  session_group_set_id: id.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.mode !== "STUDENT_SELECT" && value.max_reviews_per_target !== null) ctx.addIssue({code: "custom", message: "Capacity only applies to student selection"});
  if ((value.mode === "CROSS_GROUP") !== (value.session_group_set_id !== null)) ctx.addIssue({code: "custom", message: "Group set required only for cross-group mode"});
});
export const peerReviewActivitySchema = z.object({
  id, session_question_id: id, mode: peerReviewModeSchema,
  state: z.enum(["DRAFT", "OPEN", "CLOSED", "CANCELLED"]),
  max_reviews_per_target: z.number().int().positive().safe().nullable(), session_group_set_id: id.nullable(),
  created_at: z.string(), opened_at: z.string().nullable(), closed_at: z.string().nullable(), frozen_target_count: count,
}).strict();
export const peerReviewSetupSchema = z.object({
  session_id: id, session_state: z.enum(["CREATED", "LOBBY", "ACTIVE", "ENDED"]), classroom_name: z.string(),
  questions: z.array(z.object({ id, position: count, prompt_summary: z.string(), state: z.enum(["HIDDEN", "OPEN", "LOCKED", "REVEALED"]), eligible_participant_count: count }).strict()),
  activities: z.array(peerReviewActivitySchema),
  group_sets: z.array(z.object({id, revision: z.number().int().positive(), created_at: z.string(), questions: z.array(z.object({session_question_id: id, eligible_group_count: count, groups: z.array(z.object({name: z.string(), essay_count: count}).strict())}).strict())}).strict()),
}).strict();
export type PeerReviewMode = z.infer<typeof peerReviewModeSchema>;
export type PeerReviewDraft = z.infer<typeof peerReviewDraftSchema>;
export type PeerReviewSetup = z.infer<typeof peerReviewSetupSchema>;
export type PeerReviewActivity = z.infer<typeof peerReviewActivitySchema>;
