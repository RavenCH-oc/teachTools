import { describe, expect, it } from "vitest";
import {
  parseRemoteControlPlaneEnvelope,
  remoteBootstrapSchema,
  remoteCreateSessionRequestSchema,
} from "./remote";

describe("Remote Protocol v1 control-plane contract", () => {
  const id = "00000000-0000-4000-8000-000000000000";

  it("accepts only the exact protocol version before control payload processing", () => {
    expect(remoteCreateSessionRequestSchema.parse({ teacherAppVersion: "0.1.0", remoteProtocolVersion: 1 })
      .remoteProtocolVersion).toBe(1);
    expect(remoteCreateSessionRequestSchema.safeParse({ teacherAppVersion: "0.1.0", remoteProtocolVersion: 2 }).success)
      .toBe(false);
    expect(() => parseRemoteControlPlaneEnvelope(JSON.stringify({ v: 2, type: "CONTROL", id,
      payload: { op: "ping" } }))).toThrow();
  });

  it("rejects oversized and malformed envelopes", () => {
    expect(parseRemoteControlPlaneEnvelope(JSON.stringify({ v: 1, type: "CONTROL", id,
      payload: { op: "ping" } })).type).toBe("CONTROL");
    expect(() => parseRemoteControlPlaneEnvelope("x".repeat(64 * 1024 + 1))).toThrow();
    expect(() => parseRemoteControlPlaneEnvelope(JSON.stringify({ v: 1, type: "CONTROL", id,
      payload: { op: "join" } }))).toThrow();
  });

  it("allows only generic public bootstrap fields", () => {
    expect(remoteBootstrapSchema.safeParse({ reachable: true, remoteProtocolVersion: 1,
      status: "available", classroomName: "private" }).success).toBe(false);
  });
});
