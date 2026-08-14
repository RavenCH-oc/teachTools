import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { TeacherApi } from "./types/teacher";

const mockApi = (overrides: Partial<TeacherApi> = {}): TeacherApi => ({
  getLocalDatabaseStatus: vi.fn().mockResolvedValue({ database_open: true, schema_version: 1, path_classification: "app_data" }),
  getLocalServerStatus: vi.fn().mockResolvedValue({ running: false, lifecycleState: "stopped", port: null, localUrl: null, serverInstanceId: null, candidateUrls: [], webSocketUrls: [], protocolVersion: 1 }),
  createLocalSession: vi.fn(), openLocalSessionLobby: vi.fn(), getActiveLocalSession: vi.fn().mockResolvedValue(null), endLocalSession: vi.fn(), listLocalSessionParticipants: vi.fn().mockResolvedValue([]),
  startLocalServer: vi.fn(), stopLocalServer: vi.fn(),
  listClassrooms: vi.fn().mockResolvedValue([]), createClassroom: vi.fn(), updateClassroom: vi.fn(), deleteClassroom: vi.fn(),
  listStudents: vi.fn().mockResolvedValue([]), createStudent: vi.fn(), updateStudent: vi.fn(), deleteStudent: vi.fn(),
  listCourses: vi.fn().mockResolvedValue([]), createCourse: vi.fn(), updateCourse: vi.fn(), deleteCourse: vi.fn(),
  listLessons: vi.fn().mockResolvedValue([]), listAllLessons: vi.fn().mockResolvedValue([]), createLesson: vi.fn(), updateLesson: vi.fn(), deleteLesson: vi.fn(),
  listQuestionSets: vi.fn().mockResolvedValue([]), getQuestionSet: vi.fn(), createQuestionSet: vi.fn(), updateQuestionSet: vi.fn(), deleteQuestionSet: vi.fn(),
  listQuestions: vi.fn().mockResolvedValue([]), getQuestion: vi.fn(), createQuestion: vi.fn(), updateQuestion: vi.fn(), deleteQuestion: vi.fn(), reorderQuestions: vi.fn(),
  listQuestionAssets: vi.fn().mockResolvedValue([]), importQuestionAsset: vi.fn(), deleteQuestionAsset: vi.fn(), getQuestionAssetPreview: vi.fn(), updateQuestionAssetPageReference: vi.fn(), ...overrides,
});

describe("Teacher basic data workspace", () => {
  it("renders navigation and local storage readiness", async () => {
    render(<App api={mockApi()} />);
    expect(screen.getByText("正在載入本機工作區…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("本機儲存空間已就緒")).toBeInTheDocument());
    expect(screen.getByRole("navigation", { name: "教師導覽" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "班級" })).toBeInTheDocument();
  });

  it("shows an empty classroom state and validates a blank create", async () => {
    render(<App api={mockApi()} />);
    await waitFor(() => screen.getByText("本機儲存空間已就緒"));
    within(screen.getByRole("navigation", { name: "教師導覽" })).getByRole("button", { name: "班級" }).click();
    await waitFor(() => expect(screen.getByRole("heading", { name: "班級" })).toBeInTheDocument());
    expect(screen.getByText("尚未建立班級。請建立第一個班級。")).toBeInTheDocument();
    screen.getByRole("button", { name: "建立班級" }).click();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("請輸入班級名稱。"));
  });

  it("clears a stale student seat validation error before rendering the participant lobby", async () => {
    const classroom = { id: "019fe920-0e14-7e30-8a9d-367f86c03bcc", name: "三年甲班", academic_year: null, created_at: "2026-08-11T00:00:00Z", updated_at: "2026-08-11T00:00:00Z" };
    const session = { id: "019fe91e-7606-7d00-aede-59c50a724f4d", classroomId: classroom.id, classroomName: classroom.name, serverInstanceId: "019fe91f-5d66-7e40-a01b-0a69f36caeff", state: "LOBBY" as const, joinMode: "roster_match" as const, joinCode: "AB7K9M2Q", createdAt: "2026-08-11T00:00:00Z", lobbyOpenedAt: "2026-08-11T00:00:00Z", endedAt: null, endedReason: null };
    const api = mockApi({
      listClassrooms: vi.fn().mockResolvedValue([classroom]),
      getLocalServerStatus: vi.fn().mockResolvedValue({ running: true, lifecycleState: "running", port: 49561, localUrl: "http://127.0.0.1:49561", serverInstanceId: session.serverInstanceId, candidateUrls: [], webSocketUrls: [], protocolVersion: 1 }),
      getActiveLocalSession: vi.fn().mockResolvedValue(session),
      listLocalSessionParticipants: vi.fn().mockResolvedValue([
        { participantId: "019fe921-2844-7a50-afd5-65ab3159f0e1", studentId: classroom.id, seatNumber: 1, displayName: "Test", joinedAt: "2026-08-11T00:00:00Z", online: true },
        { participantId: "019fe923-090a-7aa0-85dc-c216080117fa", studentId: classroom.id, seatNumber: 2, displayName: "T", joinedAt: "2026-08-11T00:00:00Z", online: false },
      ]),
    });
    render(<App api={api} />);
    await waitFor(() => screen.getByText("本機儲存空間已就緒"));
    const navigation = screen.getByRole("navigation", { name: "教師導覽" });
    within(navigation).getByRole("button", { name: "學生" }).click();
    await screen.findByRole("heading", { name: "學生" });
    screen.getByRole("button", { name: "新增學生" }).click();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("座號必須為正整數。"));

    within(navigation).getByRole("button", { name: "課堂" }).click();
    expect(await screen.findByText("1 號 Test")).toBeInTheDocument();
    expect(screen.getByText("2 號 T")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
