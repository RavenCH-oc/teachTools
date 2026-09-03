import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionGroupingOverview } from "../../types/teacher";
import { SessionGroupingPage, type SessionGroupingApi } from "./SessionGroupingPage";

const overview = (activeDraft: SessionGroupingOverview["activeDraft"]): SessionGroupingOverview => ({
  sessionId: "session-1", classroomId: "class-1", sessionState: "ACTIVE",
  participants: [
    { participantId: "participant-1", studentId: "student-1", seatNumber: 1, displayName: "王小明", joinedAt: "now" },
    { participantId: "participant-2", studentId: "student-2", seatNumber: 2, displayName: "李小華", joinedAt: "now" },
  ], currentGroupSet: null, activeDraft,
});

function api(initial: SessionGroupingOverview, overrides: Partial<SessionGroupingApi> = {}): SessionGroupingApi {
  return {
    getSessionGrouping: vi.fn().mockResolvedValue(initial),
    listGroupPresets: vi.fn().mockResolvedValue([]),
    createGroupingDraftFromPreset: vi.fn().mockResolvedValue(initial),
    createRandomGroupingDraft: vi.fn().mockResolvedValue(initial),
    createManualGroupingDraft: vi.fn().mockResolvedValue(initial),
    cloneCurrentGroupingDraft: vi.fn().mockResolvedValue(initial),
    updateSessionGroupingDraft: vi.fn().mockResolvedValue(initial),
    openSessionGroupingDraft: vi.fn().mockResolvedValue(initial),
    moveSessionGroupingParticipant: vi.fn().mockResolvedValue(initial),
    cancelSessionGroupingDraft: vi.fn().mockResolvedValue(initial),
    finalizeSessionGroupingDraft: vi.fn().mockResolvedValue(initial),
    ...overrides,
  };
}

describe("SessionGroupingPage", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("hydrates directly from an ACTIVE session and edits a persisted draft", async () => {
    const draft = { id: "draft-1", sessionId: "session-1", state: "DRAFT" as const, createdAt: "now", updatedAt: "now", groups: [{ id: "group-1", name: "甲組", position: 0, capacity: null, participantIds: ["participant-1"] }] };
    const saved = overview({ ...draft, updatedAt: "later" });
    const update = vi.fn().mockResolvedValue(saved);
    const groupingApi = api(overview(draft), { updateSessionGroupingDraft: update });
    render(<SessionGroupingPage api={groupingApi} sessionId="session-1" onBack={vi.fn()} onDirtyChange={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "課堂分組" })).toBeInTheDocument();
    expect(screen.getByText("分組草稿")).toBeInTheDocument();
    expect(screen.queryByText("尚未建立目前分組或草稿。")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "第 1 組名稱" }), { target: { value: "新甲組" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存草稿" }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]?.[0]).toMatchObject({ draftId: "draft-1", groups: [{ name: "新甲組" }] });
  });

  it("creates a manual draft when no active draft exists", async () => {
    const created = overview({ id: "draft-2", sessionId: "session-1", state: "DRAFT", createdAt: "now", updatedAt: "now", groups: [] });
    const createManual = vi.fn().mockResolvedValue(created);
    const groupingApi = api(overview(null), { createManualGroupingDraft: createManual });
    render(<SessionGroupingPage api={groupingApi} sessionId="session-1" onBack={vi.fn()} onDirtyChange={vi.fn()} />);
    await screen.findByText("建立分組草稿");
    fireEvent.click(screen.getByRole("button", { name: "手動建立" }));
    await waitFor(() => expect(createManual).toHaveBeenCalledWith("session-1"));
    expect(await screen.findByText("分組草稿")).toBeInTheDocument();
  });

  it("opens a DRAFT for student selection and then uses only immediate participant moves", async () => {
    const draft = { id: "draft-3", sessionId: "session-1", state: "DRAFT" as const, createdAt: "now", updatedAt: "now", groups: [{ id: "group-1", name: "甲組", position: 0, capacity: 2, participantIds: [] }] };
    const openOverview = overview({ ...draft, state: "OPEN" });
    const open = vi.fn().mockResolvedValue(openOverview);
    const move = vi.fn().mockResolvedValue(openOverview);
    const groupingApi = api(overview(draft), { openSessionGroupingDraft: open, moveSessionGroupingParticipant: move });
    render(<SessionGroupingPage api={groupingApi} sessionId="session-1" onBack={vi.fn()} onDirtyChange={vi.fn()} />);

    await screen.findByText("分組草稿");
    fireEvent.click(screen.getByRole("button", { name: "開放學生選組" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("draft-3"));
    expect(await screen.findByText("學生自行選組已開放")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "儲存草稿" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "1 號 王小明 即時分組" }), { target: { value: "group-1" } });
    await waitFor(() => expect(move).toHaveBeenCalledWith({ draftId: "draft-3", participantId: "participant-1", targetGroupId: "group-1" }));
  });

  it("polls OPEN state after each completed request and stops when unmounted", async () => {
    vi.useFakeTimers();
    const draft = { id: "draft-4", sessionId: "session-1", state: "OPEN" as const, createdAt: "now", updatedAt: "now", groups: [{ id: "group-1", name: "甲組", position: 0, capacity: 2, participantIds: [] }] };
    let resolvePoll: ((value: SessionGroupingOverview) => void) | undefined;
    const getSessionGrouping = vi.fn()
      .mockResolvedValueOnce(overview(draft))
      .mockImplementationOnce(() => new Promise<SessionGroupingOverview>((resolve) => { resolvePoll = resolve; }))
      .mockResolvedValue(overview(draft));
    const groupingApi = api(overview(draft), { getSessionGrouping });
    const rendered = render(<SessionGroupingPage api={groupingApi} sessionId="session-1" onBack={vi.fn()} onDirtyChange={vi.fn()} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("學生自行選組已開放")).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(getSessionGrouping).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(getSessionGrouping).toHaveBeenCalledTimes(2);

    resolvePoll?.(overview(draft));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(getSessionGrouping).toHaveBeenCalledTimes(3);

    rendered.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(getSessionGrouping).toHaveBeenCalledTimes(3);
  });
});
