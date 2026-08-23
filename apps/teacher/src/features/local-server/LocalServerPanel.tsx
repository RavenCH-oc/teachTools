import { useCallback, useEffect, useState } from "react";
import { TeacherApiError } from "../../services/teacherApi";
import type { LocalServerLifecycleState, LocalServerStatus, TeacherApi } from "../../types/teacher";

const lifecycleLabels: Record<LocalServerLifecycleState, string> = {
  stopped: "已停止",
  starting: "正在啟動",
  running: "執行中",
  stopping: "正在停止",
};

interface LocalServerPanelProps {
  api: TeacherApi;
}

export function LocalServerPanel({ api }: LocalServerPanelProps) {
  const [status, setStatus] = useState<LocalServerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.getLocalServerStatus());
      setError("");
    } catch (cause) {
      setError(serverErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const changeServerState = async (operation: () => Promise<LocalServerStatus>) => {
    setWorking(true);
    setError("");
    try {
      setStatus(await operation());
    } catch (cause) {
      setError(serverErrorMessage(cause));
    } finally {
      setWorking(false);
    }
  };

  const lifecycle = status?.lifecycleState ?? "stopped";
  const canStart = !working && lifecycle === "stopped";
  const canStop = !working && lifecycle === "running";

  return <section aria-labelledby="local-server-title" className="local-server-panel">
    <div className="local-server-heading">
      <div>
        <p className="eyebrow">本機傳輸服務</p>
        <h2 id="local-server-title">本機教室伺服器</h2>
        <p>按需啟動 HTTP 與 WebSocket transport；尚未提供 QR、學生加入或課堂資料 API。</p>
      </div>
      <span className={`server-state server-state-${lifecycle}`}>{loading ? "讀取狀態中" : lifecycleLabels[lifecycle]}</span>
    </div>

    {error && <div className="server-error" role="alert"><span>{error}</span><button onClick={() => void refresh()} type="button">重新讀取</button></div>}

    {status?.running && <div className="server-details">
      <dl>
        <div><dt>連接埠</dt><dd>{status.port}</dd></div>
        <div><dt>本機網址</dt><dd><a href={status.localUrl ?? undefined} rel="noreferrer" target="_blank">{status.localUrl}</a></dd></div>
        <div><dt>協定版本</dt><dd>v{status.protocolVersion}</dd></div>
        <div><dt>伺服器執行個體</dt><dd className="server-instance-id">{status.serverInstanceId}</dd></div>
      </dl>
      <EndpointList label="LAN 候選網址" urls={status.candidateUrls} empty="沒有偵測到可供 LAN 使用的 IPv4 位址。" />
      <EndpointList label="WebSocket 位址" urls={status.webSocketUrls} empty="沒有可用的 WebSocket 位址。" />
    </div>}

    {!loading && !status?.running && <p className="server-idle-note">伺服器目前未監聽任何連接埠，也沒有背景工作。</p>}

    <div className="server-actions">
      <button className="button primary" disabled={!canStart} onClick={() => void changeServerState(() => api.startLocalServer())} type="button">
        {working && lifecycle === "stopped" ? "正在啟動…" : "啟動伺服器"}
      </button>
      <button className="button ghost" disabled={!canStop} onClick={() => void changeServerState(() => api.stopLocalServer())} type="button">
        {working && lifecycle === "running" ? "正在停止…" : "停止伺服器"}
      </button>
      <button className="text-button" disabled={working} onClick={() => void refresh()} type="button">更新狀態</button>
    </div>
    <p className="server-firewall-note">若 LAN 裝置無法連線，請人工檢查 Windows Firewall；本程式不會建立或修改 Firewall 規則。</p>
  </section>;
}

function EndpointList({ label, urls, empty }: { label: string; urls: string[]; empty: string }) {
  return <div className="server-endpoints"><h3>{label}</h3>{urls.length === 0 ? <p>{empty}</p> : <ul>{urls.map((url) => <li key={url}><code>{url}</code></li>)}</ul>}</div>;
}

function serverErrorMessage(cause: unknown): string {
  if (cause instanceof TeacherApiError) {
    if (cause.code === "server_bind_failed") return "無法啟動本機教室伺服器。請確認網路可用後再試一次。";
    if (cause.code === "server_shutdown_failed") return "伺服器未能正常停止。請重新讀取狀態後再試一次。";
    if (cause.code === "conflict") return "請先結束目前課堂，才能停止伺服器。";
    return "本機教室伺服器操作未完成。請重試。";
  }
  return "無法讀取或變更本機教室伺服器狀態。";
}
