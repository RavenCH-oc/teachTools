import { describe, expect, it } from "vitest";
import { BACKEND_CONTRACT_VERSION } from "./index";

describe("@classtools/backend-contract", () => {
  it("keeps the contract marker versioned", () => {
    expect(BACKEND_CONTRACT_VERSION).toBe(1);
  });
});
