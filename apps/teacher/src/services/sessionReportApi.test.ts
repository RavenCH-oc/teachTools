import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { sessionReportApi } from "./sessionReportApi";
import { exportRequestSchema } from "@classtools/validation";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
const request = { sessionId: "01900000-0000-7000-8000-000000000001", sections: ["SESSION_SUMMARY" as const], outputPath: "C:\\Reports\\report.xlsx" };
beforeEach(() => vi.resetAllMocks());
it("uses the existing native save dialog with an XLSX filter", async () => {
  vi.mocked(save).mockResolvedValue(null);
  expect(await sessionReportApi.choosePath()).toBeNull();
  expect(save).toHaveBeenCalledWith({ defaultPath: expect.stringMatching(/^classroom-session-\d{8}-\d{4}\.xlsx$/), filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }] });
});
it("validates request and result across the IPC boundary", async () => {
  vi.mocked(invoke).mockResolvedValue({ filename: "report.xlsx" });
  expect(await sessionReportApi.exportReport(request)).toEqual({ filename: "report.xlsx" });
  expect(invoke).toHaveBeenCalledWith("export_session_report", { request });
  vi.mocked(invoke).mockResolvedValue({ filename: "report.xlsx", token: "secret" });
  await expect(sessionReportApi.exportReport(request)).rejects.toThrow("匯出報表失敗");
});
it("rejects invalid section sets without IPC", async () => {
  for (const sections of [[], ["SESSION_SUMMARY", "SESSION_SUMMARY"], ["UNKNOWN"]]) {
    expect(exportRequestSchema.safeParse({ ...request, sections }).success).toBe(false);
  }
  await expect(sessionReportApi.exportReport({ ...request, sections: [] })).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});
it("maps known backend failures and hides unknown internals", async () => {
  vi.mocked(invoke).mockRejectedValue("session_not_ended");
  await expect(sessionReportApi.exportReport(request)).rejects.toThrow("只能匯出已結束的課堂");
  vi.mocked(invoke).mockRejectedValue({ path: "internal database path" });
  await expect(sessionReportApi.exportReport(request)).rejects.toThrow("匯出報表失敗，請重試。");
});
