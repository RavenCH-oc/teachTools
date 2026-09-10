import { beforeEach,expect,it,vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { peerReviewMonitorApi } from "./peerReviewMonitorApi";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
beforeEach(()=>vi.clearAllMocks());
it("validates pages and never exposes raw backend errors",async()=>{
  vi.mocked(invoke).mockResolvedValue({items:[],next_cursor:null,total:0});await peerReviewMonitorApi.statuses("s","a","targets",{limit:20});expect(invoke).toHaveBeenCalledWith("list_peer_review_monitor_statuses",{sessionId:"s",activityId:"a",kind:"targets",query:{limit:20}});
  vi.mocked(invoke).mockRejectedValue("SQL error /private/path");await expect(peerReviewMonitorApi.summary("s","a")).rejects.toThrow("無法讀取互評紀錄");
  vi.mocked(invoke).mockResolvedValue({items:[],next_cursor:null,total:-1});await expect(peerReviewMonitorApi.activities("s")).rejects.toThrow("無法讀取互評紀錄");
});
it("rejects oversized request limits before invoking IPC",()=>{expect(()=>peerReviewMonitorApi.activities("s",{limit:101})).toThrow();expect(invoke).not.toHaveBeenCalled();});
