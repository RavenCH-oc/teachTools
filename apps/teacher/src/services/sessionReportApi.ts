import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { exportRequestSchema, exportResultSchema, type ExportRequest, type ExportResult } from "@classtools/validation";

const messages: Record<string, string> = {
  invalid_session_id: "課堂識別資料無效。",
  invalid_sections: "請選擇至少一個不重複的報表區段。",
  invalid_output_path: "請選擇 .xlsx 檔案儲存位置。",
  session_not_found: "找不到指定課堂。",
  session_not_ended: "只能匯出已結束的課堂。",
  storage: "無法讀取課堂報表資料。",
  generation: "產生 Excel 報表失敗。",
  write: "無法寫入指定檔案。",
};
export interface SessionReportApi {
  choosePath: () => Promise<string | null>;
  exportReport: (request: ExportRequest) => Promise<ExportResult>;
}
export const sessionReportApi: SessionReportApi = {
  choosePath: async () => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    try {
      return await save({
        defaultPath: `classroom-session-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.xlsx`,
        filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
      });
    } catch { throw new Error("無法開啟儲存位置選擇視窗。"); }
  },
  exportReport: async (request) => {
    const parsed = exportRequestSchema.safeParse(request);
    if (!parsed.success) throw new Error("請確認課堂、報表區段與儲存位置。");
    try {
      return exportResultSchema.parse(await invoke<unknown>("export_session_report", { request: parsed.data }));
    } catch (cause) {
      throw new Error(typeof cause === "string" && Object.hasOwn(messages, cause) ? messages[cause] : "匯出報表失敗，請重試。");
    }
  },
};
