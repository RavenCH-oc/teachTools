import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteTeacherStatus } from "@classtools/backend-contract";
import type { Classroom } from "../../types/teacher";
import type { RemoteTeacherApi } from "../../services/remoteTeacherApi";
import { RemoteSessionPage } from "./RemoteSessionPage";

const classroom: Classroom = {
  id: "019fe920-0e14-7e30-8a9d-367f86c03bcc",
  name: "測試班級",
  academic_year: null,
  created_at: "2026-09-26T00:00:00Z",
  updated_at: "2026-09-26T00:00:00Z",
};

function fixture(initial: RemoteTeacherStatus) {
  let current = initial;
  const api: RemoteTeacherApi = {
    status: vi.fn(async () => current),
    enroll: vi.fn(async () => { current = { ...current, enrolled: true }; }),
    create: vi.fn(async () => {
      const session = { remoteSessionId: "a".repeat(32),
        localSessionId: "019fe91e-7606-7d00-aede-59c50a724f4d",
        joinUrl: `https://example.workers.dev/join/${"a".repeat(32)}`,
        expiresAt: Date.now() + 3600000, generation: null, state: "CONNECTING" as const };
      current = { ...current, session };
      return session;
    }),
    close: vi.fn(async () => { current = { ...current, session: null }; }),
  };
  return api;
}

describe("RemoteSessionPage", () => {
  afterEach(() => cleanup());

  it("keeps LAN availability visible when the relay URL is not configured", async () => {
    const api = fixture({ configured: false, enrolled: false, session: null });
    render(<RemoteSessionPage classrooms={[classroom]} api={api} />);
    expect(await screen.findByText(/本機課堂仍可使用/)).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });

  it("enrolls and creates then explicitly closes a Remote Session", async () => {
    const api = fixture({ configured: true, enrolled: false, session: null });
    render(<RemoteSessionPage classrooms={[classroom]} api={api} />);
    fireEvent.change(await screen.findByLabelText("啟用碼"), { target: { value: "test-code" } });
    fireEvent.click(screen.getByRole("button", { name: "啟用" }));
    await waitFor(() => expect(api.enroll).toHaveBeenCalledWith("test-code"));
    fireEvent.click(await screen.findByRole("button", { name: "建立 Remote Session" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(classroom.id));
    fireEvent.click(await screen.findByRole("button", { name: "關閉 Remote Session" }));
    await waitFor(() => expect(api.close).toHaveBeenCalledOnce());
  });

  it("opens the existing Quiz workspace from a Remote Session", async () => {
    const api = fixture({ configured: true, enrolled: true, session: null });
    const openQuiz = vi.fn();
    render(<RemoteSessionPage classrooms={[classroom]} api={api} onOpenLiveQuiz={openQuiz} />);
    fireEvent.click(await screen.findByRole("button", { name: "建立 Remote Session" }));
    fireEvent.click(await screen.findByRole("button", { name: "前往即時測驗" }));
    expect(openQuiz).toHaveBeenCalledOnce();
    expect(screen.queryByText(/不接受學生加入/)).not.toBeInTheDocument();
  });
});
