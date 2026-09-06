import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeerReviewPage } from "./PeerReviewPage";
import { draftFixture, reviewApiFixture, setupFixture } from "./testFixtures";

afterEach(()=>vi.restoreAllMocks());
async function ready(context=setupFixture()) {
  const api=reviewApiFixture(context);
  const props={api,sessionId:context.session_id,onBack:vi.fn(),onDirtyChange:vi.fn()};
  const view=render(<PeerReviewPage {...props}/>);
  await screen.findByLabelText("互評方式");return {context,api,props,...view};
}
describe("Teacher Peer Review setup",()=>{
  it("loads one context, saves a draft, rehydrates after remount, then opens and closes",async()=>{
    vi.spyOn(window,"confirm").mockReturnValue(true);
    const {api,props,unmount}=await ready();
    expect(api.getPeerReviewSetupContext).toHaveBeenCalledTimes(1);
    expect(screen.getByText("同儕互評只作為回饋紀錄，不計入正式成績。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"儲存草稿"}));
    await screen.findByRole("button",{name:"開放互評"});
    unmount();render(<PeerReviewPage {...props}/>);
    fireEvent.click(await screen.findByRole("button",{name:"開放互評"}));
    await screen.findByRole("button",{name:"結束互評"});
    expect(screen.getByLabelText("互評方式")).toBeDisabled();
    expect(screen.getByText("已固定作品：3")).toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"取消活動"})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"結束互評"}));
    await screen.findByRole("heading",{name:"活動設定 — 已結束"});
    expect(screen.queryByRole("button",{name:"開放互評"})).not.toBeInTheDocument();
  });
  it.each([0,1,2])("uses authoritative eligibility %i for random preflight",async count=>{
    const c=setupFixture();c.questions[0]!.eligible_participant_count=count;c.activities=[draftFixture()];
    await ready(c);expect(screen.getByRole("button",{name:"開放互評"})).toHaveProperty("disabled",count<2);
  });
  it.each([1,3,null])("persists Student Select capacity %s",async capacity=>{
    const {api}=await ready();
    fireEvent.change(screen.getByLabelText("互評方式"),{target:{value:"STUDENT_SELECT"}});
    if(capacity===null)fireEvent.click(screen.getByLabelText("不限"));
    else fireEvent.change(screen.getByLabelText("每份作品最多可收到幾份評論"),{target:{value:String(capacity)}});
    fireEvent.click(screen.getByRole("button",{name:"儲存草稿"}));
    await screen.findByRole("button",{name:"儲存設定"});
    expect(api.createPeerReviewActivity).toHaveBeenCalledWith(expect.objectContaining({mode:"STUDENT_SELECT",max_reviews_per_target:capacity}));
    expect(screen.getByText("第一版每位學生最多選擇 1 份作品進行互評。")).toBeInTheDocument();
  });
  it.each(["0","-1","9007199254740992","1.5"])("rejects capacity %s without IPC",async value=>{
    const {api}=await ready();fireEvent.change(screen.getByLabelText("互評方式"),{target:{value:"STUDENT_SELECT"}});
    fireEvent.change(screen.getByLabelText("每份作品最多可收到幾份評論"),{target:{value}});
    expect(screen.getByRole("button",{name:"儲存草稿"})).toBeDisabled();expect(api.createPeerReviewActivity).not.toHaveBeenCalled();
  });
  it("defaults to current grouping and preserves historical selection on OPEN",async()=>{
    vi.spyOn(window,"confirm").mockReturnValue(true);
    const {api}=await ready();fireEvent.change(screen.getByLabelText("互評方式"),{target:{value:"CROSS_GROUP"}});
    expect(screen.getByLabelText("分組版本")).toHaveValue("set-2");
    expect(screen.getByText("第三組 — 無可用作品")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("分組版本"),{target:{value:"set-1"}});
    fireEvent.click(screen.getByRole("button",{name:"儲存草稿"}));
    fireEvent.click(await screen.findByRole("button",{name:"開放互評"}));
    await screen.findByRole("button",{name:"結束互評"});
    expect(api.createPeerReviewActivity).toHaveBeenCalledWith(expect.objectContaining({session_group_set_id:"set-1"}));
    expect(screen.getByLabelText("分組版本")).toHaveValue("set-1");expect(screen.getByLabelText("分組版本")).toBeDisabled();
  });
  it.each([0,1])("blocks cross-group preflight with %i eligible groups",async count=>{
    const c=setupFixture();c.activities=[{...draftFixture(),mode:"CROSS_GROUP",session_group_set_id:"set-2"}];c.group_sets[0]!.questions[0]!.eligible_group_count=count;
    await ready(c);expect(screen.getByRole("button",{name:"開放互評"})).toBeDisabled();
    expect(screen.getByText("至少需要 2 個具有論述答案的組別。")).toBeInTheDocument();
  });
  it("requires a finalized group set",async()=>{
    const c=setupFixture();c.group_sets=[];await ready(c);
    fireEvent.change(screen.getByLabelText("互評方式"),{target:{value:"CROSS_GROUP"}});
    expect(screen.getByRole("button",{name:"儲存草稿"})).toBeDisabled();
    expect(screen.getByText("目前沒有已完成的分組版本，請先完成課堂分組。")).toBeInTheDocument();
  });
  it("protects dirty activity/question switching and clears dirty only after authoritative save",async()=>{
    const c=setupFixture();c.activities=[draftFixture(),{...draftFixture(),id:"second",session_question_id:"other"}];
    const confirm=vi.spyOn(window,"confirm").mockReturnValue(false);const {api,props}=await ready(c);
    fireEvent.change(screen.getByLabelText("互評方式"),{target:{value:"STUDENT_SELECT"}});
    fireEvent.click(screen.getByRole("button",{name:/2\. 另一題/}));expect(screen.getByLabelText("論述題目")).toHaveValue("essay");
    fireEvent.change(screen.getByLabelText("論述題目"),{target:{value:"other"}});expect(screen.getByLabelText("論述題目")).toHaveValue("essay");
    expect(confirm).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button",{name:"儲存設定"}));
    await waitFor(()=>expect(props.onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(api.updatePeerReviewActivityDraft).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:/2\. 另一題/}));expect(screen.getByLabelText("論述題目")).toHaveValue("other");expect(confirm).toHaveBeenCalledTimes(2);
  });
  it("cancels DRAFT and refreshes ended sessions as read-only",async()=>{
    vi.spyOn(window,"confirm").mockReturnValue(true);
    const c=setupFixture();c.activities=[draftFixture()];await ready(c);
    fireEvent.click(screen.getByRole("button",{name:"取消活動"}));await screen.findByRole("heading",{name:"活動設定 — 已取消"});
    c.session_state="ENDED";fireEvent.click(screen.getByRole("button",{name:"重新載入"}));
    await screen.findByText("課堂已結束或尚未開始，互評設定僅供檢視。");
    expect(screen.queryByRole("button",{name:"建立互評活動"})).not.toBeInTheDocument();expect(screen.getByLabelText("互評方式")).toBeDisabled();
  });
  it("reloads after a concurrent Session End rejects an operation",async()=>{
    const c=setupFixture();c.activities=[draftFixture()];const {api}=await ready(c);
    vi.mocked(api.updatePeerReviewActivityDraft).mockImplementationOnce(async()=>{c.session_state="ENDED";c.activities[0]!.state="CANCELLED";throw new Error("課堂已結束，無法再修改互評活動。");});
    fireEvent.change(screen.getByLabelText("互評方式"),{target:{value:"STUDENT_SELECT"}});fireEvent.click(screen.getByRole("button",{name:"儲存設定"}));
    await screen.findByRole("heading",{name:"活動設定 — 已取消"});expect(screen.getByLabelText("互評方式")).toBeDisabled();
  });
  it("does not replace fixed target count when current submission count increases",async()=>{
    const c=setupFixture();c.activities=[{...draftFixture(),state:"OPEN",frozen_target_count:2}];await ready(c);
    c.questions[0]!.eligible_participant_count=9;fireEvent.click(screen.getByRole("button",{name:"重新載入"}));
    await waitFor(()=>expect(screen.getByRole("button",{name:"重新載入"})).toBeEnabled());
    expect(screen.getByText("已固定作品：2")).toBeInTheDocument();expect(screen.queryByText(/可參與互評：/)).not.toBeInTheDocument();
  });
});
