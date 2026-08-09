import { describe, expect, it } from "vitest";
import { DOMAIN_PACKAGE_VERSION } from "./index";

describe("@classtools/domain", () => {
  it("exposes the Phase 1 domain marker", () => {
    expect(DOMAIN_PACKAGE_VERSION).toBe(2);
  });
});
