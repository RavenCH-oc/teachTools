import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Question, QuestionSet } from "@classtools/domain";
import type { TeacherApi } from "../../types/teacher";
import { QuestionBankPage } from "./QuestionBankPage";

const set: QuestionSet = { id: "set-1", lessonId: null, title: "Fractions", description: null, createdAt: "now", updatedAt: "now" };
const trueFalse: Question = { id: "q-1", questionSetId: "set-1", type: "true_false", prompt: "2 + 2 = 4?", points: 1, position: 0, metadata: {}, configVersion: 1, createdAt: "now", updatedAt: "now", answerConfig: { correctAnswer: true } };

function mockApi(overrides: Partial<TeacherApi> = {}): TeacherApi {
  return {
    getLocalDatabaseStatus: vi.fn().mockResolvedValue({ database_open: true, schema_version: 1, path_classification: "app_data" }), getLocalServerStatus: vi.fn(), startLocalServer: vi.fn(), stopLocalServer: vi.fn(),
    listClassrooms: vi.fn().mockResolvedValue([]), createClassroom: vi.fn(), updateClassroom: vi.fn(), deleteClassroom: vi.fn(),
    listStudents: vi.fn().mockResolvedValue([]), createStudent: vi.fn(), updateStudent: vi.fn(), deleteStudent: vi.fn(),
    listCourses: vi.fn().mockResolvedValue([]), createCourse: vi.fn(), updateCourse: vi.fn(), deleteCourse: vi.fn(),
    listLessons: vi.fn().mockResolvedValue([]), listAllLessons: vi.fn().mockResolvedValue([]), createLesson: vi.fn(), updateLesson: vi.fn(), deleteLesson: vi.fn(),
    listQuestionSets: vi.fn().mockResolvedValue([set]), getQuestionSet: vi.fn(), createQuestionSet: vi.fn(), updateQuestionSet: vi.fn(), deleteQuestionSet: vi.fn(),
    listQuestions: vi.fn().mockResolvedValue([trueFalse]), getQuestion: vi.fn(), createQuestion: vi.fn(), updateQuestion: vi.fn(), deleteQuestion: vi.fn(), reorderQuestions: vi.fn(),
    listQuestionAssets: vi.fn().mockResolvedValue([]), importQuestionAsset: vi.fn(), deleteQuestionAsset: vi.fn(), getQuestionAssetPreview: vi.fn(), updateQuestionAssetPageReference: vi.fn(), ...overrides,
  };
}

describe("Question Bank feature", () => {
  it("renders the selected set, question, public preview, and teacher answer summary", async () => {
    render(<QuestionBankPage api={mockApi()} onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Build question sets with confidence." })).toBeInTheDocument());
    expect(screen.getByText("Fractions")).toBeInTheDocument();
    const preview = await waitFor(() => screen.getByRole("region", { name: "Teacher preview" }));
    expect(within(preview).getByRole("heading", { name: "2 + 2 = 4?" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Correct answer summary" })).toHaveTextContent("True");
    expect(preview).not.toHaveTextContent("Correct answer");
  });

  it("rejects an empty new question through shared validation", async () => {
    const onError = vi.fn();
    render(<QuestionBankPage api={mockApi({ listQuestions: vi.fn().mockResolvedValue([]) })} onError={onError} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "＋ New question" })).toBeInTheDocument());
    screen.getByRole("button", { name: "＋ New question" }).click();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create question" })).toBeInTheDocument());
    screen.getByRole("button", { name: "Create question" }).click();
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("prompt")));
  });

  it("uses the typed reorder API for move controls", async () => {
    const second: Question = { ...trueFalse, id: "q-2", prompt: "Second", position: 1 };
    const reorderQuestions = vi.fn().mockResolvedValue([second, trueFalse]);
    render(<QuestionBankPage api={mockApi({ listQuestions: vi.fn().mockResolvedValue([trueFalse, second]), reorderQuestions })} onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Second")).toBeInTheDocument());
    screen.getByRole("button", { name: "Move 2 up" }).click();
    await waitFor(() => expect(reorderQuestions).toHaveBeenCalledWith("set-1", ["q-2", "q-1"]));
  });

  it("presents a friendly conflict when deleting a non-empty set", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onError = vi.fn();
    const deleteQuestionSet = vi.fn().mockRejectedValue({ code: "conflict" });
    render(<QuestionBankPage api={mockApi({ deleteQuestionSet })} onError={onError} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument());
    screen.getByRole("button", { name: "Delete" }).click();
    await waitFor(() => expect(onError).toHaveBeenCalledWith("This Question Set still contains questions. Delete the questions first."));
  });
});
