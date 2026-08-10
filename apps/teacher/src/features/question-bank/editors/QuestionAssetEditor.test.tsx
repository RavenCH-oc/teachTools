import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionAsset, TeacherApi } from "../../../types/teacher";
import { TeacherApiError } from "../../../services/teacherApi";
import { QuestionAssetEditor, formatBytes } from "./QuestionAssetEditor";

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));

const image: QuestionAsset = { id: "asset-image", questionId: "q-1", assetType: "image", displayName: "diagram.png", mimeType: "image/png", sizeBytes: 331_776, position: 0, pageReference: null, createdAt: "now", status: "ready" };
const pdf: QuestionAsset = { id: "asset-pdf", questionId: "q-1", assetType: "pdf", displayName: "chapter.pdf", mimeType: "application/pdf", sizeBytes: 8_598_323, position: 1, pageReference: 2, createdAt: "now", status: "ready" };

function api(overrides: Partial<TeacherApi> = {}): TeacherApi {
  return {
    getLocalDatabaseStatus: vi.fn(), getLocalServerStatus: vi.fn(), startLocalServer: vi.fn(), stopLocalServer: vi.fn(), listClassrooms: vi.fn(), createClassroom: vi.fn(), updateClassroom: vi.fn(), deleteClassroom: vi.fn(), listStudents: vi.fn(), createStudent: vi.fn(), updateStudent: vi.fn(), deleteStudent: vi.fn(), listCourses: vi.fn(), createCourse: vi.fn(), updateCourse: vi.fn(), deleteCourse: vi.fn(), listLessons: vi.fn(), listAllLessons: vi.fn(), createLesson: vi.fn(), updateLesson: vi.fn(), deleteLesson: vi.fn(), listQuestionSets: vi.fn(), getQuestionSet: vi.fn(), createQuestionSet: vi.fn(), updateQuestionSet: vi.fn(), deleteQuestionSet: vi.fn(), listQuestions: vi.fn(), getQuestion: vi.fn(), createQuestion: vi.fn(), updateQuestion: vi.fn(), deleteQuestion: vi.fn(), reorderQuestions: vi.fn(), listQuestionAssets: vi.fn(), importQuestionAsset: vi.fn(), deleteQuestionAsset: vi.fn(), getQuestionAssetPreview: vi.fn().mockImplementation((id) => Promise.resolve({ ...(id === image.id ? image : pdf), assetUrl: `http://asset.localhost/${id}` })), updateQuestionAssetPageReference: vi.fn(), ...overrides,
  };
}

describe("Question asset editor", () => {
  beforeEach(() => { open.mockReset(); vi.spyOn(window, "confirm").mockReturnValue(true); });

  it("disables imports before a Question is saved", () => {
    render(<QuestionAssetEditor api={api()} assets={[]} onChange={vi.fn()} onError={vi.fn()} questionId={null} />);
    expect(screen.getByRole("button", { name: "Import image" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import PDF" })).toBeDisabled();
    expect(screen.getByText("Save this question before importing media.")).toBeInTheDocument();
  });

  it("renders image/PDF metadata and imports through the dialog boundary", async () => {
    const importQuestionAsset = vi.fn().mockResolvedValue(image);
    const onChange = vi.fn();
    open.mockResolvedValue("C:\\source\\diagram.png");
    render(<QuestionAssetEditor api={api({ importQuestionAsset })} assets={[image, pdf]} onChange={onChange} onError={vi.fn()} questionId="q-1" />);
    expect(await screen.findByAltText("diagram.png")).toBeInTheDocument();
    expect(screen.getByText("chapter.pdf")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import image" }));
    await waitFor(() => expect(importQuestionAsset).toHaveBeenCalledWith("q-1", "C:\\source\\diagram.png"));
  });

  it("presents a friendly error when import fails", async () => {
    const onError = vi.fn();
    open.mockResolvedValue("C:\\source\\diagram.png");
    render(<QuestionAssetEditor api={api({ importQuestionAsset: vi.fn().mockRejectedValue({ code: "file_too_large", message: "The selected file exceeds the supported size limit." }) })} assets={[]} onChange={vi.fn()} onError={onError} questionId="q-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Import image" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not import the selected file."));
  });

  it("distinguishes a corrupted managed file from a missing file", async () => {
    render(<QuestionAssetEditor api={api({ getQuestionAssetPreview: vi.fn().mockRejectedValue(new TeacherApiError({ code: "asset_corrupted", message: "safe" })) })} assets={[image]} onChange={vi.fn()} onError={vi.fn()} questionId="q-1" />);
    expect(await screen.findByText("Attachment file may have been damaged or changed. Remove it and import again.")).toBeInTheDocument();
  });

  it("formats file sizes without an extra dependency", () => {
    expect(formatBytes(324)).toBe("324 B");
    expect(formatBytes(331_776)).toBe("324 KB");
    expect(formatBytes(8_598_323)).toBe("8.2 MB");
  });
});
