import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerReviewActivity, PeerReviewMutation } from "@classtools/backend-contract";
import * as api from "../../services/peerReviewApi";
import type { StoredParticipant } from "../../services/studentApi";
import { PeerReviewPanel } from "./PeerReviewPanel";
import { createPeerSessionChannel } from "./sessionChannel";
import { peerStorage } from "./storage";
vi.mock("../../services/peerReviewApi", () => ({ getPeerReviewActivities: vi.fn(), getPeerReviewActivity: vi.fn(), getPeerReviewCandidates: vi.fn(), getPeerReviewEssays: vi.fn(), getOwnPeerReview: vi.fn(), getPeerReviewFeedback: vi.fn(), getPeerReviewFeedbackDetail: vi.fn() }));
const id = (n: number) => `019fe920-0e14-7e30-8a9d-${String(n).padStart(12, "0")}`;
const participant: StoredParticipant = { sessionId: id(1), participantId: id(2), serverInstanceId: id(3), credential: "A".repeat(43), participant: { participantId: id(2), sessionId: id(1), seatNumber: 1, displayName: "Test" } };
let activity: PeerReviewActivity;
let own: Awaited<ReturnType<typeof api.getOwnPeerReview>>;
let channel: ReturnType<typeof createPeerSessionChannel>;
let send: ReturnType<typeof vi.fn<(message: PeerReviewMutation) => "sent">>;
const envelope = { protocolVersion: 1 as const };
function sync() { channel.emit({ type: "message", generation: channel.snapshot().generation, message: { ...envelope, type: "session_sync", sync: { sessionState: "ACTIVE", currentQuestion: null, reveal: null, ownLatestSubmission: null, peerReview: { available: true, visibleActivityCount: 1, receivedFeedbackCount: 0 } } } }); }
function change() { act(() => channel.emit({ type: "message", generation: channel.snapshot().generation, message: { ...envelope, type: "peer_review_changed" } })); }
function mount() { return render(<PeerReviewPanel participant={participant} channel={channel} send={send} />); }
async function open() { fireEvent.click(await screen.findByRole("button", { name: "同儕互評" })); fireEvent.click(await screen.findByRole("button", { name: "開啟活動" })); }
async function editor() { const field = await screen.findByLabelText("評論內容"); await waitFor(() => expect(field).not.toHaveAttribute("readonly")); return field; }
function lastSubmit() { const message = send.mock.calls.at(-1)?.[0]; if (message?.type !== "submit_peer_review") throw new Error("submit expected"); return message; }
function ack(message: ReturnType<typeof lastSubmit>, revision = 1, generation = channel.snapshot().generation) { act(() => channel.emit({ type: "message", generation, message: { ...envelope, type: "peer_review_acknowledged", requestId: message.requestId, acknowledgement: { assignmentId: message.assignmentId, reviewSubmissionId: message.reviewSubmissionId, revision } } })); }
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  activity = { activityId: id(4), sessionQuestionId: id(5), assignmentId: id(6), mode: "RANDOM_ONE_TO_ONE", state: "OPEN", questionSummary: "說明你的觀點", receivedFeedbackCount: 0, latestReviewRevision: null, reviewerGroupLabel: null, targetGroupLabel: null };
  own = null;
  channel = createPeerSessionChannel(); channel.emit({ type: "connection", generation: 1, online: true }); sync();
  send = vi.fn(() => "sent");
  vi.mocked(api.getPeerReviewActivities).mockImplementation(async () => ({ items: [{ ...activity }], nextCursor: null }));
  vi.mocked(api.getPeerReviewActivity).mockImplementation(async () => ({ items: [{ ...activity }], nextCursor: null }));
  vi.mocked(api.getOwnPeerReview).mockImplementation(async () => own);
  vi.mocked(api.getPeerReviewEssays).mockResolvedValue({ items: [{ peerReviewTargetId: id(7), label: "作品作者", essay: "Frozen essay" }], nextCursor: null });
  vi.mocked(api.getPeerReviewCandidates).mockResolvedValue({ items: [{ peerReviewTargetId: id(8), label: "另一份作品", submittedReviewCount: 0, hasReceivedAnyReview: false, remainingCapacity: 3, full: false, currentClaim: false }], nextCursor: null });
  vi.mocked(api.getPeerReviewFeedback).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(api.getPeerReviewFeedbackDetail).mockResolvedValue({ assignmentId: id(20), revision: 2, body: "匿名最新回饋" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("Student Peer Review S2", () => {
  it("pages a Cross Group bundle without changing its shared editor or frozen labels", async () => {
    activity.mode = "CROSS_GROUP"; activity.reviewerGroupLabel = "原甲組"; activity.targetGroupLabel = "原乙組";
    own = { assignmentId: id(6), revision: 2, body: "共享評論" };
    vi.mocked(api.getPeerReviewEssays).mockImplementation(async (_p, _id, options) => ({ items: [{ peerReviewTargetId: options?.cursor ? id(9) : id(7), label: options?.cursor ? "第二頁作者" : "第一頁作者", essay: options?.cursor ? "Second frozen essay" : "First frozen essay" }], nextCursor: options?.cursor ? null : "bundle-next" }));
    mount(); await open(); fireEvent.change(await editor(), { target: { value: "共享未送出文字" } });
    expect(screen.getByText("我的組別：原甲組／互評對象：原乙組")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "下一頁" }).find(button => !button.hasAttribute("disabled"))!);
    await screen.findByText("Second frozen essay"); expect(await editor()).toHaveValue("共享未送出文字");
    expect(api.getPeerReviewEssays).toHaveBeenCalledWith(participant, id(6), expect.objectContaining({ cursor: "bundle-next" }));
  });
  it("ignores a stale candidate response and stale invalidation after reconnect", async () => {
    activity.mode = "STUDENT_SELECT"; activity.assignmentId = null;
    let finishOld: (value: Awaited<ReturnType<typeof api.getPeerReviewCandidates>>) => void = () => { throw new Error("request not started"); };
    vi.mocked(api.getPeerReviewCandidates).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    mount(); await open(); await waitFor(() => expect(api.getPeerReviewCandidates).toHaveBeenCalledTimes(1));
    act(() => channel.emit({ type: "connection", generation: 2, online: true }));
    await screen.findByText("另一份作品");
    await act(async () => { finishOld({ items: [{ peerReviewTargetId: id(99), label: "過時作品", submittedReviewCount: 0, hasReceivedAnyReview: false, full: false, remainingCapacity: null, currentClaim: false }], nextCursor: "obsolete" }); });
    expect(screen.queryByText("過時作品")).not.toBeInTheDocument();
    const calls = vi.mocked(api.getPeerReviewCandidates).mock.calls.length;
    act(() => channel.emit({ type: "message", generation: 1, message: { ...envelope, type: "peer_review_changed" } }));
    expect(api.getPeerReviewCandidates).toHaveBeenCalledTimes(calls);
  });
  it("discards Activity A late HTTP completion after switching to Activity B", async () => {
    const first = { ...activity };
    const second = { ...activity, activityId: id(30), assignmentId: id(31), questionSummary: "第二個活動" };
    vi.mocked(api.getPeerReviewActivities).mockResolvedValue({ items: [first, second], nextCursor: null });
    vi.mocked(api.getPeerReviewActivity).mockImplementation(async (_p, requested) => ({ items: [requested === first.activityId ? first : second], nextCursor: null }));
    let finishA: (value: Awaited<ReturnType<typeof api.getPeerReviewFeedback>>) => void = () => { throw new Error("request not started"); };
    vi.mocked(api.getPeerReviewFeedback).mockImplementation((_p, options) => options?.activityId === first.activityId ? new Promise(resolve => { finishA = resolve; }) : Promise.resolve({ items: [{ activityId: second.activityId, assignmentId: id(32), revision: 3 }], nextCursor: null }));
    mount(); fireEvent.click(await screen.findByRole("button", { name: "同儕互評" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "開啟活動" }))[0]!);
    await waitFor(() => expect(api.getPeerReviewFeedback).toHaveBeenCalledWith(participant, expect.objectContaining({ activityId: first.activityId })));
    fireEvent.click(screen.getByRole("button", { name: "返回活動列表" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "開啟活動" }))[1]!);
    await screen.findByRole("button", { name: "同學回饋 1 · 第 3 版" });
    await act(async () => { finishA({ items: [{ activityId: first.activityId, assignmentId: id(33), revision: 99 }], nextCursor: null }); });
    expect(screen.queryByRole("button", { name: "同學回饋 1 · 第 99 版" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "同學回饋 1 · 第 3 版" })).toBeInTheDocument();
  });
  it.each(["RANDOM_ONE_TO_ONE", "STUDENT_SELECT", "CROSS_GROUP"] as const)("restores %s draft after navigation and hard remount without changing assignment", async mode => {
    activity.mode = mode; if (mode === "CROSS_GROUP") { activity.reviewerGroupLabel = "原甲組"; activity.targetGroupLabel = "原乙組"; }
    const first = mount(); await open(); fireEvent.change(await editor(), { target: { value: "我的未送出草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "返回活動列表" })); fireEvent.click(await screen.findByRole("button", { name: "開啟活動" }));
    expect(await editor()).toHaveValue("我的未送出草稿"); first.unmount();
    mount(); await open(); expect(await editor()).toHaveValue("我的未送出草稿");
    expect(screen.getByText("Frozen essay")).toBeInTheDocument(); expect(send).not.toHaveBeenCalled();
  });
  it("persists pending before send, acknowledges rev1/rev2 and does not resurrect the old draft", async () => {
    send.mockImplementation(message => { if (message.type === "submit_peer_review") expect(peerStorage(participant).pending()[0]?.reviewSubmissionId).toBe(message.reviewSubmissionId); return "sent"; });
    const view = mount(); await open(); fireEvent.change(await editor(), { target: { value: "  first  " } }); fireEvent.click(screen.getByRole("button", { name: "送出評論" }));
    const first = lastSubmit(); expect(first.body).toBe("first"); expect(screen.getByLabelText("評論內容")).toHaveAttribute("readonly");
    own = { assignmentId: id(6), revision: 1, body: "first" }; activity.latestReviewRevision = 1; ack(first);
    await waitFor(() => expect(peerStorage(participant).pending()).toHaveLength(0)); expect(peerStorage(participant).draft(id(4), id(6))).toBeNull();
    fireEvent.change(await editor(), { target: { value: "second" } }); fireEvent.click(screen.getByRole("button", { name: "送出評論" })); const second = lastSubmit();
    expect(second.expectedBaseRevision).toBe(1); expect(second.reviewSubmissionId).not.toBe(first.reviewSubmissionId);
    own = { assignmentId: id(6), revision: 2, body: "second" }; activity.latestReviewRevision = 2; ack(second, 2); view.unmount();
    mount(); await open(); expect(await editor()).toHaveValue("second"); expect(peerStorage(participant).pending()).toHaveLength(0);
  });
  it("replays the exact pending ID after reconnect and CLOSED, ignores an old ACK", async () => {
    mount(); await open(); fireEvent.change(await editor(), { target: { value: "lost ACK" } }); fireEvent.click(screen.getByRole("button", { name: "送出評論" })); const submitted = lastSubmit();
    act(() => channel.emit({ type: "connection", online: false, generation: 1 })); activity.state = "CLOSED";
    act(() => channel.emit({ type: "connection", online: true, generation: 2 }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2)); expect(lastSubmit()).toEqual(submitted);
    ack(submitted, 1, 1); expect(peerStorage(participant).pending()).toHaveLength(1);
    own = { assignmentId: id(6), revision: 1, body: "lost ACK" }; ack(submitted, 1, 2);
    await waitFor(() => expect(peerStorage(participant).pending()).toHaveLength(0)); expect(screen.getByRole("button", { name: "送出評論" })).toBeDisabled();
  });
  it.each(["RANDOM_ONE_TO_ONE", "CROSS_GROUP"] as const)("preserves %s stale draft and confirms load-latest", async mode => {
    activity.mode = mode; mount(); await open(); fireEvent.change(await editor(), { target: { value: "保留文字" } }); fireEvent.click(screen.getByRole("button", { name: "送出評論" })); const sent = lastSubmit();
    own = { assignmentId: id(6), revision: 2, body: "伺服器新版" }; activity.latestReviewRevision = 2;
    act(() => channel.emit({ type: "message", generation: 1, message: { ...envelope, type: "peer_review_rejected", requestId: sent.requestId, code: "REVIEW_REVISION_CONFLICT" } }));
    await screen.findByText("這份評論已被更新，你目前的草稿是基於較舊版本。"); expect(screen.getByLabelText("評論內容")).toHaveValue("保留文字");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false); fireEvent.click(screen.getByRole("button", { name: "載入最新版本" })); expect(screen.getByLabelText("評論內容")).toHaveValue("保留文字");
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole("button", { name: "載入最新版本" })); expect(screen.getByLabelText("評論內容")).toHaveValue("伺服器新版");
  });
  it("retains an unsent draft on live CLOSE without calling submit", async () => {
    mount(); await open(); fireEvent.change(await editor(), { target: { value: "尚未送出" } }); activity.state = "CLOSED"; change();
    await screen.findByText("活動已結束，這份草稿未送出。"); expect(screen.getByLabelText("評論內容")).toHaveValue("尚未送出"); expect(screen.getByRole("button", { name: "送出評論" })).toBeDisabled(); expect(send).not.toHaveBeenCalled();
  });
  it("renders capacity independently of received count and fetches candidate pages only on demand", async () => {
    activity.mode = "STUDENT_SELECT"; activity.assignmentId = null;
    vi.mocked(api.getPeerReviewCandidates).mockResolvedValueOnce({ items: [{ peerReviewTargetId: id(8), label: "滿額作品", submittedReviewCount: 0, hasReceivedAnyReview: false, remainingCapacity: 0, full: true, currentClaim: false }, { peerReviewTargetId: id(9), label: "不限作品", submittedReviewCount: 1, hasReceivedAnyReview: true, remainingCapacity: null, full: false, currentClaim: false }], nextCursor: "next" });
    mount(); await open(); await screen.findByText("尚未收到評論"); expect(screen.getByText("名額已滿")).toBeInTheDocument(); expect(screen.getByText("評論名額：不限")).toBeInTheDocument(); expect(api.getPeerReviewCandidates).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("button", { name: "下一頁" }).find(b => !b.hasAttribute("disabled")) ?? document.body);
    await waitFor(() => expect(api.getPeerReviewCandidates).toHaveBeenCalledWith(participant, id(4), expect.objectContaining({ cursor: "next" })));
    change(); await waitFor(() => expect(vi.mocked(api.getPeerReviewCandidates).mock.calls.at(-1)?.[2]?.cursor).toBeUndefined());
  });
  it("confirms dirty moves, preserves failed drafts, and clears only on authoritative move ACK", async () => {
    activity.mode = "STUDENT_SELECT"; mount(); await open(); fireEvent.change(await editor(), { target: { value: "old draft" } }); fireEvent.click(screen.getByRole("button", { name: "更換對象" }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false); fireEvent.click(await screen.findByRole("button", { name: "選擇這份作品" })); expect(send).not.toHaveBeenCalled();
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole("button", { name: "選擇這份作品" })); const request = send.mock.calls.at(-1)?.[0]; if (!request) throw new Error("claim");
    act(() => channel.emit({ type: "message", generation: 1, message: { ...envelope, type: "peer_review_rejected", requestId: request.requestId, code: "TARGET_REVIEW_CAPACITY_FULL" } }));
    await screen.findByText("這份作品的互評名額剛剛已滿，請選擇其他作品。"); expect(screen.getByLabelText("評論內容")).toHaveValue("old draft");
    await waitFor(() => expect(screen.getByRole("button", { name: "選擇這份作品" })).not.toBeDisabled()); fireEvent.click(screen.getByRole("button", { name: "選擇這份作品" })); const retry = send.mock.calls.at(-1)?.[0]; if (!retry) throw new Error("claim retry");
    vi.mocked(api.getPeerReviewEssays).mockResolvedValue({ items: [{ peerReviewTargetId: id(8), label: "新作品", essay: "New essay" }], nextCursor: null });
    act(() => channel.emit({ type: "message", generation: 1, message: { ...envelope, type: "peer_review_acknowledged", requestId: retry.requestId, acknowledgement: { assignmentId: id(6), reviewSubmissionId: null, revision: 0 } } }));
    await screen.findByText("New essay"); expect(await editor()).toHaveValue(""); expect(peerStorage(participant).draft(id(4), id(6))).toBeNull();
  });
  it("uses scoped latest-only anonymous feedback and retains an open detail during invalidation", async () => {
    activity.receivedFeedbackCount = 2;
    vi.mocked(api.getPeerReviewFeedback).mockResolvedValue({ items: [{ assignmentId: id(20), activityId: id(4), revision: 2 }, { assignmentId: id(21), activityId: id(4), revision: 1 }], nextCursor: null });
    mount(); await open(); fireEvent.click(await screen.findByRole("button", { name: "同學回饋 1 · 第 2 版" })); await screen.findByText("匿名最新回饋");
    change(); expect(screen.getByText("匿名最新回饋")).toBeInTheDocument(); expect(api.getPeerReviewFeedback).toHaveBeenCalledWith(participant, expect.objectContaining({ activityId: id(4) })); expect(screen.queryByText(id(20))).not.toBeInTheDocument();
  });
});
