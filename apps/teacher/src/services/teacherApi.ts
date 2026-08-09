import { invoke } from "@tauri-apps/api/core";
import type { TeacherApi } from "../types/teacher";

export interface TeacherApiErrorShape { code?: string; message?: string; retryable?: boolean }
export class TeacherApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(error: unknown) {
    const shape = typeof error === "object" && error !== null ? error as TeacherApiErrorShape : {};
    super(shape.message ?? "The Teacher operation could not be completed.");
    this.name = "TeacherApiError";
    this.code = shape.code ?? "INTERNAL";
    this.retryable = shape.retryable ?? false;
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>(command, args); } catch (error) { throw new TeacherApiError(error); }
}

export const teacherApi: TeacherApi = {
  getLocalDatabaseStatus: () => call("get_local_database_status"),
  listClassrooms: () => call("list_classrooms"),
  createClassroom: (request) => call("create_classroom", { request }),
  updateClassroom: (id, request) => call("update_classroom", { id, request }),
  deleteClassroom: (id) => call("delete_classroom", { id }),
  listStudents: (classId) => call("list_students", { classId }),
  createStudent: (request) => call("create_student", { request }),
  updateStudent: (id, request) => call("update_student", { id, request }),
  deleteStudent: (id) => call("delete_student", { id }),
  listCourses: () => call("list_courses"),
  createCourse: (request) => call("create_course", { request }),
  updateCourse: (id, request) => call("update_course", { id, request }),
  deleteCourse: (id) => call("delete_course", { id }),
  listLessons: (courseId) => call("list_lessons", { courseId }),
  listAllLessons: () => call("list_all_lessons"),
  createLesson: (request) => call("create_lesson", { request }),
  updateLesson: (id, request) => call("update_lesson", { id, request }),
  deleteLesson: (id) => call("delete_lesson", { id }),
  listQuestionSets: () => call("list_question_sets"),
  getQuestionSet: (id) => call("get_question_set", { id }),
  createQuestionSet: (request) => call("create_question_set", { request }),
  updateQuestionSet: (id, request) => call("update_question_set", { id, request }),
  deleteQuestionSet: (id) => call("delete_question_set", { id }),
  listQuestions: (questionSetId) => call("list_questions", { questionSetId }),
  getQuestion: (id) => call("get_question", { id }),
  createQuestion: (request) => call("create_question", { request }),
  updateQuestion: (id, request) => call("update_question", { id, request }),
  deleteQuestion: (id) => call("delete_question", { id }),
  reorderQuestions: (questionSetId, orderedQuestionIds) => call("reorder_questions", { request: { questionSetId, orderedQuestionIds } }),
  listQuestionAssets: (questionId) => call("list_question_assets", { questionId }),
  importQuestionAsset: (questionId, sourcePath) => call("import_question_asset", { request: { questionId, sourcePath } }),
  deleteQuestionAsset: (assetId) => call("delete_question_asset", { assetId }),
  getQuestionAssetPreview: (assetId) => call("get_question_asset_preview", { assetId }),
  updateQuestionAssetPageReference: (assetId, pageReference) => call("update_question_asset_page_reference", { assetId, request: { pageReference } }),
};
