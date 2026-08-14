import {
  LOCAL_PROTOCOL_VERSION,
  clientMessageSchema,
  joinSuccessSchema,
  publicErrorSchema,
  serverMessageSchema,
  sessionPublicViewSchema,
  type JoinSuccess,
  type SessionPublicView,
} from "@classtools/backend-contract";

export class StudentApiError extends Error {
  constructor(message: string, readonly code = "REQUEST_FAILED") { super(message); this.name = "StudentApiError"; }
}

export type StoredParticipant = JoinSuccess;
export const STUDENT_HEARTBEAT_INTERVAL_MS = 3_000;
export const PRESENCE_TIMEOUT_MS = 7_000;

export async function getJoinInfo(joinCode: string): Promise<SessionPublicView> {
  return request(`/api/v1/join/${encodeURIComponent(joinCode)}`, { method: "GET" }, sessionPublicViewSchema.parse);
}

export async function joinClassroom(joinCode: string, seatNumber: number, name: string): Promise<JoinSuccess> {
  return request(`/api/v1/join/${encodeURIComponent(joinCode)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seatNumber, name }),
  }, joinSuccessSchema.parse);
}

async function request<T>(path: string, init: RequestInit, parse: (value: unknown) => T): Promise<T> {
  let response: Response;
  try { response = await fetch(path, init); } catch { throw new StudentApiError("無法連線到課堂伺服器。請確認網路後再試。", "NETWORK_ERROR"); }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = publicErrorSchema.safeParse(body);
    throw new StudentApiError(error.success ? error.data.message : "無法完成課堂請求。", error.success ? error.data.code : "REQUEST_FAILED");
  }
  try { return parse(body); } catch { throw new StudentApiError("課堂伺服器回應無法使用。", "INVALID_RESPONSE"); }
}

export function storedParticipant(info: SessionPublicView): StoredParticipant | null {
  try {
    const raw = localStorage.getItem(storageKey(info));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    const parsed = joinSuccessSchema.safeParse(value);
    return parsed.success && parsed.data.sessionId === info.sessionId && parsed.data.serverInstanceId === info.serverInstanceId ? parsed.data : null;
  } catch { return null; }
}

export function saveParticipant(info: SessionPublicView, participant: StoredParticipant): void { localStorage.setItem(storageKey(info), JSON.stringify(participant)); }
export function clearParticipant(info: SessionPublicView): void { localStorage.removeItem(storageKey(info)); }
function storageKey(info: SessionPublicView): string { return `classroom.participant.${info.serverInstanceId}.${info.sessionId}`; }

export type ParticipantDisconnectReason = "transient" | "AUTH_FAILED" | "SESSION_ENDED" | "SERVER_INSTANCE_MISMATCH";

export function webSocketUrl(location: Pick<Location, "protocol" | "host"> = window.location): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

export function requestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto.getRandomValues === "function") {
    const values = new Uint32Array(4);
    crypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(36)).join("-");
  }
  return `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function connectParticipant(
  participant: StoredParticipant,
  onAuthenticated: () => void,
  onEnded: () => void,
  onDisconnected: (reason: ParticipantDisconnectReason) => void,
): () => void {
  const socket = new WebSocket(webSocketUrl());
  let authenticated = false;
  let closedByClient = false;
  let disconnectReason: ParticipantDisconnectReason = "transient";
  let heartbeatTimer: number | undefined;
  const stopHeartbeat = () => {
    if (heartbeatTimer !== undefined) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };
  const sendHeartbeat = () => {
    if (!authenticated || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(clientMessageSchema.parse({ protocolVersion: LOCAL_PROTOCOL_VERSION, type: "ping", requestId: requestId() })));
    } catch { socket.close(); }
  };
  const startHeartbeat = () => {
    if (heartbeatTimer === undefined) heartbeatTimer = window.setInterval(sendHeartbeat, STUDENT_HEARTBEAT_INTERVAL_MS);
  };
  socket.onmessage = (event) => {
    let payload: unknown;
    try { payload = JSON.parse(String(event.data)); } catch { socket.close(); return; }
    const parsed = serverMessageSchema.safeParse(payload);
    if (!parsed.success) { socket.close(); return; }
    const message = parsed.data;
    if (message.type === "server_hello") {
      if (message.serverInstanceId !== participant.serverInstanceId) {
        disconnectReason = "SERVER_INSTANCE_MISMATCH";
        socket.close();
        return;
      }
      try {
        socket.send(JSON.stringify(clientMessageSchema.parse({ protocolVersion: LOCAL_PROTOCOL_VERSION, type: "participant_auth", requestId: requestId(), sessionId: participant.sessionId, participantId: participant.participantId, credential: participant.credential })));
      } catch { socket.close(); }
    } else if (message.type === "participant_authenticated") { authenticated = true; startHeartbeat(); onAuthenticated(); }
    else if (message.type === "session_state_changed" && message.state === "ENDED") { disconnectReason = "SESSION_ENDED"; closedByClient = true; stopHeartbeat(); onEnded(); socket.close(); }
    else if (message.type === "error") {
      if (message.code === "AUTH_FAILED" || message.code === "SESSION_ENDED" || message.code === "SERVER_INSTANCE_MISMATCH") disconnectReason = message.code;
      socket.close();
    }
  };
  socket.onerror = () => { /* The close event determines whether this was authoritative. */ };
  socket.onclose = () => { stopHeartbeat(); if (!closedByClient) onDisconnected(authenticated ? "transient" : disconnectReason); };
  return () => { closedByClient = true; stopHeartbeat(); socket.close(); };
}
