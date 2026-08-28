import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
    cancelSessionGroupingDraft: vi.fn().mockResolvedValue(initial),
    finalizeSessionGroupingDraft: vi.fn().mockResolvedValue(initial),
    ...overrides,
  };
}

describe("SessionGroupingPage", () => {
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
});
