import { describe, expect, it } from "vitest";
import { validateApplicationIdentifier } from "./index";

describe("@classtools/validation", () => {
  it("accepts a non-empty application identifier", () => {
    expect(validateApplicationIdentifier("Classroom")).toBe("Classroom");
  });

  it("rejects an empty application identifier", () => {
    expect(() => validateApplicationIdentifier("   ")).toThrow();
  });
});
