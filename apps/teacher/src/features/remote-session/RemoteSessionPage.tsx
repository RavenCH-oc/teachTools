import { useEffect, useState } from "react";
import type { RemoteTeacherStatus } from "@classtools/backend-contract";
import type { Classroom } from "../../types/teacher";
import { TeacherApiError } from "../../services/teacherApi";
import { remoteTeacherApi, type RemoteTeacherApi } from "../../services/remoteTeacherApi";

interface Props {
  classrooms: Classroom[];
  api?: RemoteTeacherApi;
}

const stateText = {
  CONNECTING: "連線中",
  OPEN: "已連線",
  TEACHER_OFFLINE: "連線中斷，正在重試",
};

export function RemoteSessionPage({ classrooms, api = remoteTeacherApi }: Props) {
  const [status, setStatus] = useState<RemoteTeacherStatus | null>(null);
  const [activationCode, setActivationCode] = useState("");
  const [classroomId, setClassroomId] = useState(classrooms[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const refresh = () => void api.status()
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof TeacherApiError ? cause.message : "遠端狀態無法取得。"); });
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [api]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await operation(); setStatus(await api.status()); }
    catch (cause) { setError(cause instanceof TeacherApiError ? cause.message : "遠端操作未完成。"); }
    finally { setBusy(false); }
  };

  return <>
    <div className="page-heading compact"><div><p className="eyebrow">遠端課堂</p><h2>Remote Mode</h2><p className="intro">教師端主動連線至 relay；學生加入功能將於後續階段開放。</p></div></div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {!status && <div className="state-card" role="status">正在取得遠端狀態…</div>}
    {status && !status.configured && <div className="state-card">此安裝版本尚未設定 Remote relay URL。本機課堂仍可使用。</div>}
    {status?.configured && !status.enrolled && <section className="form-card">
      <h3>啟用教師安裝</h3><p>請輸入管理者提供的單次啟用碼。憑證只儲存在 Windows Credential Manager。</p>
      <form onSubmit={(event) => { event.preventDefault(); void run(async () => { await api.enroll(activationCode.trim()); setActivationCode(""); }); }}>
        <label>啟用碼<input autoComplete="off" value={activationCode} onChange={(event) => setActivationCode(event.target.value)} /></label>
        <button className="button primary" disabled={busy || !activationCode.trim()} type="submit">啟用</button>
      </form>
    </section>}
    {status?.configured && status.enrolled && !status.session && <section className="form-card">
      <h3>建立遠端課堂</h3>
      <label>班級<select value={classroomId} onChange={(event) => setClassroomId(event.target.value)}>
        {classrooms.map((classroom) => <option key={classroom.id} value={classroom.id}>{classroom.name}</option>)}
      </select></label>
      <button className="button primary" disabled={busy || !classroomId} onClick={() => void run(() => api.create(classroomId).then(() => undefined))} type="button">建立 Remote Session</button>
    </section>}
    {status?.session && <section className="state-card">
      <h3>遠端課堂狀態：{stateText[status.session.state]}</h3>
      <p>Teacher generation：{status.session.generation ?? "等待連線"}</p>
      <p>公開入口：<a href={status.session.joinUrl} target="_blank" rel="noreferrer">{status.session.joinUrl}</a></p>
      <p>此入口目前只顯示 relay 狀態，不接受學生加入。</p>
      <button className="button ghost" disabled={busy} onClick={() => void run(() => api.close())} type="button">關閉 Remote Session</button>
    </section>}
  </>;
}
