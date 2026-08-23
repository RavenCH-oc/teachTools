import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftQuestionAsset, QuestionAsset, TeacherApi } from "../../../types/teacher";
import { TeacherApiError } from "../../../services/teacherApi";
import { DraftQuestionAssetEditor, QuestionAssetEditor, formatBytes } from "./QuestionAssetEditor";

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));

const image: QuestionAsset = { id: "asset-image", questionId: "q-1", assetType: "image", displayName: "diagram.png", mimeType: "image/png", sizeBytes: 331_776, position: 0, pageReference: null, createdAt: "now", status: "ready" };
const pdf: QuestionAsset = { id: "asset-pdf", questionId: "q-1", assetType: "pdf", displayName: "chapter.pdf", mimeType: "application/pdf", sizeBytes: 8_598_323, position: 1, pageReference: 2, createdAt: "now", status: "ready" };
const draftImage: DraftQuestionAsset = { id: "019fe924-3e72-7d4e-9e4b-5c52f2a3c1d6", draftId: "019fe923-090a-7aa0-85dc-c216080117fa", assetType: "image", displayName: "draft.png", mimeType: "image/png", sizeBytes: 331_776, assetUrl: "http://asset.localhost/draft.png" };

function api(overrides: Partial<TeacherApi> = {}): TeacherApi {
  return {
    getLocalDatabaseStatus: vi.fn(), getLocalServerStatus: vi.fn(), startLocalServer: vi.fn(), stopLocalServer: vi.fn(), createLocalSession: vi.fn(), openLocalSessionLobby: vi.fn(), getActiveLocalSession: vi.fn(), endLocalSession: vi.fn(), listLocalSessionParticipants: vi.fn(), listClassrooms: vi.fn(), createClassroom: vi.fn(), updateClassroom: vi.fn(), deleteClassroom: vi.fn(), listStudents: vi.fn(), createStudent: vi.fn(), updateStudent: vi.fn(), deleteStudent: vi.fn(), listCourses: vi.fn(), createCourse: vi.fn(), updateCourse: vi.fn(), deleteCourse: vi.fn(), listLessons: vi.fn(), listAllLessons: vi.fn(), createLesson: vi.fn(), updateLesson: vi.fn(), deleteLesson: vi.fn(), listQuestionSets: vi.fn(), getQuestionSet: vi.fn(), createQuestionSet: vi.fn(), updateQuestionSet: vi.fn(), deleteQuestionSet: vi.fn(), listQuestions: vi.fn(), getQuestion: vi.fn(), createQuestion: vi.fn(), createQuestionWithDraftAssets: vi.fn(), updateQuestion: vi.fn(), deleteQuestion: vi.fn(), reorderQuestions: vi.fn(), listQuestionAssets: vi.fn(), importQuestionAsset: vi.fn(), createQuestionDraft: vi.fn().mockResolvedValue({ id: "019fe923-090a-7aa0-85dc-c216080117fa" }), importQuestionDraftAsset: vi.fn(), deleteQuestionDraftAsset: vi.fn(), discardQuestionDraft: vi.fn(), deleteQuestionAsset: vi.fn(), getQuestionAssetPreview: vi.fn().mockImplementation((id) => Promise.resolve({ ...(id === image.id ? image : pdf), assetUrl: `http://asset.localhost/${id}` })), updateQuestionAssetPageReference: vi.fn(), ...overrides,
  };
}

describe("Question asset editor", () => {
  beforeEach(() => { open.mockReset(); vi.spyOn(window, "confirm").mockReturnValue(true); });

  it("disables imports before a Question is saved", () => {
    render(<QuestionAssetEditor api={api()} assets={[]} onChange={vi.fn()} onError={vi.fn()} questionId={null} />);
    expect(screen.getByRole("button", { name: "加入圖片" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "加入 PDF" })).toBeDisabled();
    expect(screen.getByText("儲存題目後即可加入圖片或 PDF。")).toBeInTheDocument();
  });

  it("renders image/PDF metadata and imports through the dialog boundary", async () => {
    const importQuestionAsset = vi.fn().mockResolvedValue(image);
    const onChange = vi.fn();
    open.mockResolvedValue("C:\\source\\diagram.png");
    render(<QuestionAssetEditor api={api({ importQuestionAsset })} assets={[image, pdf]} onChange={onChange} onError={vi.fn()} questionId="q-1" />);
    expect(await screen.findByAltText("diagram.png")).toBeInTheDocument();
    expect(screen.getByText("chapter.pdf")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加入圖片" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "加入 PDF" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "加入圖片" }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ title: "加入題目圖片", filters: [{ name: "圖片", extensions: ["png", "jpg", "jpeg", "webp"] }] }));
    await waitFor(() => expect(importQuestionAsset).toHaveBeenCalledWith("q-1", "C:\\source\\diagram.png"));
  });

  it("imports, previews, and removes a draft attachment without a persisted Question", async () => {
    const importQuestionDraftAsset = vi.fn().mockResolvedValue(draftImage);
    const deleteQuestionDraftAsset = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();
    open.mockResolvedValue("C:\\source\\draft.png");
    render(<DraftQuestionAssetEditor api={api({ importQuestionDraftAsset, deleteQuestionDraftAsset })} assets={[draftImage]} draftId={draftImage.draftId} onChange={onChange} onError={vi.fn()} />);

    expect(screen.getByAltText("draft.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加入圖片" }));
    await waitFor(() => expect(importQuestionDraftAsset).toHaveBeenCalledWith(draftImage.draftId, "C:\\source\\draft.png"));
    fireEvent.click(screen.getByRole("button", { name: "刪除 draft.png" }));
    await waitFor(() => expect(deleteQuestionDraftAsset).toHaveBeenCalledWith(draftImage.draftId, draftImage.id));
  });

  it("imports a draft PDF through the same media-only boundary as an image", async () => {
    const draftPdf = { ...draftImage, id: "draft-pdf", assetType: "pdf" as const, displayName: "worksheet.pdf", mimeType: "application/pdf", assetUrl: "http://asset.localhost/draft-pdf" };
    const importQuestionDraftAsset = vi.fn().mockResolvedValue(draftPdf);
    const onChange = vi.fn();
    open.mockResolvedValue("I:\\source\\worksheet.pdf");
    render(<DraftQuestionAssetEditor api={api({ importQuestionDraftAsset })} assets={[]} draftId={draftImage.draftId} onChange={onChange} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "加入 PDF" }));
    await waitFor(() => expect(importQuestionDraftAsset).toHaveBeenCalledWith(draftImage.draftId, "I:\\source\\worksheet.pdf"));
    expect(onChange).toHaveBeenCalled();
  });

  it("imports persisted PDFs without updating the Question or validating unrelated answers", async () => {
    const importQuestionAsset = vi.fn().mockResolvedValue(pdf);
    const updateQuestion = vi.fn();
    open.mockResolvedValue("I:\\source\\chapter.pdf");
    render(<QuestionAssetEditor api={api({ importQuestionAsset, updateQuestion })} assets={[]} onChange={vi.fn()} onError={vi.fn()} questionId="q-1" />);
    fireEvent.click(screen.getByRole("button", { name: "加入 PDF" }));
    await waitFor(() => expect(importQuestionAsset).toHaveBeenCalledWith("q-1", "I:\\source\\chapter.pdf"));
    expect(updateQuestion).not.toHaveBeenCalled();
  });

  it("updates only PDF page reference and does not update the Question", async () => {
    const updateQuestionAssetPageReference = vi.fn().mockResolvedValue({ ...pdf, pageReference: 3 });
    const updateQuestion = vi.fn();
    render(<QuestionAssetEditor api={api({ updateQuestionAssetPageReference, updateQuestion })} assets={[pdf]} onChange={vi.fn()} onError={vi.fn()} questionId="q-1" />);
    const input = await screen.findByDisplayValue("2");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.blur(input);
    await waitFor(() => expect(updateQuestionAssetPageReference).toHaveBeenCalledWith(pdf.id, 3));
    expect(updateQuestion).not.toHaveBeenCalled();
  });

  it("presents a friendly error when import fails", async () => {
    const onError = vi.fn();
    open.mockResolvedValue("C:\\source\\diagram.png");
    render(<QuestionAssetEditor api={api({ importQuestionAsset: vi.fn().mockRejectedValue({ code: "file_too_large", message: "The selected file exceeds the supported size limit." }) })} assets={[]} onChange={vi.fn()} onError={onError} questionId="q-1" />);
    fireEvent.click(screen.getByRole("button", { name: "加入圖片" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("無法加入所選檔案。"));
  });

  it("distinguishes a corrupted managed file from a missing file", async () => {
    render(<QuestionAssetEditor api={api({ getQuestionAssetPreview: vi.fn().mockRejectedValue(new TeacherApiError({ code: "asset_corrupted", message: "safe" })) })} assets={[image]} onChange={vi.fn()} onError={vi.fn()} questionId="q-1" />);
    expect(await screen.findByText("附件檔案可能已損毀或遭到變更，請移除後重新加入。")).toBeInTheDocument();
  });

  it("formats file sizes without an extra dependency", () => {
    expect(formatBytes(324)).toBe("324 B");
    expect(formatBytes(331_776)).toBe("324 KB");
    expect(formatBytes(8_598_323)).toBe("8.2 MB");
  });
});
