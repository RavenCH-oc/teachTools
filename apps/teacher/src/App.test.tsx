import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { TeacherApi } from "./types/teacher";

const mockApi = (overrides: Partial<TeacherApi> = {}): TeacherApi => ({
  getLocalDatabaseStatus: vi.fn().mockResolvedValue({ database_open: true, schema_version: 1, path_classification: "app_data" }),
  getLocalServerStatus: vi.fn().mockResolvedValue({ running: false, lifecycleState: "stopped", port: null, localUrl: null, serverInstanceId: null, candidateUrls: [], webSocketUrls: [], protocolVersion: 1 }),
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
    expect(screen.getByText("Loading local workspace…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Local storage ready")).toBeInTheDocument());
    expect(screen.getByRole("navigation", { name: "Teacher navigation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Classrooms" })).toBeInTheDocument();
  });

  it("shows an empty classroom state and validates a blank create", async () => {
    render(<App api={mockApi()} />);
    await waitFor(() => screen.getByText("Local storage ready"));
    within(screen.getByRole("navigation", { name: "Teacher navigation" })).getByRole("button", { name: "Classrooms" }).click();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Classrooms" })).toBeInTheDocument());
    expect(screen.getByText("No classrooms yet. Create your first group.")).toBeInTheDocument();
    screen.getByRole("button", { name: "Create classroom" }).click();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Classroom name is required."));
  });
});
