import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Classroom, SessionHistory, TeacherApi } from "../../types/teacher";
import { SessionHistoryPage } from "./SessionHistoryPage";

const classroom: Classroom = { id: "class-1", name: "三年甲班", academic_year: null, created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" };
const history: SessionHistory[] = [
  { sessionId: "session-new", classroomId: classroom.id, classroomName: classroom.name, state: "ENDED", createdAt: "2026-08-02T00:00:00Z", lobbyOpenedAt: null, endedAt: "2026-08-03T00:00:00Z", participantCount: 2, eligibleQuestionCount: 3 },
  { sessionId: "session-old", classroomId: classroom.id, classroomName: classroom.name, state: "ENDED", createdAt: "2026-08-01T00:00:00Z", lobbyOpenedAt: null, endedAt: "2026-08-02T00:00:00Z", participantCount: 1, eligibleQuestionCount: 1 },
];

describe("SessionHistoryPage", () => {
  it("loads only bounded classroom history and opens analysis", async () => {
    const api = { listClassroomSessionHistory: vi.fn().mockResolvedValue(history) } satisfies Required<Pick<TeacherApi, "listClassroomSessionHistory">>;
    const open = vi.fn();
    render(<SessionHistoryPage api={api} classrooms={[classroom]} onOpenSessionAnalysis={open} />);
    expect(await screen.findByText("已結束課堂")).toBeInTheDocument();
    expect(api.listClassroomSessionHistory).toHaveBeenCalledWith(classroom.id, 30, 0);
    const buttons = screen.getAllByRole("button", { name: "查看統計" });
    fireEvent.click(buttons[0]!);
    expect(open).toHaveBeenCalledWith(history[0]);
  });

  it("shows the empty state when the classroom has no ENDED sessions", async () => {
    const api = { listClassroomSessionHistory: vi.fn().mockResolvedValue([]) } satisfies Required<Pick<TeacherApi, "listClassroomSessionHistory">>;
    render(<SessionHistoryPage api={api} classrooms={[classroom]} onOpenSessionAnalysis={vi.fn()} />);
    expect(await screen.findByText("目前還沒有已完成的課堂紀錄。")).toBeInTheDocument();
  });

  it("supports bounded pagination without replacing earlier rows", async () => {
    const page = Array.from({ length: 30 }, (_, index) => ({ ...history[0], sessionId: `session-${index}` }));
    const api = { listClassroomSessionHistory: vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce([history[1]]) } satisfies Required<Pick<TeacherApi, "listClassroomSessionHistory">>;
    render(<SessionHistoryPage api={api} classrooms={[classroom]} onOpenSessionAnalysis={vi.fn()} />);
    await screen.findByText("已結束課堂");
    fireEvent.click(screen.getByRole("button", { name: "載入更多" }));
    await waitFor(() => expect(api.listClassroomSessionHistory).toHaveBeenLastCalledWith(classroom.id, 30, 30));
    expect(screen.getAllByRole("button", { name: "查看統計" })).toHaveLength(31);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("Session history query generations", () => {
  it.each(["success", "failure"])("ignores stale pagination %s after switching classroom", async (outcome) => {
    const oldPage = deferred<SessionHistory[]>();
    const newPage = deferred<SessionHistory[]>();
    const other = { ...classroom, id: "class-2", name: "三年乙班" };
    const page = Array.from({ length: 30 }, (_, index) => ({ ...history[0]!, sessionId: String(index) }));
    const api = { listClassroomSessionHistory: vi.fn().mockResolvedValueOnce(page).mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(newPage.promise) };
    render(<SessionHistoryPage api={api} classrooms={[classroom, other]} onOpenSessionAnalysis={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "載入更多" }));
    fireEvent.change(screen.getByLabelText("班級"), { target: { value: other.id } });
    await act(async () => {
      if (outcome === "success") oldPage.resolve([{ ...history[0]!, classroomName: "過期資料" }]);
      else oldPage.reject(new Error("obsolete failure"));
    });
    expect(screen.queryByText("過期資料")).not.toBeInTheDocument();
    expect(screen.queryByText("無法載入更多課堂紀錄。")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "載入中…" })).toBeDisabled();
    await act(async () => newPage.resolve([{ ...history[0]!, classroomId: other.id, classroomName: "目前資料" }]));
    expect(screen.getAllByRole("button", { name: "查看統計" })).toHaveLength(1);
    expect(screen.getByText("目前資料")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "載入更多" })).not.toBeInTheDocument();
  });

  it.each(["success", "failure"])("ignores stale pagination %s after reload", async (outcome) => {
    const oldPage = deferred<SessionHistory[]>();
    const freshPage = deferred<SessionHistory[]>();
    const page = Array.from({ length: 30 }, (_, index) => ({ ...history[0]!, sessionId: String(index) }));
    const api = { listClassroomSessionHistory: vi.fn().mockResolvedValueOnce(page).mockRejectedValueOnce(new Error("page failure")).mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(freshPage.promise).mockResolvedValue([]) };
    render(<SessionHistoryPage api={api} classrooms={[classroom]} onOpenSessionAnalysis={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "載入更多" }));
    await screen.findByText("無法載入更多課堂紀錄。");
    fireEvent.click(screen.getByRole("button", { name: "載入更多" }));
    fireEvent.click(screen.getByRole("button", { name: "重試" }));
    await act(async () => {
      if (outcome === "success") oldPage.resolve([{ ...history[0]!, classroomName: "過期資料" }]);
      else oldPage.reject(new Error("obsolete failure"));
    });
    expect(screen.queryByText("過期資料")).not.toBeInTheDocument();
    expect(screen.queryByText("無法載入更多課堂紀錄。")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "載入中…" })).toBeDisabled();
    await act(async () => freshPage.resolve(page));
    fireEvent.click(screen.getByRole("button", { name: "載入更多" }));
    expect(api.listClassroomSessionHistory).toHaveBeenLastCalledWith(classroom.id, 30, 30);
  });
});
