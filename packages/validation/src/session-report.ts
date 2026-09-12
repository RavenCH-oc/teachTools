import { z } from "zod";

export const exportSectionSchema = z.enum(["SESSION_SUMMARY", "QUESTION_STATISTICS", "STUDENT_STATISTICS"]);
export type ExportSection = z.infer<typeof exportSectionSchema>;
export const exportRequestSchema = z.object({
  sessionId: z.string().uuid(),
  sections: z.array(exportSectionSchema).min(1).max(3).refine((items) => new Set(items).size === items.length),
  outputPath: z.string().min(1),
}).strict();
export const exportResultSchema = z.object({ filename: z.string().min(1) }).strict();
export type ExportRequest = z.infer<typeof exportRequestSchema>;
export type ExportResult = z.infer<typeof exportResultSchema>;
