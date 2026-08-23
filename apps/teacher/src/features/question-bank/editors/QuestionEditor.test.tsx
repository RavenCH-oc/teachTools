import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TeacherApi } from "../../../types/teacher";
import { QuestionEditor } from "./QuestionEditor";

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));

const api = (): TeacherApi => ({
  getLocalDatabaseStatus: vi.fn(), getLocalServerStatus: vi.fn(), startLocalServer: vi.fn(), stopLocalServer: vi.fn(), createLocalSession: vi.fn(), openLocalSessionLobby: vi.fn(), getActiveLocalSession: vi.fn(), endLocalSession: vi.fn(), listLocalSessionParticipants: vi.fn(), listClassrooms: vi.fn(), createClassroom: vi.fn(), updateClassroom: vi.fn(), deleteClassroom: vi.fn(), listStudents: vi.fn(), createStudent: vi.fn(), updateStudent: vi.fn(), deleteStudent: vi.fn(), listCourses: vi.fn(), createCourse: vi.fn(), updateCourse: vi.fn(), deleteCourse: vi.fn(), listLessons: vi.fn(), listAllLessons: vi.fn(), createLesson: vi.fn(), updateLesson: vi.fn(), deleteLesson: vi.fn(), listQuestionSets: vi.fn(), getQuestionSet: vi.fn(), createQuestionSet: vi.fn(), updateQuestionSet: vi.fn(), deleteQuestionSet: vi.fn(), listQuestions: vi.fn(), getQuestion: vi.fn(), createQuestion: vi.fn(), createQuestionWithDraftAssets: vi.fn(), updateQuestion: vi.fn(), deleteQuestion: vi.fn(), reorderQuestions: vi.fn(),
  listQuestionAssets: vi.fn().mockResolvedValue([]), importQuestionAsset: vi.fn(), createQuestionDraft: vi.fn().mockResolvedValue({ id: "019fe923-090a-7aa0-85dc-c216080117fa" }), importQuestionDraftAsset: vi.fn(), deleteQuestionDraftAsset: vi.fn(), discardQuestionDraft: vi.fn(), deleteQuestionAsset: vi.fn(), getQuestionAssetPreview: vi.fn(), updateQuestionAssetPageReference: vi.fn(),
});

describe("Question editors", () => {
  beforeEach(() => { open.mockReset(); vi.spyOn(window, "confirm").mockReturnValue(true); });
  it("retains stable choice IDs when option text is edited", async () => {
    const createQuestionWithDraftAssets = vi.fn().mockResolvedValue({});
    render(<QuestionEditor api={apiWith({ createQuestionWithDraftAssets })} questionSetId="set-1" question={null} position={0} onSaved={vi.fn()} onCancel={vi.fn()} onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "建立題目" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("題目內容"), { target: { value: "Choose" } });
    fireEvent.change(screen.getByRole("combobox", { name: "題型" }), { target: { value: "single_choice" } });
    fireEvent.change(screen.getByRole("textbox", { name: "選項 1 內容" }), { target: { value: "A" } });
    fireEvent.change(screen.getByRole("textbox", { name: "選項 2 內容" }), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "建立題目" }));
    await waitFor(() => expect(createQuestionWithDraftAssets).toHaveBeenCalledWith(expect.objectContaining({ type: "single_choice", answerConfig: expect.objectContaining({ options: [{ id: expect.stringMatching(/^option-/), text: "A" }, { id: expect.stringMatching(/^option-/), text: "B" }], correctOptionId: expect.stringMatching(/^option-/) }) }), "019fe923-090a-7aa0-85dc-c216080117fa"));
    const saved = createQuestionWithDraftAssets.mock.calls[0]?.[0]; expect(saved.answerConfig.correctOptionId).toBe(saved.answerConfig.options[0].id);
  });

  it("rejects duplicate normalized fill blank answers", async () => {
    const onError = vi.fn();
    render(<QuestionEditor api={api()} questionSetId="set-1" question={null} position={0} onSaved={vi.fn()} onCancel={vi.fn()} onError={onError} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "建立題目" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("題目內容"), { target: { value: "Country" } });
    fireEvent.change(screen.getByRole("combobox", { name: "題型" }), { target: { value: "fill_blank" } });
    fireEvent.change(screen.getByRole("textbox", { name: "空格 1 的可接受答案 1" }), { target: { value: "Taiwan" } });
    fireEvent.click(screen.getByRole("button", { name: "＋ 新增可接受答案" }));
    fireEvent.change(screen.getByRole("textbox", { name: "空格 1 的可接受答案 2" }), { target: { value: "TAIWAN" } });
    fireEvent.click(screen.getByRole("button", { name: "建立題目" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("每個填空的可接受答案不可重複。"));
  });

  it("imports a PDF into an empty FillBlank draft without running final Question validation", async () => {
    const importQuestionDraftAsset = vi.fn().mockResolvedValue({ id: "draft-pdf", draftId: "019fe923-090a-7aa0-85dc-c216080117fa", assetType: "pdf", displayName: "worksheet.pdf", mimeType: "application/pdf", sizeBytes: 120, assetUrl: "http://asset.localhost/draft-pdf" });
    const createQuestionWithDraftAssets = vi.fn();
    const onError = vi.fn();
    open.mockResolvedValue("I:\\source\\worksheet.pdf");
    render(<QuestionEditor api={apiWith({ importQuestionDraftAsset, createQuestionWithDraftAssets })} questionSetId="set-1" question={null} position={0} onSaved={vi.fn()} onCancel={vi.fn()} onError={onError} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "建立題目" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("題目內容"), { target: { value: "填空題" } });
    fireEvent.change(screen.getByRole("combobox", { name: "題型" }), { target: { value: "fill_blank" } });
    fireEvent.click(screen.getByRole("button", { name: "加入 PDF" }));
    await waitFor(() => expect(importQuestionDraftAsset).toHaveBeenCalledWith("019fe923-090a-7aa0-85dc-c216080117fa", "I:\\source\\worksheet.pdf"));
    expect(createQuestionWithDraftAssets).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(screen.getByText("worksheet.pdf")).toBeInTheDocument();
  });

  it("imports an image into an empty FillBlank draft without running final Question validation", async () => {
    const importQuestionDraftAsset = vi.fn().mockResolvedValue({ id: "draft-image", draftId: "019fe923-090a-7aa0-85dc-c216080117fa", assetType: "image", displayName: "diagram.png", mimeType: "image/png", sizeBytes: 120, assetUrl: "http://asset.localhost/draft-image" });
    const createQuestionWithDraftAssets = vi.fn();
    const onError = vi.fn();
    open.mockResolvedValue("I:\\source\\diagram.png");
    render(<QuestionEditor api={apiWith({ importQuestionDraftAsset, createQuestionWithDraftAssets })} questionSetId="set-1" question={null} position={0} onSaved={vi.fn()} onCancel={vi.fn()} onError={onError} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "建立題目" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("題目內容"), { target: { value: "圖片填空題" } });
    fireEvent.change(screen.getByRole("combobox", { name: "題型" }), { target: { value: "fill_blank" } });
    fireEvent.click(screen.getByRole("button", { name: "加入圖片" }));
    await waitFor(() => expect(importQuestionDraftAsset).toHaveBeenCalledWith("019fe923-090a-7aa0-85dc-c216080117fa", "I:\\source\\diagram.png"));
    expect(createQuestionWithDraftAssets).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(screen.getByText("diagram.png")).toBeInTheDocument();
  });

  it("keeps final FillBlank validation when creating a draft with an imported PDF", async () => {
    const importQuestionDraftAsset = vi.fn().mockResolvedValue({ id: "draft-pdf", draftId: "019fe923-090a-7aa0-85dc-c216080117fa", assetType: "pdf", displayName: "worksheet.pdf", mimeType: "application/pdf", sizeBytes: 120, assetUrl: "http://asset.localhost/draft-pdf" });
    const createQuestionWithDraftAssets = vi.fn();
    const onError = vi.fn();
    open.mockResolvedValue("I:\\source\\worksheet.pdf");
    render(<QuestionEditor api={apiWith({ importQuestionDraftAsset, createQuestionWithDraftAssets })} questionSetId="set-1" question={null} position={0} onSaved={vi.fn()} onCancel={vi.fn()} onError={onError} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "建立題目" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("題目內容"), { target: { value: "填空題" } });
    fireEvent.change(screen.getByRole("combobox", { name: "題型" }), { target: { value: "fill_blank" } });
    fireEvent.click(screen.getByRole("button", { name: "加入 PDF" }));
    await waitFor(() => expect(screen.getByText("worksheet.pdf")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "建立題目" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("每個填空至少需要一個可接受答案。"));
    expect(createQuestionWithDraftAssets).not.toHaveBeenCalled();
  });

  it("promotes an imported PDF after a FillBlank answer is completed", async () => {
    const importQuestionDraftAsset = vi.fn().mockResolvedValue({ id: "draft-pdf", draftId: "019fe923-090a-7aa0-85dc-c216080117fa", assetType: "pdf", displayName: "worksheet.pdf", mimeType: "application/pdf", sizeBytes: 120, assetUrl: "http://asset.localhost/draft-pdf" });
    const createQuestionWithDraftAssets = vi.fn().mockResolvedValue({});
    open.mockResolvedValue("I:\\source\\worksheet.pdf");
    render(<QuestionEditor api={apiWith({ importQuestionDraftAsset, createQuestionWithDraftAssets })} questionSetId="set-1" question={null} position={0} onSaved={vi.fn()} onCancel={vi.fn()} onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "建立題目" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("題目內容"), { target: { value: "填空題" } });
    fireEvent.change(screen.getByRole("combobox", { name: "題型" }), { target: { value: "fill_blank" } });
    fireEvent.click(screen.getByRole("button", { name: "加入 PDF" }));
    await waitFor(() => expect(screen.getByText("worksheet.pdf")).toBeInTheDocument());
    fireEvent.change(screen.getByRole("textbox", { name: "空格 1 的可接受答案 1" }), { target: { value: "答案" } });
    fireEvent.click(screen.getByRole("button", { name: "建立題目" }));
    await waitFor(() => expect(createQuestionWithDraftAssets).toHaveBeenCalledWith(expect.objectContaining({ type: "fill_blank", answerConfig: expect.objectContaining({ blanks: [expect.objectContaining({ acceptedAnswers: ["答案"] })] }) }), "019fe923-090a-7aa0-85dc-c216080117fa"));
  });

  it("discards a new Question draft and its media on cancel", async () => {
    const discardQuestionDraft = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(<QuestionEditor api={apiWith({ discardQuestionDraft })} questionSetId="set-1" question={null} position={0} onSaved={vi.fn()} onCancel={onCancel} onError={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "建立題目" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(discardQuestionDraft).toHaveBeenCalledWith("019fe923-090a-7aa0-85dc-c216080117fa"));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

function apiWith(overrides: Partial<TeacherApi>): TeacherApi { return { ...api(), ...overrides }; }
