import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { peerReviewApi } from "./peerReviewApi";
import { draftFixture, setupFixture } from "../features/peer-review/testFixtures";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
beforeEach(()=>{vi.mocked(invoke).mockReset();});
describe("Teacher Peer Review IPC",()=>{
  it("validates the narrow context and sends one scoped request",async()=>{
    const context=setupFixture();vi.mocked(invoke).mockResolvedValue(context);
    expect(await peerReviewApi.getPeerReviewSetupContext("session")).toEqual(context);
    expect(invoke).toHaveBeenCalledWith("get_peer_review_setup_context",{sessionId:"session"});
    vi.mocked(invoke).mockResolvedValue({...context,answer_json:"private"});
    await expect(peerReviewApi.getPeerReviewSetupContext("session")).rejects.toThrow("格式不相容");
  });
  it("uses typed create/update/open/close/cancel commands without Student transport",async()=>{
    vi.mocked(invoke).mockResolvedValue(draftFixture());
    const r={session_id:"session",session_question_id:"essay",mode:"STUDENT_SELECT" as const,max_reviews_per_target:3,session_group_set_id:null};
    await peerReviewApi.createPeerReviewActivity(r);expect(invoke).toHaveBeenLastCalledWith("create_peer_review_activity",{request:r});
    await peerReviewApi.updatePeerReviewActivityDraft("activity",r);expect(invoke).toHaveBeenLastCalledWith("update_peer_review_activity_draft",{activityId:"activity",request:r});
    for(const [fn,command] of [[peerReviewApi.openPeerReviewActivity,"open_peer_review_activity"],[peerReviewApi.closePeerReviewActivity,"close_peer_review_activity"],[peerReviewApi.cancelPeerReviewActivity,"cancel_peer_review_activity"]] as const){await fn("session","activity");expect(invoke).toHaveBeenLastCalledWith(command,{sessionId:"session",activityId:"activity"});}
  });
  it("maps controlled errors and never reveals raw database text",async()=>{
    vi.mocked(invoke).mockRejectedValue("SESSION_ENDED");await expect(peerReviewApi.getPeerReviewSetupContext("session")).rejects.toThrow("課堂已結束");
    vi.mocked(invoke).mockRejectedValue("SQL path SECRET");await expect(peerReviewApi.getPeerReviewSetupContext("session")).rejects.toThrow("無法完成互評操作");
  });
});
