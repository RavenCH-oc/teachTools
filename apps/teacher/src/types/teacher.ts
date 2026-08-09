export interface LocalDatabaseStatus { database_open: boolean; schema_version: number; path_classification: string }
export interface Classroom { id: string; name: string; academic_year: string | null; created_at: string; updated_at: string }
export interface Student { id: string; class_id: string; seat_number: number; name: string; created_at: string; updated_at: string }
export interface Course { id: string; name: string; description: string | null; created_at: string; updated_at: string }
export interface Lesson { id: string; course_id: string; title: string; description: string | null; position: number; created_at: string; updated_at: string }
export interface CreateClassroomRequest { name: string; academic_year?: string | null }
export interface CreateStudentRequest { class_id: string; seat_number: number; name: string }
export interface CreateCourseRequest { name: string; description?: string | null }
export interface CreateLessonRequest { course_id: string; title: string; description?: string | null; position: number }
import type { CreateQuestionInput, CreateQuestionSetInput, Question, QuestionSet, UpdateQuestionInput, UpdateQuestionSetInput } from "@classtools/domain";
export type { Question, QuestionSet } from "@classtools/domain";

export interface TeacherApi {
  getLocalDatabaseStatus(): Promise<LocalDatabaseStatus>
  listClassrooms(): Promise<Classroom[]>
  createClassroom(request: CreateClassroomRequest): Promise<Classroom>
  updateClassroom(id: string, request: CreateClassroomRequest): Promise<Classroom>
  deleteClassroom(id: string): Promise<void>
  listStudents(classId: string): Promise<Student[]>
  createStudent(request: CreateStudentRequest): Promise<Student>
  updateStudent(id: string, request: Omit<CreateStudentRequest, "class_id">): Promise<Student>
  deleteStudent(id: string): Promise<void>
  listCourses(): Promise<Course[]>
  createCourse(request: CreateCourseRequest): Promise<Course>
  updateCourse(id: string, request: CreateCourseRequest): Promise<Course>
  deleteCourse(id: string): Promise<void>
  listLessons(courseId: string): Promise<Lesson[]>
  createLesson(request: CreateLessonRequest): Promise<Lesson>
  updateLesson(id: string, request: Omit<CreateLessonRequest, "course_id">): Promise<Lesson>
  deleteLesson(id: string): Promise<void>
  listQuestionSets(): Promise<QuestionSet[]>
  getQuestionSet(id: string): Promise<QuestionSet>
  createQuestionSet(request: CreateQuestionSetInput): Promise<QuestionSet>
  updateQuestionSet(id: string, request: Omit<UpdateQuestionSetInput, "id">): Promise<QuestionSet>
  deleteQuestionSet(id: string): Promise<void>
  listQuestions(questionSetId: string): Promise<Question[]>
  getQuestion(id: string): Promise<Question>
  createQuestion(request: CreateQuestionInput): Promise<Question>
  updateQuestion(id: string, request: Omit<UpdateQuestionInput, "id">): Promise<Question>
  deleteQuestion(id: string): Promise<void>
}
