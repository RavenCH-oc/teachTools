import { describe, expect, it } from "vitest";
import fixtures from "../test-vectors/local-protocol-vectors.json";
import {
  BACKEND_CONTRACT_VERSION,
  LOCAL_PROTOCOL_VERSION,
  clientMessageSchema,
  serverMessageSchema,
} from "./index";

describe("@classtools/backend-contract", () => {
  it("keeps the local transport protocol versioned", () => {
    expect(BACKEND_CONTRACT_VERSION).toBe(1);
    expect(LOCAL_PROTOCOL_VERSION).toBe(1);
  });

  it("accepts the shared valid protocol fixtures", () => {
    for (const message of fixtures.validClientMessages) {
      expect(clientMessageSchema.safeParse(message).success).toBe(true);
    }
    for (const message of fixtures.validServerMessages) {
      expect(serverMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it("rejects malformed, unsupported, and unknown client messages", () => {
    for (const fixture of fixtures.invalidClientMessages) {
      expect(clientMessageSchema.safeParse(fixture.message).success, fixture.name).toBe(false);
    }
  });
});
