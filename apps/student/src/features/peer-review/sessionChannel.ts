import type { ServerMessage } from "@classtools/backend-contract";
export type PeerSessionEvent = { type: "message"; message: ServerMessage; generation: number } | { type: "connection"; online: boolean; generation: number };
/** Feature-local adapter for the existing ParticipantTransport; never owns a socket or credentials. */
export function createPeerSessionChannel() {
  const listeners = new Set<(event: PeerSessionEvent) => void>();
  let generation = 0;
  let online = false;
  let available = false;
  let epoch = 0;
  return {
    snapshot: () => ({ generation, online, available, epoch }),
    subscribe: (listener: (event: PeerSessionEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    emit: (event: PeerSessionEvent) => {
      if (event.generation < generation) return;
      generation = event.generation;
      if (event.type === "connection" || event.message.type === "session_sync" || event.message.type === "peer_review_changed" || event.message.type === "peer_review_acknowledged" || event.message.type === "peer_review_rejected") epoch++;
      if (event.type === "connection") online = event.online;
      if (event.type === "message" && event.message.type === "session_sync") available = event.message.sync.peerReview?.available ?? false;
      for (const listener of listeners) listener(event);
    },
  };
}
export type PeerSessionChannel = ReturnType<typeof createPeerSessionChannel>;
