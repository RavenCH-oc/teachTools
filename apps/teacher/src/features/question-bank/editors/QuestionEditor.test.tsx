import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TeacherApi } from "../../../types/teacher";
import { QuestionEditor } from "./QuestionEditor";

const api = (): TeacherApi => ({
  getLocalDatabaseStatus: vi.fn(), listClassrooms: vi.fn(), createClassroom: vi.fn(), updateClassroom: vi.fn(), deleteClassroom: vi.fn(), listStudents: vi.fn(), createStudent: vi.fn(), updateStudent: vi.fn(), deleteStudent: vi.fn(), listCourses: vi.fn(), createCourse: vi.fn(), updateCourse: vi.fn(), deleteCourse: vi.fn(), listLessons: vi.fn(), listAllLessons: vi.fn(), createLesson: vi.fn(), updateLesson: vi.fn(), deleteLesson: vi.fn(), listQuestionSets: vi.fn(), getQuestionSet: vi.fn(), createQuestionSet: vi.fn(), updateQuestionSet: vi.fn(), deleteQuestionSet: vi.fn(), listQuestions: vi.fn(), getQuestion: vi.fn(), createQuestion: vi.fn(), updateQuestion: vi.fn(), deleteQuestion: vi.fn(), reorderQuestions: vi.fn(),
});

describe("Question editors", () => {
  beforeEach(() => { vi.spyOn(window, "confirm").mockReturnValue(true); });
  it("retains stable choice IDs when option text is edited", async () => {
    const createQuestion = vi.fn().mockResolvedValue({});
    render(<QuestionEditor api={apiWith({ createQuestion })} questionSetId="set-1" question={null} position={0} onSaved={vi.fn()} onCancel={vi.fn()} onError={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Question prompt"), { target: { value: "Choose" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Question type" }), { target: { value: "single_choice" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Option 1 text" }), { target: { value: "A" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Option 2 text" }), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "Create question" }));
    await waitFor(() => expect(createQuestion).toHaveBeenCalledWith(expect.objectContaining({ type: "single_choice", answerConfig: expect.objectContaining({ options: [{ id: expect.stringMatching(/^option-/), text: "A" }, { id: expect.stringMatching(/^option-/), text: "B" }], correctOptionId: expect.stringMatching(/^option-/) }) })));
    const saved = createQuestion.mock.calls[0]?.[0]; expect(saved.answerConfig.correctOptionId).toBe(saved.answerConfig.options[0].id);
  });

  it("rejects duplicate normalized fill blank answers", async () => {
    const onError = vi.fn();
    render(<QuestionEditor api={api()} questionSetId="set-1" question={null} position={0} onSaved={vi.fn()} onCancel={vi.fn()} onError={onError} />);
    fireEvent.change(screen.getByLabelText("Question prompt"), { target: { value: "Country" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Question type" }), { target: { value: "fill_blank" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Blank 1 accepted answer 1" }), { target: { value: "Taiwan" } });
    fireEvent.click(screen.getByRole("button", { name: "＋ Add accepted answer" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Blank 1 accepted answer 2" }), { target: { value: "TAIWAN" } });
    fireEvent.click(screen.getByRole("button", { name: "Create question" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("unique after normalization")));
  });
});

function apiWith(overrides: Partial<TeacherApi>): TeacherApi { return { ...api(), ...overrides }; }
