import { describe, expect, it } from "vitest";
import { createQuestionSetInputSchema, questionDraftSchema, studentAnswerSchema, validateApplicationIdentifier } from "./index";

describe("@classtools/validation", () => {
  it("accepts a non-empty application identifier", () => {
    expect(validateApplicationIdentifier("Classroom")).toBe("Classroom");
  });

  it("rejects an empty application identifier", () => {
    expect(() => validateApplicationIdentifier("   ")).toThrow();
  });

  it("validates discriminated question configurations", () => {
    expect(questionDraftSchema.parse({
      questionSetId: "set-1", type: "single_choice", prompt: "Pick one", points: 2, position: 0,
      metadata: {}, configVersion: 1, answerConfig: {
        options: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correctOptionId: "a"
      }
    }).type).toBe("single_choice");
  });

  it("rejects invalid question and choice contracts", () => {
    expect(() => questionDraftSchema.parse({ questionSetId: "set-1", type: "true_false", prompt: "", points: 0, position: 0, metadata: {}, configVersion: 1, answerConfig: { correctAnswer: true } })).toThrow();
    expect(() => questionDraftSchema.parse({ questionSetId: "set-1", type: "single_choice", prompt: "Pick", points: 1, position: 0, metadata: {}, configVersion: 1, answerConfig: { options: [{ id: "a", text: "A" }, { id: "a", text: "Duplicate" }], correctOptionId: "a" } })).toThrow();
  });

  it("validates question sets and typed answers", () => {
    expect(createQuestionSetInputSchema.parse({ title: "Set", lessonId: null })).toEqual({ title: "Set", lessonId: null });
    expect(studentAnswerSchema.parse({ type: "essay", text: "response" }).type).toBe("essay");
  });
});
