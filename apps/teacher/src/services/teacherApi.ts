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
  createLesson: (request) => call("create_lesson", { request }),
  updateLesson: (id, request) => call("update_lesson", { id, request }),
  deleteLesson: (id) => call("delete_lesson", { id }),
};
