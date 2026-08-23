import { useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { TeacherApiError } from "../../services/teacherApi";
import type { Classroom, LocalServerStatus, LocalSession, LocalSessionParticipant, TeacherApi } from "../../types/teacher";

export type LocalSessionLobbyApi = Pick<TeacherApi, "startLocalServer" | "getLocalServerStatus" | "createLocalSession" | "openLocalSessionLobby" | "getActiveLocalSession" | "endLocalSession" | "listLocalSessionParticipants">;

interface Props { api: LocalSessionLobbyApi; classrooms: Classroom[]; onError: (message: string) => void; onClearError: () => void; onOpenLiveQuiz: () => void; }

export function LocalSessionLobbyPage({ api, classrooms, onError, onClearError, onOpenLiveQuiz }: Props) {
  const [server, setServer] = useState<LocalServerStatus | null>(null);
  const [session, setSession] = useState<LocalSession | null>(null);
  const [participants, setParticipants] = useState<LocalSessionParticipant[]>([]);
  const [classroomId, setClassroomId] = useState("");
  const [candidateUrl, setCandidateUrl] = useState("");
  const [working, setWorking] = useState(false);
  const [participantRefreshError, setParticipantRefreshError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [nextServer, nextSession] = await Promise.all([api.getLocalServerStatus(), api.getActiveLocalSession()]);
      setServer(nextServer); setSession(nextSession);
      if (nextSession?.state === "LOBBY") setParticipants(await api.listLocalSessionParticipants(nextSession.id));
    } catch (cause) { onError(errorMessage(cause)); }
  }, [api, onError]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (session?.state !== "LOBBY") return;
    const timer = window.setInterval(() => {
      void api.listLocalSessionParticipants(session.id)
        .then((next) => { setParticipants(next); setParticipantRefreshError(""); })
        .catch((cause) => setParticipantRefreshError(errorMessage(cause)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [api, onError, session]);

  useEffect(() => { setCandidateUrl(""); }, [session?.id, server?.serverInstanceId]);
  const selectedClassroom = classrooms.find((classroom) => classroom.id === classroomId);
  const sessionMatchesServer = Boolean(session && server?.running && session.serverInstanceId === server.serverInstanceId);
  const staleSession = Boolean(session && session.state !== "ENDED" && !sessionMatchesServer);
  const joinUrl = useMemo(() => candidateUrl && session?.state === "LOBBY" && sessionMatchesServer ? `${candidateUrl}/student/join/${session.joinCode}` : "", [candidateUrl, session, sessionMatchesServer]);
  const candidates = server?.candidateUrls ?? [];

  const startServer = async () => { onClearError(); setWorking(true); try { setServer(await api.startLocalServer()); } catch (cause) { onError(errorMessage(cause)); } finally { setWorking(false); } };
  const createSession = async () => { if (!classroomId) return onError("請先選擇課堂。"); onClearError(); setWorking(true); try { setSession(await api.createLocalSession(classroomId)); } catch (cause) { onError(errorMessage(cause)); } finally { setWorking(false); } };
  const openLobby = async () => { if (!session) return; onClearError(); setWorking(true); try { setSession(await api.openLocalSessionLobby(session.id)); } catch (cause) { onError(errorMessage(cause)); } finally { setWorking(false); } };
  const endSession = async () => { if (!session || !window.confirm("確定要結束目前課堂嗎？學生將無法再加入。")) return; onClearError(); setWorking(true); try { await api.endLocalSession(session.id); setSession(null); setParticipants([]); setCandidateUrl(""); } catch (cause) { onError(errorMessage(cause)); } finally { setWorking(false); } };

  return <section className="local-lobby-page" aria-labelledby="local-lobby-title">
    <header className="page-heading"><div><p className="eyebrow">本機課堂</p><h2 id="local-lobby-title">{session?.state === "ACTIVE" && sessionMatchesServer ? "課堂進行中" : "建立學生等候大廳"}</h2><p className="intro">{session?.state === "ACTIVE" && sessionMatchesServer ? "目前課堂正在進行；可返回即時測驗繼續發布與管理題目。" : "選擇課堂、開放大廳，再由你選擇學生要使用的區網網址。"}</p></div></header>
    {!server?.running && <section className="form-card"><h3>第一步：啟動本機伺服器</h3><p>伺服器不會自動啟動。</p><button className="button primary" disabled={working} onClick={() => void startServer()} type="button">啟動本機伺服器</button></section>}
    {server?.running && !session && <section className="form-card"><h3>第二步：建立課堂</h3><label className="field"><span>課堂</span><select aria-label="選擇課堂" value={classroomId} onChange={(event) => setClassroomId(event.target.value)}><option value="">請選擇課堂</option>{classrooms.map((classroom) => <option key={classroom.id} value={classroom.id}>{classroom.name}</option>)}</select></label>{selectedClassroom && <p>將使用名冊比對模式；學生需自行輸入座號與姓名。</p>}<button className="button primary" disabled={working || !classroomId} onClick={() => void createSession()} type="button">建立課堂</button></section>}
    {staleSession && <section className="form-card"><h3>課堂伺服器狀態已變更</h3><p>這個未結束課堂不屬於目前的伺服器執行個體，無法繼續使用。請先結束舊課堂，再建立新的課堂。</p><button className="button danger" disabled={working} onClick={() => void endSession()} type="button">結束舊課堂</button></section>}
    {sessionMatchesServer && session?.state === "CREATED" && <section className="form-card"><h3>第三步：開放等候大廳</h3><p>課堂：{session.classroomName}</p><button className="button primary" disabled={working} onClick={() => void openLobby()} type="button">開放大廳</button><button className="button ghost" disabled={working} onClick={() => void endSession()} type="button">結束課堂</button></section>}
    {sessionMatchesServer && session?.state === "LOBBY" && <section className="lobby-card"><div><p className="eyebrow">等候大廳已開放</p><h3>{session.classroomName}</h3><p>課堂代碼：<strong>{session.joinCode}</strong></p><p>已加入：{participants.length} 人</p></div><label className="field"><span>學生連線網址</span><select aria-label="選擇學生連線網址" value={candidateUrl} onChange={(event) => setCandidateUrl(event.target.value)}><option value="">請選擇一個網路位址</option>{candidates.map((url) => <option key={url} value={url}>{candidateLabel(url)}</option>)}</select></label>{candidates.length === 0 && <p>目前沒有可用 IPv4 區網位址；可確認網路後重新啟動伺服器。</p>}{joinUrl && <div className="qr-panel"><QRCodeSVG aria-label="學生加入 QR Code" value={joinUrl} size={180} level="M" includeMargin /><p>網址：<code>{joinUrl}</code></p><p>課堂代碼：{session.joinCode}</p></div>}<button className="button danger" disabled={working} onClick={() => void endSession()} type="button">結束課堂</button>{participantRefreshError && <p className="participant-refresh-error" role="status">學生連線狀態暫時無法更新。</p>}<ParticipantList participants={participants} /></section>}
    {sessionMatchesServer && session?.state === "ACTIVE" && <section className="form-card"><p className="eyebrow">課堂進行中</p><h3>{session.classroomName}</h3><p>學生已進入作答流程；不會建立第二個課堂或重新啟動伺服器。</p><button className="button primary" disabled={working} onClick={onOpenLiveQuiz} type="button">返回即時測驗</button><button className="button danger" disabled={working} onClick={() => void endSession()} type="button">結束課堂</button></section>}
    {server?.running && <p className="server-firewall-note">若學生無法連線，Windows Firewall 或網路隔離可能需要人工確認；本功能不會自動變更系統防火牆。</p>}
  </section>;
}

function ParticipantList({ participants }: { participants: LocalSessionParticipant[] }) { return <section className="participant-list" aria-label="已加入學生"><h3>已加入學生</h3>{participants.length === 0 ? <p>尚未有學生加入。</p> : <ul>{participants.map((participant) => <li key={participant.participantId}><span>{participant.seatNumber} 號 {participant.displayName}</span><span>{participant.online ? "線上" : "離線"}</span><time>{new Date(participant.joinedAt).toLocaleTimeString("zh-TW")}</time></li>)}</ul>}</section>; }
function candidateLabel(url: string): string { const host = new URL(url).hostname; return `${host}（${host.startsWith("192.168.") || host.startsWith("10.") || host.startsWith("172.") ? "私有區網" : host.startsWith("169.254.") ? "Link-local" : "其他網路"}）`; }
function errorMessage(cause: unknown): string { return cause instanceof TeacherApiError ? cause.message : "無法完成課堂操作。"; }
