import { invoke } from "@tauri-apps/api/core";
import { peerReviewActivitySchema, peerReviewDraftSchema, peerReviewSetupSchema } from "@classtools/validation";
import type { PeerReviewActivity, PeerReviewDraft, PeerReviewSetup } from "@classtools/validation";

export interface PeerReviewApi {
  getPeerReviewSetupContext(sessionId: string): Promise<PeerReviewSetup>;
  createPeerReviewActivity(request: PeerReviewDraft): Promise<PeerReviewActivity>;
  updatePeerReviewActivityDraft(activityId: string, request: PeerReviewDraft): Promise<PeerReviewActivity>;
  openPeerReviewActivity(sessionId: string, activityId: string): Promise<PeerReviewActivity>;
  closePeerReviewActivity(sessionId: string, activityId: string): Promise<PeerReviewActivity>;
  cancelPeerReviewActivity(sessionId: string, activityId: string): Promise<PeerReviewActivity>;
}
const errors: Record<string, string> = {
  PEER_REVIEW_ESSAY_REQUIRED: "同儕互評目前只支援論述題。",
  QUESTION_NOT_READY: "請先停止學生作答，再開放互評。",
  PEER_REVIEW_NOT_OPEN: "活動狀態已變更，請重新載入。",
  INSUFFICIENT_REVIEW_PARTICIPANTS: "至少需要 2 位可參與互評的學生。",
  GROUP_SET_REQUIRED: "請選擇分組版本。",
  GROUP_SET_SESSION_MISMATCH: "此分組不屬於目前課堂。",
  INSUFFICIENT_REVIEW_GROUPS: "至少需要 2 個具有論述答案的組別。",
  PEER_REVIEW_ALREADY_OPEN: "此題已有草稿或進行中的互評活動，請選擇既有活動。",
  SESSION_ENDED: "課堂已結束，無法再修改互評活動。",
  SESSION_NOT_ACTIVE: "請先開始課堂，再設定互評活動。",
  PEER_REVIEW_CLOSED: "活動設定已鎖定，無法再修改。",
  PEER_REVIEW_ACTIVITY_NOT_FOUND: "找不到目前課堂的互評活動。",
  QUESTION_SESSION_MISMATCH: "此題目不屬於目前課堂。",
  INVALID_INPUT: "請檢查互評設定；評論上限須為正整數或不限。",
};
async function read(command: string, args: Record<string, unknown>): Promise<unknown> {
  try { return await invoke<unknown>(command,args); }
  catch (cause) { throw new Error(typeof cause === "string" ? errors[cause] ?? "無法完成互評操作，請重新載入後再試。" : "無法完成互評操作，請重新載入後再試。"); }
}
async function activity(command: string, args: Record<string, unknown>) {
  const result=peerReviewActivitySchema.safeParse(await read(command,args));
  if (!result.success) throw new Error("互評資料格式不相容，請重新啟動教師端。");
  return result.data;
}
function draft(request: PeerReviewDraft) {
  const result=peerReviewDraftSchema.safeParse(request);
  if (!result.success) throw new Error(errors.INVALID_INPUT);
  return result.data;
}
export const peerReviewApi: PeerReviewApi = {
  getPeerReviewSetupContext: async (sessionId) => {
    const result=peerReviewSetupSchema.safeParse(await read("get_peer_review_setup_context",{sessionId}));
    if (!result.success) throw new Error("互評設定資料格式不相容，請重新啟動教師端。");
    return result.data;
  },
  createPeerReviewActivity: (request) => activity("create_peer_review_activity",{request:draft(request)}),
  updatePeerReviewActivityDraft: (activityId,request) => activity("update_peer_review_activity_draft",{activityId,request:draft(request)}),
  openPeerReviewActivity: (sessionId,activityId) => activity("open_peer_review_activity",{sessionId,activityId}),
  closePeerReviewActivity: (sessionId,activityId) => activity("close_peer_review_activity",{sessionId,activityId}),
  cancelPeerReviewActivity: (sessionId,activityId) => activity("cancel_peer_review_activity",{sessionId,activityId}),
};
