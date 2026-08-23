import {
  LOCAL_PROTOCOL_VERSION,
  clientMessageSchema,
  joinSuccessSchema,
  publicErrorSchema,
  serverMessageSchema,
  sessionPublicViewSchema,
  type JoinSuccess,
  type SessionPublicView,
  type ServerMessage,
  type StudentAnswer,
} from "@classtools/backend-contract";

export class StudentApiError extends Error {
  constructor(message: string, readonly code = "REQUEST_FAILED") { super(message); this.name = "StudentApiError"; }
}

export type StoredParticipant = JoinSuccess;
export type StoredParticipantResume = {
  info: SessionPublicView;
  participant: StoredParticipant;
};
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

export async function fetchSessionAsset(assetId: string, participant: StoredParticipant): Promise<Blob> {
  const response = await fetch(`/api/v1/session-assets/${encodeURIComponent(assetId)}`, { headers: { authorization: `Bearer ${participant.credential}`, "x-classroom-session": participant.sessionId, "x-classroom-participant": participant.participantId } });
  if (!response.ok) throw new StudentApiError("Unable to load session media.", "ASSET_UNAVAILABLE");
  return response.blob();
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

export function storedParticipantForJoinCode(joinCode: string): StoredParticipantResume | null {
  const info = storedResumeInfo(joinCode);
  if (!info) return null;
  const participant = storedParticipant(info);
  if (!participant) {
    localStorage.removeItem(resumeKey(joinCode));
    return null;
  }
  return { info, participant };
}

export function saveParticipant(info: SessionPublicView, participant: StoredParticipant, joinCode?: string): void {
  localStorage.setItem(storageKey(info), JSON.stringify(participant));
  if (joinCode) localStorage.setItem(resumeKey(joinCode), JSON.stringify(info));
}

export function clearParticipant(info: SessionPublicView, joinCode?: string): void {
  localStorage.removeItem(storageKey(info));
  if (!joinCode) return;
  const indexed = storedResumeInfo(joinCode);
  if (indexed?.sessionId === info.sessionId && indexed.serverInstanceId === info.serverInstanceId) {
    localStorage.removeItem(resumeKey(joinCode));
  }
}

function storageKey(info: SessionPublicView): string { return `classroom.participant.${info.serverInstanceId}.${info.sessionId}`; }
function resumeKey(joinCode: string): string { return `classroom.resume.v1.${joinCode.trim().toUpperCase()}`; }
function storedResumeInfo(joinCode: string): SessionPublicView | null {
  const key = resumeKey(joinCode);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = sessionPublicViewSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Invalid browser storage is not a credential and cannot be resumed safely.
  }
  localStorage.removeItem(key);
  return null;
}

export type ParticipantDisconnectReason = "transient" | "AUTH_FAILED" | "SESSION_ENDED" | "SERVER_INSTANCE_MISMATCH";
export type SubmitAnswerResult = "sent" | "transport_unavailable" | "serialization_failed" | "send_failed";
export type ParticipantConnectionState = {
  generation: number;
  authenticated: boolean;
  readyState: number;
};

export type ParticipantTransport = {
  start: () => void;
  retryReconnectNow: () => boolean;
  close: () => void;
  submitAnswer: (submissionId: string, sessionQuestionId: string, answer: StudentAnswer) => SubmitAnswerResult;
  markReconnectScheduled: () => void;
  currentConnection: () => ParticipantConnectionState | null;
};

export type ParticipantTransportCallbacks = {
  onAuthenticated: (connection: ParticipantConnectionState) => void;
  onEnded: () => void;
  onDisconnected: (reason: ParticipantDisconnectReason, connection: ParticipantConnectionState) => void;
  onMessage?: (message: ServerMessage, connection: ParticipantConnectionState) => void;
  onMessageError?: () => void;
};

type SocketConnection = {
  socket: WebSocket;
  generation: number;
  authenticated: boolean;
  closedByClient: boolean;
  disconnectReason: ParticipantDisconnectReason;
  heartbeatTimer: number | undefined;
};

export function webSocketUrl(location: Pick<Location, "protocol" | "host"> = window.location): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

export function secureUuid(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new StudentApiError("此瀏覽器無法安全產生作答識別碼。", "SECURE_RANDOM_UNAVAILABLE");
  }
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createParticipantTransport(participant: StoredParticipant, callbacks: ParticipantTransportCallbacks): ParticipantTransport {
  let current: SocketConnection | null = null;
  let closed = false;
  let nextGeneration = 0;

  const snapshot = (connection: SocketConnection): ParticipantConnectionState => ({
    generation: connection.generation,
    authenticated: connection.authenticated,
    readyState: connection.socket.readyState,
  });
  const isCurrent = (connection: SocketConnection): boolean => current === connection;
  const debug = (marker: string, connection: SocketConnection | null = current, detail = "") => {
    if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
      const generation = connection ? ` generation=${connection.generation}` : " generation=none";
      console.debug(`[student-transport] ${marker}${generation}${detail}`);
    }
  };
  const stopHeartbeat = (connection: SocketConnection) => {
    if (connection.heartbeatTimer !== undefined) {
      window.clearInterval(connection.heartbeatTimer);
      connection.heartbeatTimer = undefined;
    }
  };
  const closeSocket = (connection: SocketConnection) => {
    stopHeartbeat(connection);
    connection.socket.close();
  };
  const sendHeartbeat = (connection: SocketConnection) => {
    if (!isCurrent(connection) || !connection.authenticated || connection.socket.readyState !== WebSocket.OPEN) return;
    try {
      connection.socket.send(JSON.stringify(clientMessageSchema.parse({ protocolVersion: LOCAL_PROTOCOL_VERSION, type: "ping", requestId: secureUuid() })));
    } catch {
      debug("HEARTBEAT_SEND_FAILED", connection);
      closeSocket(connection);
    }
  };
  const startHeartbeat = (connection: SocketConnection) => {
    if (connection.heartbeatTimer === undefined) {
      connection.heartbeatTimer = window.setInterval(() => sendHeartbeat(connection), STUDENT_HEARTBEAT_INTERVAL_MS);
    }
  };
  const notifyMessage = (message: ServerMessage, connection: SocketConnection) => {
    try {
      callbacks.onMessage?.(message, snapshot(connection));
    } catch {
      debug("MESSAGE_CONSUMER_FAILED", connection);
      try { callbacks.onMessageError?.(); } catch { debug("MESSAGE_ERROR_HANDLER_FAILED", connection); }
    }
  };

  const start = () => {
    if (closed || current) return;
    const connection: SocketConnection = {
      socket: new WebSocket(webSocketUrl()),
      generation: ++nextGeneration,
      authenticated: false,
      closedByClient: false,
      disconnectReason: "transient",
      heartbeatTimer: undefined,
    };
    current = connection;
    debug("CONNECTION_CREATED", connection);
    connection.socket.onopen = () => { if (isCurrent(connection)) debug("SOCKET_OPEN", connection); };
    connection.socket.onmessage = (event) => {
      if (!isCurrent(connection)) { debug("STALE_INBOUND_IGNORED", connection); return; }
      let payload: unknown;
      try { payload = JSON.parse(String(event.data)); } catch { debug("INVALID_JSON", connection); closeSocket(connection); return; }
      const parsed = serverMessageSchema.safeParse(payload);
      if (!parsed.success) { debug("INVALID_SERVER_MESSAGE", connection); closeSocket(connection); return; }
      const message = parsed.data;
      debug(`RECEIVED_${message.type.toUpperCase()}`, connection);
      if (message.type === "submission_acknowledged") debug("SUBMIT_ACK_RECEIVED", connection);
      notifyMessage(message, connection);
      if (!isCurrent(connection)) return;

      if (message.type === "server_hello") {
        if (message.serverInstanceId !== participant.serverInstanceId) {
          connection.disconnectReason = "SERVER_INSTANCE_MISMATCH";
          debug("SERVER_INSTANCE_MISMATCH", connection);
          closeSocket(connection);
          return;
        }
        try {
          connection.socket.send(JSON.stringify(clientMessageSchema.parse({ protocolVersion: LOCAL_PROTOCOL_VERSION, type: "participant_auth", requestId: secureUuid(), sessionId: participant.sessionId, participantId: participant.participantId, credential: participant.credential })));
          debug("PARTICIPANT_AUTH_SENT", connection);
        } catch {
          debug("PARTICIPANT_AUTH_SEND_FAILED", connection);
          closeSocket(connection);
        }
      } else if (message.type === "participant_authenticated") {
        connection.authenticated = true;
        startHeartbeat(connection);
        debug("PARTICIPANT_AUTHENTICATED", connection);
        callbacks.onAuthenticated(snapshot(connection));
      } else if (message.type === "session_state_changed" && message.state === "ENDED") {
        connection.disconnectReason = "SESSION_ENDED";
        connection.closedByClient = true;
        stopHeartbeat(connection);
        current = null;
        debug("SESSION_ENDED", connection);
        callbacks.onEnded();
        connection.socket.close();
      } else if (message.type === "error") {
        if (message.code === "AUTH_FAILED" || message.code === "SESSION_ENDED" || message.code === "SERVER_INSTANCE_MISMATCH") {
          connection.disconnectReason = message.code;
          debug(`AUTHORITATIVE_ERROR_${message.code}`, connection);
          closeSocket(connection);
        } else if (message.code === "PROTOCOL_ERROR" || message.code === "AUTH_TIMEOUT") {
          debug(`PROTOCOL_ERROR_${message.code}`, connection);
          closeSocket(connection);
        } else {
          debug(`SUBMISSION_ERROR_${message.code}`, connection);
        }
      }
    };
    connection.socket.onerror = () => { if (isCurrent(connection)) debug("SOCKET_ERROR", connection); };
    connection.socket.onclose = (event) => {
      stopHeartbeat(connection);
      if (!isCurrent(connection)) return;
      current = null;
      const code = typeof event.code === "number" ? event.code : 0;
      const reason = event.reason ? "reason_present" : "no_reason";
      const disconnectReason = connection.disconnectReason === "transient" ? "transient" : connection.disconnectReason;
      debug(connection.closedByClient ? "SOCKET_CLOSED_BY_CLIENT" : `SOCKET_CLOSED_${disconnectReason}`, connection, ` code=${code} reason=${reason}`);
      if (!connection.closedByClient && !closed) callbacks.onDisconnected(disconnectReason, snapshot(connection));
    };
  };

  const retryReconnectNow = (): boolean => {
    if (closed || current?.authenticated) return false;
    const stale = current;
    if (stale) {
      current = null;
      stale.closedByClient = true;
      closeSocket(stale);
    }
    start();
    return current !== null;
  };

  return {
    start,
    retryReconnectNow,
    close: () => {
      closed = true;
      const connection = current;
      current = null;
      if (!connection) return;
      connection.closedByClient = true;
      stopHeartbeat(connection);
      debug("SOCKET_CLOSE_REQUESTED", connection);
      connection.socket.close();
    },
    submitAnswer: (submissionId, sessionQuestionId, answer) => {
      const connection = current;
      debug("SUBMIT_REQUESTED", connection);
      const readyState = connection?.socket.readyState ?? -1;
      const authenticated = connection?.authenticated ?? false;
      debug("SUBMIT_TRANSPORT_STATE", connection, ` authenticated=${authenticated} readyState=${readyState}`);
      if (!connection || !authenticated || readyState !== WebSocket.OPEN) {
        debug("SUBMIT_SEND_FAILED", connection, " reason=transport_unavailable");
        return "transport_unavailable";
      }
      let serialized: string;
      try {
        serialized = JSON.stringify(clientMessageSchema.parse({ protocolVersion: LOCAL_PROTOCOL_VERSION, type: "submit_answer", requestId: secureUuid(), submissionId, sessionQuestionId, answer }));
      } catch {
        debug("SUBMIT_BUILD_FAILED", connection);
        return "serialization_failed";
      }
      try {
        connection.socket.send(serialized);
        debug("SUBMIT_FRAME_SENT", connection);
        return "sent";
      } catch {
        debug("SUBMIT_SEND_FAILED", connection, " reason=send_exception");
        closeSocket(connection);
        return "send_failed";
      }
    },
    markReconnectScheduled: () => { debug("RECONNECT_SCHEDULED"); },
    currentConnection: () => current ? snapshot(current) : null,
  };
}
