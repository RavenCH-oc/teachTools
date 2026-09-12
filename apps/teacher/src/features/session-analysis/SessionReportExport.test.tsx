import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionReportExport } from "./SessionReportExport";

const sessionId = "01900000-0000-7000-8000-000000000001";
function api() { return { choosePath: vi.fn().mockResolvedValue("C:\\Reports\\report.xlsx"), exportReport: vi.fn().mockResolvedValue({ filename: "report.xlsx" }) }; }
function open() { fireEvent.click(screen.getByRole("button", { name: "匯出報表" })); }
describe("SessionReportExport", () => {
  it("defaults all sections and blocks an empty selection", () => {
    render(<SessionReportExport sessionId={sessionId} api={api()} />);
    open();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    for (const box of boxes) { expect(box).toBeChecked(); fireEvent.click(box); }
    expect(screen.getByRole("button", { name: "選擇位置並匯出" })).toBeDisabled();
  });
  it("treats Save As cancellation as ordinary cancellation", async () => {
    const service = api(); service.choosePath.mockResolvedValue(null);
    render(<SessionReportExport sessionId={sessionId} api={service} />);
    open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "選擇位置並匯出" })));
    expect(service.exportReport).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "選擇位置並匯出" })).toBeEnabled();
  });
  it("sends only selected sections and confirms backend success", async () => {
    const service = api();
    render(<SessionReportExport sessionId={sessionId} api={service} />);
    open();
    fireEvent.click(screen.getByLabelText("課堂摘要"));
    fireEvent.click(screen.getByLabelText("學生統計"));
    fireEvent.click(screen.getByRole("button", { name: "選擇位置並匯出" }));
    expect(await screen.findByRole("status")).toHaveTextContent("報表已匯出：report.xlsx");
    expect(service.exportReport).toHaveBeenCalledWith({ sessionId, sections: ["QUESTION_STATISTICS"], outputPath: "C:\\Reports\\report.xlsx" });
  });
  it("keeps canonical section order and presents controlled failure without success", async () => {
    const service = api(); service.exportReport.mockRejectedValue(new Error("無法寫入指定檔案。"));
    render(<SessionReportExport sessionId={sessionId} api={service} />);
    open();
    fireEvent.click(screen.getByLabelText("課堂摘要"));
    fireEvent.click(screen.getByLabelText("課堂摘要"));
    fireEvent.click(screen.getByRole("button", { name: "選擇位置並匯出" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("無法寫入指定檔案。");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(service.exportReport).toHaveBeenCalledWith({ sessionId, sections: ["SESSION_SUMMARY", "QUESTION_STATISTICS", "STUDENT_STATISTICS"], outputPath: "C:\\Reports\\report.xlsx" });
  });
});
