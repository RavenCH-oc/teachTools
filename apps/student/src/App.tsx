import { FormEvent, useEffect, useMemo, useState } from "react";
import { APP_NAME } from "@classtools/shared";
import type { SessionPublicView } from "@classtools/backend-contract";
import { clearParticipant, connectParticipant, getJoinInfo, joinClassroom, saveParticipant, storedParticipant, StudentApiError, type StoredParticipant } from "./services/studentApi";

type Screen = "loading" | "join" | "joining" | "connecting" | "lobby" | "ended" | "error";

export function App() {
  const joinCode = useMemo(() => joinCodeFromPath(window.location.pathname), []);
  const [manualCode, setManualCode] = useState("");
  const [info, setInfo] = useState<SessionPublicView | null>(null);
  const [screen, setScreen] = useState<Screen>(joinCode ? "loading" : "join");
  const [seatNumber, setSeatNumber] = useState("");
  const [name, setName] = useState("");
  const [participant, setParticipant] = useState<StoredParticipant | null>(null);
  const [error, setError] = useState("");
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (!joinCode) return;
    let active = true;
    void getJoinInfo(joinCode).then((next) => {
      if (!active) return;
      setInfo(next);
      const existing = storedParticipant(next);
      if (existing) { setParticipant(existing); setScreen("connecting"); }
      else setScreen("join");
    }).catch((cause) => { if (active) { setError(message(cause)); setScreen("error"); } });
    return () => { active = false; };
  }, [joinCode]);

  useEffect(() => {
    if (!info || !participant) return;
    let cancel = false;
    let attempt = 0;
    let disconnect = () => {};
    const connect = () => {
      disconnect = connectParticipant(participant, () => { if (!cancel) { setReconnecting(false); setScreen("lobby"); } }, () => {
        if (!cancel) { clearParticipant(info); setParticipant(null); setScreen("ended"); }
      }, (reason) => {
        if (cancel) return;
        if (reason === "AUTH_FAILED" || reason === "SESSION_ENDED" || reason === "SERVER_INSTANCE_MISMATCH") {
          clearParticipant(info); setParticipant(null);
          setError(reason === "SESSION_ENDED" ? "課堂已結束，請重新加入新的課堂。" : "登入狀態已失效，請重新加入課堂。");
          setScreen("join");
          return;
        }
        setReconnecting(true);
        const wait = [1000, 2000, 5000][Math.min(attempt++, 2)];
        window.setTimeout(() => { if (!cancel) connect(); }, wait);
      });
    };
    connect();
    return () => { cancel = true; disconnect(); };
  }, [info, participant]);

  const submitManual = (event: FormEvent) => { event.preventDefault(); const code = manualCode.trim().toUpperCase(); if (/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(code)) window.location.assign(`/student/join/${code}`); else setError("請輸入 8 碼課堂代碼。"); };
  const submitJoin = async (event: FormEvent) => {
    event.preventDefault();
    const seat = Number(seatNumber);
    if (!info || !Number.isInteger(seat) || seat <= 0 || !name.trim()) { setError("請輸入正確的座號與姓名。"); return; }
    setScreen("joining"); setError("");
    try {
      const joined = await joinClassroom(joinCode, seat, name);
      saveParticipant(info, joined); setParticipant(joined); setScreen("connecting");
    } catch (cause) { setError(message(cause)); setScreen("join"); }
  };

  if (!joinCode) return <main className="student-shell"><section className="student-card"><p className="eyebrow">學生端</p><h1>{APP_NAME}</h1><p>請輸入老師提供的課堂代碼。</p><form onSubmit={submitManual}><div className="student-field"><label htmlFor="manual-code">課堂代碼</label><input id="manual-code" value={manualCode} onChange={(event) => setManualCode(event.target.value)} /></div><button className="join-button" type="submit">前往課堂</button></form>{error && <p role="alert">{error}</p>}</section></main>;
  if (screen === "loading") return <State title="正在載入課堂…" />;
  if (screen === "error") return <State title="無法開啟課堂" detail={error} />;
  if (screen === "ended") return <State title="課堂已結束" detail="老師已結束這次課堂，登入資訊已清除。" />;
  if (!info) return <State title="正在載入課堂…" />;
  if (screen === "connecting") return <State title="正在驗證登入狀態…" detail={reconnecting ? "連線中斷，正在重新連線…" : "正在連線到課堂…"} />;
  if (screen === "lobby") return <main className="student-shell"><section className="student-card"><p className="eyebrow">{info.classroomName}</p><h1>已加入課堂</h1><p>座號：{participant?.participant.seatNumber}</p><p>姓名：{participant?.participant.displayName}</p><p>{reconnecting ? "連線中斷，正在重新連線…" : "等待老師開始…"}</p></section></main>;
  return <main className="student-shell"><section className="student-card"><p className="eyebrow">{info.classroomName}</p><h1>加入課堂</h1><form onSubmit={submitJoin}><div className="student-field"><label htmlFor="seat-number">座號</label><input id="seat-number" inputMode="numeric" value={seatNumber} onChange={(event) => setSeatNumber(event.target.value)} /></div><div className="student-field"><label htmlFor="student-name">姓名</label><input id="student-name" value={name} onChange={(event) => setName(event.target.value)} /></div><button className="join-button" disabled={screen === "joining"} type="submit">{screen === "joining" ? "加入中…" : "加入課堂"}</button></form>{error && <p role="alert">{error}</p>}</section></main>;
}

function State({ title, detail }: { title: string; detail?: string }) { return <main className="student-shell"><section className="student-card"><h1>{title}</h1>{detail && <p>{detail}</p>}</section></main>; }
function joinCodeFromPath(path: string): string { const match = /^\/student\/join\/([A-Za-z0-9]+)$/.exec(path); return match?.[1]?.toUpperCase() ?? ""; }
function message(cause: unknown): string { return cause instanceof StudentApiError ? cause.message : "無法完成課堂操作。"; }
