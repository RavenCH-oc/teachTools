import { describe, expect, it } from "vitest";
import { GRADING_PACKAGE_VERSION } from "./index";

describe("@classtools/grading", () => {
  it("exposes a versioned package boundary", () => {
    expect(GRADING_PACKAGE_VERSION).toBe(1);
  });
});
