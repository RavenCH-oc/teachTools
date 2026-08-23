import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Question, QuestionSet } from "@classtools/domain";
import type { TeacherApi } from "../../types/teacher";
import { QuestionBankPage } from "./QuestionBankPage";

const set: QuestionSet = { id: "set-1", lessonId: null, title: "Fractions", description: null, createdAt: "now", updatedAt: "now" };
const trueFalse: Question = { id: "q-1", questionSetId: "set-1", type: "true_false", prompt: "2 + 2 = 4?", points: 1, position: 0, metadata: {}, configVersion: 1, createdAt: "now", updatedAt: "now", answerConfig: { correctAnswer: true } };

function mockApi(overrides: Partial<TeacherApi> = {}): TeacherApi {
  return {
    getLocalDatabaseStatus: vi.fn().mockResolvedValue({ database_open: true, schema_version: 1, path_classification: "app_data" }), getLocalServerStatus: vi.fn(), startLocalServer: vi.fn(), stopLocalServer: vi.fn(), createLocalSession: vi.fn(), openLocalSessionLobby: vi.fn(), getActiveLocalSession: vi.fn(), endLocalSession: vi.fn(), listLocalSessionParticipants: vi.fn(),
    listClassrooms: vi.fn().mockResolvedValue([]), createClassroom: vi.fn(), updateClassroom: vi.fn(), deleteClassroom: vi.fn(),
    listStudents: vi.fn().mockResolvedValue([]), createStudent: vi.fn(), updateStudent: vi.fn(), deleteStudent: vi.fn(),
    listCourses: vi.fn().mockResolvedValue([]), createCourse: vi.fn(), updateCourse: vi.fn(), deleteCourse: vi.fn(),
    listLessons: vi.fn().mockResolvedValue([]), listAllLessons: vi.fn().mockResolvedValue([]), createLesson: vi.fn(), updateLesson: vi.fn(), deleteLesson: vi.fn(),
    listQuestionSets: vi.fn().mockResolvedValue([set]), getQuestionSet: vi.fn(), createQuestionSet: vi.fn(), updateQuestionSet: vi.fn(), deleteQuestionSet: vi.fn(),
    listQuestions: vi.fn().mockResolvedValue([trueFalse]), getQuestion: vi.fn(), createQuestion: vi.fn(), createQuestionWithDraftAssets: vi.fn(), updateQuestion: vi.fn(), deleteQuestion: vi.fn(), reorderQuestions: vi.fn(),
    listQuestionAssets: vi.fn().mockResolvedValue([]), importQuestionAsset: vi.fn(), createQuestionDraft: vi.fn().mockResolvedValue({ id: "019fe923-090a-7aa0-85dc-c216080117fa" }), importQuestionDraftAsset: vi.fn(), deleteQuestionDraftAsset: vi.fn(), discardQuestionDraft: vi.fn(), deleteQuestionAsset: vi.fn(), getQuestionAssetPreview: vi.fn(), updateQuestionAssetPageReference: vi.fn(), ...overrides,
  };
}

describe("Question Bank feature", () => {
  it("renders the selected set, question, public preview, and teacher answer summary", async () => {
    render(<QuestionBankPage api={mockApi()} onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "建立與管理題組" })).toBeInTheDocument());
    expect(screen.getByText("Fractions")).toBeInTheDocument();
    const preview = await waitFor(() => screen.getByRole("region", { name: "教師預覽" }));
    expect(within(preview).getByRole("heading", { name: "2 + 2 = 4?" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "正確答案摘要" })).toHaveTextContent("正確");
    expect(preview).not.toHaveTextContent("正確答案：");
  });

  it("rejects an empty new question through shared validation", async () => {
    const onError = vi.fn();
    render(<QuestionBankPage api={mockApi({ listQuestions: vi.fn().mockResolvedValue([]) })} onError={onError} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "＋ 新增題目" })).toBeInTheDocument());
    screen.getByRole("button", { name: "＋ 新增題目" }).click();
    await waitFor(() => expect(screen.getByRole("button", { name: "建立題目" })).toBeInTheDocument());
    screen.getByRole("button", { name: "建立題目" }).click();
    await waitFor(() => expect(onError).toHaveBeenCalledWith("請輸入題目內容。"));
  });

  it("uses the typed reorder API for move controls", async () => {
    const second: Question = { ...trueFalse, id: "q-2", prompt: "Second", position: 1 };
    const reorderQuestions = vi.fn().mockResolvedValue([second, trueFalse]);
    render(<QuestionBankPage api={mockApi({ listQuestions: vi.fn().mockResolvedValue([trueFalse, second]), reorderQuestions })} onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Second")).toBeInTheDocument());
    screen.getByRole("button", { name: "將第 2 題上移" }).click();
    await waitFor(() => expect(reorderQuestions).toHaveBeenCalledWith("set-1", ["q-2", "q-1"]));
  });

  it("presents a friendly conflict when deleting a non-empty set", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onError = vi.fn();
    const deleteQuestionSet = vi.fn().mockRejectedValue({ code: "conflict" });
    render(<QuestionBankPage api={mockApi({ deleteQuestionSet })} onError={onError} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "刪除" })).toBeInTheDocument());
    screen.getByRole("button", { name: "刪除" }).click();
    await waitFor(() => expect(onError).toHaveBeenCalledWith("此題組仍包含題目，請先刪除題目。"));
  });

  it("creates a Question with its draft assets and then switches to persisted media editing", async () => {
    const created: Question = { ...trueFalse, id: "q-created", prompt: "新題目", position: 0 };
    const createQuestionWithDraftAssets = vi.fn().mockResolvedValue(created);
    const listQuestionAssets = vi.fn().mockResolvedValue([]);
    render(<QuestionBankPage api={mockApi({ listQuestions: vi.fn().mockResolvedValue([]), createQuestionWithDraftAssets, listQuestionAssets })} onError={vi.fn()} />);

    await screen.findByRole("button", { name: "＋ 新增題目" });
    fireEvent.click(screen.getByRole("button", { name: "＋ 新增題目" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "加入圖片" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("題目內容"), { target: { value: "新題目" } });
    fireEvent.click(screen.getByRole("button", { name: "建立題目" }));

    await waitFor(() => expect(createQuestionWithDraftAssets).toHaveBeenCalledWith(expect.objectContaining({ prompt: "新題目" }), "019fe923-090a-7aa0-85dc-c216080117fa"));
    await waitFor(() => expect(screen.getByRole("button", { name: "儲存變更" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "加入圖片" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "加入 PDF" })).toBeEnabled();
    expect(listQuestionAssets).toHaveBeenCalledWith("q-created");
  });

  it("requires the teacher to create or cancel a draft before switching Questions", async () => {
    const onError = vi.fn();
    render(<QuestionBankPage api={mockApi()} onError={onError} />);
    await screen.findByRole("button", { name: "＋ 新增題目" });
    fireEvent.click(screen.getByRole("button", { name: "＋ 新增題目" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "加入圖片" })).toBeEnabled());
    fireEvent.click(screen.getByText("2 + 2 = 4?"));

    expect(onError).toHaveBeenCalledWith("請先建立或取消目前的題目草稿，再切換題目或離開題庫。");
    expect(screen.getByRole("heading", { name: "建立題目" })).toBeInTheDocument();
  });
});
