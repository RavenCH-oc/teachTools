import { describe, expect, it } from "vitest";
import { APP_NAME, SHARED_PACKAGE_VERSION } from "./index";

describe("@classtools/shared", () => {
  it("exposes the application identity", () => {
    expect(APP_NAME).toBe("Classroom");
    expect(SHARED_PACKAGE_VERSION).toBe(1);
  });
});
