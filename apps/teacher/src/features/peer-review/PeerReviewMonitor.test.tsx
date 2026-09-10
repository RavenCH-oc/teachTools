import { act,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { afterEach,expect,it,vi } from "vitest";
import { PeerReviewMonitor,PeerReviewRecordsEntry } from "./PeerReviewMonitor";
import type { MonitorSummary,MonitorStatus } from "@classtools/validation";
import type { PeerReviewMonitorApi } from "../../services/peerReviewMonitorApi";
const summary:MonitorSummary={activity_id:"a",question_summary:"Frozen question",mode:"STUDENT_SELECT",state:"OPEN",opened_at:"now",closed_at:null,eligible_reviewers:5,assignment_count:4,submitted_count:3,target_count:5,covered_count:2};
const row:MonitorStatus={id:"p",label:"1 · Student",assignment_id:"x",target_label:"2 · Target",latest_revision:2,claimed_count:1,submitted_count:1,capacity:null,remaining_capacity:null};
function fixture(){return {activities:vi.fn().mockResolvedValue({items:[summary],next_cursor:null,total:1}),summary:vi.fn().mockResolvedValue(summary),statuses:vi.fn().mockResolvedValue({items:[row],next_cursor:null,total:1}),revisions:vi.fn().mockResolvedValue({items:[{revision:2,body:"Original feedback",submitted_at:"now",submitted_by:"1 · Student"}],next_cursor:null,total:2})} satisfies PeerReviewMonitorApi;}
afterEach(()=>{vi.useRealTimers();});
it("owns one OPEN timer, stops on unmount/CLOSED and ignores late completion",async()=>{
  vi.useFakeTimers();const api=fixture();const view=render(<PeerReviewMonitor api={api} sessionId="s" activityId="a" onBack={()=>{}}/>);
  await act(async()=>{});expect(api.summary).toHaveBeenCalledTimes(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(api.summary).toHaveBeenCalledTimes(2);
  view.unmount();await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});expect(api.summary).toHaveBeenCalledTimes(2);
  api.summary.mockResolvedValue({...summary,state:"CLOSED"});render(<PeerReviewMonitor api={api} sessionId="s" activityId="a" onBack={()=>{}}/>);await act(async()=>{});await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});expect(api.summary).toHaveBeenCalledTimes(3);expect(screen.getByText(/互評已結束/)).toBeInTheDocument();
});
it("loads detail/history lazily, preserves content when newer metadata arrives",async()=>{
  const api=fixture();render(<PeerReviewMonitor api={api} sessionId="s" activityId="a" onBack={()=>{}}/>);fireEvent.click(await screen.findByRole("button",{name:"查看評論"}));await screen.findByText("Original feedback");expect(api.revisions).toHaveBeenCalledTimes(1);
  api.statuses.mockResolvedValue({items:[{...row,latest_revision:3}],next_cursor:null,total:1});fireEvent.click(screen.getByRole("button",{name:"重新整理"}));await screen.findByText(/有較新版本/);expect(screen.getByText("Original feedback")).toBeInTheDocument();expect(api.revisions).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button",{name:"查看版本紀錄"}));await waitFor(()=>expect(api.revisions).toHaveBeenLastCalledWith("s","a","x",false,{limit:10,cursor:undefined}));
});
it("provides a bounded history entry and no fake DRAFT progress",async()=>{
  const api=fixture();api.activities.mockResolvedValue({items:[{...summary,state:"DRAFT",eligible_reviewers:0}],next_cursor:null,total:1});render(<PeerReviewRecordsEntry api={api} sessionId="s" onOpen={()=>{}}/>);await screen.findByText("尚未開放，請回互評設定管理。");expect(screen.queryByText(/NaN|Infinity/)).not.toBeInTheDocument();expect(screen.queryByRole("button",{name:"查看紀錄"})).not.toBeInTheDocument();expect(api.revisions).not.toHaveBeenCalled();
});
it("uses independent coverage queries and resets cursors when switching lists",async()=>{
  const api=fixture();api.statuses.mockResolvedValue({items:[row],next_cursor:"abcd",total:30});render(<PeerReviewMonitor api={api} sessionId="s" activityId="a" onBack={()=>{}}/>);fireEvent.click(await screen.findByRole("button",{name:"下一頁"}));await waitFor(()=>expect(api.statuses).toHaveBeenLastCalledWith("s","a","reviewers",{limit:20,cursor:"abcd"}));fireEvent.click(screen.getByRole("button",{name:"尚未收到評論"}));await waitFor(()=>expect(api.statuses).toHaveBeenLastCalledWith("s","a","uncovered",{limit:20,cursor:undefined}));
});
it("ignores a previous Activity completion after navigation",async()=>{
  const api=fixture();let finish:(value:MonitorSummary)=>void=()=>{};
  api.summary.mockImplementationOnce(()=>new Promise<MonitorSummary>(resolve=>{finish=resolve;}));
  const view=render(<PeerReviewMonitor api={api} sessionId="s" activityId="a" onBack={()=>{}}/>);
  view.unmount();render(<PeerReviewMonitor api={api} sessionId="s" activityId="b" onBack={()=>{}}/>);await screen.findByText("Frozen question");
  await act(async()=>finish({...summary,question_summary:"Stale activity"}));expect(screen.queryByText("Stale activity")).not.toBeInTheDocument();expect(api.statuses).toHaveBeenCalledTimes(1);
});
