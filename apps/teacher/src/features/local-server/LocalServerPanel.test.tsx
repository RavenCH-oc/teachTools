import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LocalServerPanel } from "./LocalServerPanel";
import type { LocalServerStatus, TeacherApi } from "../../types/teacher";

const stopped: LocalServerStatus = {
  running: false, lifecycleState: "stopped", port: null, localUrl: null, serverInstanceId: null,
  candidateUrls: [], webSocketUrls: [], protocolVersion: 1,
};
const running: LocalServerStatus = {
  running: true, lifecycleState: "running", port: 41234, localUrl: "http://127.0.0.1:41234", serverInstanceId: "019b2af9-4fe6-7f2d-a5d5-711897ed2a31",
  candidateUrls: ["http://192.168.1.30:41234"], webSocketUrls: ["ws://127.0.0.1:41234/ws", "ws://192.168.1.30:41234/ws"], protocolVersion: 1,
};

function apiFixture(): TeacherApi {
  return {
    getLocalDatabaseStatus: vi.fn(), listClassrooms: vi.fn(), createClassroom: vi.fn(), updateClassroom: vi.fn(), deleteClassroom: vi.fn(),
    listStudents: vi.fn(), createStudent: vi.fn(), updateStudent: vi.fn(), deleteStudent: vi.fn(), listCourses: vi.fn(), createCourse: vi.fn(), updateCourse: vi.fn(), deleteCourse: vi.fn(),
    listLessons: vi.fn(), listAllLessons: vi.fn(), createLesson: vi.fn(), updateLesson: vi.fn(), deleteLesson: vi.fn(),
    listQuestionSets: vi.fn(), getQuestionSet: vi.fn(), createQuestionSet: vi.fn(), updateQuestionSet: vi.fn(), deleteQuestionSet: vi.fn(),
    listQuestions: vi.fn(), getQuestion: vi.fn(), createQuestion: vi.fn(), updateQuestion: vi.fn(), deleteQuestion: vi.fn(), reorderQuestions: vi.fn(),
    listQuestionAssets: vi.fn(), importQuestionAsset: vi.fn(), deleteQuestionAsset: vi.fn(), getQuestionAssetPreview: vi.fn(), updateQuestionAssetPageReference: vi.fn(),
    getLocalServerStatus: vi.fn().mockResolvedValue(stopped), startLocalServer: vi.fn().mockResolvedValue(running), stopLocalServer: vi.fn().mockResolvedValue(stopped),
    createLocalSession: vi.fn(), openLocalSessionLobby: vi.fn(), getActiveLocalSession: vi.fn().mockResolvedValue(null), endLocalSession: vi.fn(), listLocalSessionParticipants: vi.fn().mockResolvedValue([]),
  };
}

describe("LocalServerPanel", () => {
  it("does not start a listener automatically and renders diagnostics after an explicit start", async () => {
    const api = apiFixture();
    render(<LocalServerPanel api={api} />);
    await waitFor(() => expect(screen.getByText("伺服器目前未監聽任何連接埠，也沒有背景工作。")).toBeInTheDocument());
    expect(api.startLocalServer).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "啟動伺服器" }).click();
    await waitFor(() => expect(screen.getByText("http://192.168.1.30:41234")).toBeInTheDocument());
    expect(api.startLocalServer).toHaveBeenCalledTimes(1);
    expect(screen.getByText("ws://127.0.0.1:41234/ws")).toBeInTheDocument();
  });
});
