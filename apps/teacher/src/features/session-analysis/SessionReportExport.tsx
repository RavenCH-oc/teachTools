import { useEffect, useRef, useState } from "react";
import type { ExportSection } from "@classtools/validation";
import { sessionReportApi, type SessionReportApi } from "../../services/sessionReportApi";

const sections: ReadonlyArray<{ value: ExportSection; label: string }> = [
  { value: "SESSION_SUMMARY", label: "課堂摘要" },
  { value: "QUESTION_STATISTICS", label: "題目統計" },
  { value: "STUDENT_STATISTICS", label: "學生統計" },
];
export function SessionReportExport({ sessionId, api = sessionReportApi }: { sessionId: string; api?: SessionReportApi }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ExportSection[]>(sections.map((section) => section.value));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const generation = useRef(0);
  useEffect(() => { generation.current += 1; return () => { generation.current += 1; }; }, [sessionId]);
  const exportReport = async () => {
    if (working || selected.length === 0) return;
    const requestGeneration = generation.current;
    const current = () => requestGeneration === generation.current;
    setWorking(true); setError(""); setSuccess("");
    try {
      const outputPath = await api.choosePath();
      if (!current() || outputPath === null) return;
      const result = await api.exportReport({ sessionId, sections: sections.filter((section) => selected.includes(section.value)).map((section) => section.value), outputPath });
      if (current()) { setSuccess(`報表已匯出：${result.filename}`); setOpen(false); }
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : "匯出報表失敗，請重試。");
    } finally { if (current()) setWorking(false); }
  };
  return <section className="report-export" aria-label="課堂報表匯出">
    {!open && <button className="button ghost" type="button" onClick={() => { setOpen(true); setSelected(sections.map((section) => section.value)); setError(""); setSuccess(""); }}>匯出報表</button>}
    {open && <fieldset disabled={working}>
      <legend>匯出報表</legend>
      {sections.map((section) => <label className="report-section" key={section.value}><input type="checkbox" checked={selected.includes(section.value)} onChange={(event) => setSelected((previous) => event.target.checked ? [...previous, section.value] : previous.filter((value) => value !== section.value))} />{section.label}</label>)}
      {selected.length === 0 && <p>請至少選擇一個報表區段。</p>}
      <div className="form-actions">
        <button className="button ghost" type="button" onClick={() => { setOpen(false); setError(""); }}>取消</button>
        <button className="button primary" type="button" disabled={selected.length === 0 || working} onClick={() => void exportReport()}>{working ? "匯出中…" : "選擇位置並匯出"}</button>
      </div>
    </fieldset>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {success && <p className="success-banner" role="status">{success}</p>}
  </section>;
}
