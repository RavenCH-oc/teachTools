import { peerReviewDraftSchema, peerReviewPendingSchema, type PeerReviewDraft, type PeerReviewPending } from "@classtools/backend-contract";
import type { StoredParticipant } from "../../services/studentApi";
export function peerStorage(p: StoredParticipant) {
  const prefix = `classroom.peerReview.v1.${p.serverInstanceId}.${p.sessionId}.${p.participantId}.`;
  const key = (activity: string, assignment: string, kind: string) => `${prefix}${activity}.${assignment}.${kind}`;
  const read = (key: string): unknown => { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; } };
  return {
    draft: (a: string, id: string): PeerReviewDraft | null => { const value = peerReviewDraftSchema.safeParse(read(key(a, id, "draft"))); return value.success ? value.data : null; },
    saveDraft: (a: string, id: string, draft: PeerReviewDraft) => localStorage.setItem(key(a, id, "draft"), JSON.stringify(peerReviewDraftSchema.parse(draft))),
    clearDraft: (a: string, id: string) => localStorage.removeItem(key(a, id, "draft")),
    savePending: (pending: PeerReviewPending) => localStorage.setItem(key(pending.activityId, pending.assignmentId, "pending"), JSON.stringify(peerReviewPendingSchema.parse(pending))),
    clearPending: (pending: PeerReviewPending) => {
      const recordKey = key(pending.activityId, pending.assignmentId, "pending");
      const stored = peerReviewPendingSchema.safeParse(read(recordKey));
      if (stored.success && stored.data.reviewSubmissionId === pending.reviewSubmissionId) localStorage.removeItem(recordKey);
    },
    pending: (): PeerReviewPending[] => {
      const records: PeerReviewPending[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const recordKey = localStorage.key(i);
        if (!recordKey?.startsWith(prefix) || !recordKey.endsWith(".pending")) continue;
        const record = peerReviewPendingSchema.safeParse(read(recordKey));
        if (record.success && recordKey === key(record.data.activityId, record.data.assignmentId, "pending")) records.push(record.data);
      }
      return records;
    },
  };
}
