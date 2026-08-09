import { describe, expect, it } from "vitest";
import vectors from "../test-vectors/grading-vectors.json";
import type { Question, StudentAnswer } from "@classtools/domain";
import { GRADING_PACKAGE_VERSION, GradingError, gradeQuestion, normalizeAnswer } from "./index";

describe("@classtools/grading", () => {
  it("exposes a versioned package boundary", () => { expect(GRADING_PACKAGE_VERSION).toBe(2); });
  it.each(vectors)("grades $name", (vector) => {
    const result = gradeQuestion(vector.question as Question, vector.answer as StudentAnswer);
    expect(result).toMatchObject(vector.expected);
  });
  it("rejects an answer with an unknown choice", () => {
    const vector = vectors[1]!;
    expect(() => gradeQuestion(vector.question as Question, { type: "single_choice", optionId: "missing" })).toThrowError(GradingError);
  });
  it("normalizes Unicode and case deterministically", () => {
    expect(normalizeAnswer("  Ｔａｉｗａｎ  ", { trim: true, unicodeNormalization: "NFKC", caseSensitive: false })).toBe("taiwan");
  });
});
