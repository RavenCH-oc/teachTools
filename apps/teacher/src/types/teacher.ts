export interface LocalDatabaseStatus { database_open: boolean; schema_version: number; path_classification: string }
export type LocalServerLifecycleState = "stopped" | "starting" | "running" | "stopping";
export interface LocalServerStatus {
  running: boolean;
  lifecycleState: LocalServerLifecycleState;
  port: number | null;
  localUrl: string | null;
  serverInstanceId: string | null;
  candidateUrls: string[];
  webSocketUrls: string[];
  protocolVersion: number;
}
export type LocalSessionState = "CREATED" | "LOBBY" | "ACTIVE" | "ENDED";
export interface LocalSession {
  id: string;
  classroomId: string;
  classroomName: string;
  serverInstanceId: string;
  state: LocalSessionState;
  joinMode: "roster_match";
  joinCode: string;
  createdAt: string;
  lobbyOpenedAt: string | null;
  endedAt: string | null;
  endedReason: string | null;
}
export interface SessionHistory {
  sessionId: string;
  classroomId: string;
  classroomName: string;
  state: "ENDED";
  createdAt: string;
  lobbyOpenedAt: string | null;
  endedAt: string;
  participantCount: number;
  eligibleQuestionCount: number;
}
export interface LocalSessionParticipant {
  participantId: string;
  studentId: string | null;
  seatNumber: number;
  displayName: string;
  joinedAt: string;
  online: boolean;
}
export type SessionQuestionState = "HIDDEN" | "OPEN" | "LOCKED" | "REVEALED";
export interface SessionQuestion {
  id: string; sessionId: string; sourceQuestionId: string | null; type: Question["type"]; prompt: string; points: number; position: number;
  answerConfig: Question["answerConfig"]; gradingConfig: Record<string, unknown>; metadata: Record<string, unknown>; configVersion: number; state: SessionQuestionState;
  createdAt: string; openedAt: string | null; lockedAt: string | null; revealedAt: string | null; assets: Array<{ id: string; assetType: "image" | "pdf"; displayName: string; mimeType: string; sizeBytes: number; position: number; pageReference: number | null }>;
}
export interface TeacherQuestionProgress { sessionQuestionId: string; answeredCount: number; participantCount: number; answeredParticipantIds: string[] }
export interface ChoiceDistribution {
  optionId: string;
  label: string;
  selectionCount: number;
  selectionRate: number | null;
}
export interface QuestionStatistics {
  sessionQuestionId: string;
  position: number;
  questionType: Question["type"];
  prompt: string;
  participantCount: number;
  answeredCount: number;
  unansweredCount: number;
  responseRate: number | null;
  gradedCount: number;
  pendingCount: number;
  correctCount: number;
  incorrectCount: number;
  accuracy: number | null;
  averageScore: number | null;
  maxPoints: number;
  choiceDistribution: ChoiceDistribution[];
}
export interface ParticipantSessionStatistics {
  participantId: string;
  seatNumber: number;
  displayName: string;
  eligibleQuestionCount: number;
  answeredCount: number;
  unansweredCount: number;
  gradedCount: number;
  pendingCount: number;
  correctCount: number;
  incorrectCount: number;
  earnedScore: number;
  gradedPossibleScore: number;
  accuracy: number | null;
  scoreRate: number | null;
}
export interface SessionStatistics {
  sessionId: string;
  sessionState: LocalSessionState;
  participantCount: number;
  publishedQuestionCount: number;
  eligibleQuestionCount: number;
  answeredOpportunityCount: number;
  totalOpportunityCount: number;
  responseRate: number | null;
  gradedSubmissionCount: number;
  pendingSubmissionCount: number;
  correctCount: number;
  incorrectCount: number;
  accuracy: number | null;
  earnedScoreTotal: number;
  gradedPossibleScoreTotal: number;
  scoreRate: number | null;
  questionSummaries: QuestionStatistics[];
  participantSummaries: ParticipantSessionStatistics[];
}
export interface QuestionDifficulty {
  sessionQuestionId: string;
  position: number;
  prompt: string;
  accuracy: number;
  gradedCount: number;
}
export interface Classroom { id: string; name: string; academic_year: string | null; created_at: string; updated_at: string }
export interface Student { id: string; class_id: string; seat_number: number; name: string; created_at: string; updated_at: string }
export interface Course { id: string; name: string; description: string | null; created_at: string; updated_at: string }
export interface Lesson { id: string; course_id: string; title: string; description: string | null; position: number; created_at: string; updated_at: string }
export interface CreateClassroomRequest { name: string; academic_year?: string | null }
export interface CreateStudentRequest { class_id: string; seat_number: number; name: string }
export interface CreateCourseRequest { name: string; description?: string | null }
export interface CreateLessonRequest { course_id: string; title: string; description?: string | null; position: number }
export interface GroupPresetSummary {
  id: string;
  classroomId: string;
  name: string;
  groupCount: number;
  assignedStudentCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface GroupPresetGroup {
  id: string;
  presetId: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}
export interface GroupPresetMember {
  id: string;
  presetId: string;
  groupId: string;
  studentId: string;
  createdAt: string;
  updatedAt: string;
}
export interface GroupPresetDetail {
  preset: GroupPresetSummary;
  groups: GroupPresetGroup[];
  members: GroupPresetMember[];
}
export interface CreateGroupPresetRequest { classroomId: string; name: string }
export interface UpdateGroupPresetRequest {
  classroomId: string;
  presetId: string;
  name: string;
  groups: Array<{ key: string; id?: string; name: string; position: number }>;
  assignments: Array<{ groupId: string; studentId: string }>;
}
export type SessionGroupingDraftState = "DRAFT" | "OPEN" | "FINALIZED" | "CANCELLED";
export interface SessionGroupingParticipant {
  participantId: string;
  studentId: string | null;
  seatNumber: number;
  displayName: string;
  joinedAt: string;
}
export interface SessionGroupingGroup {
  id: string;
  name: string;
  position: number;
  capacity: number | null;
  participantIds: string[];
}
export interface SessionGroupingDraft {
  id: string;
  sessionId: string;
  state: SessionGroupingDraftState;
  createdAt: string;
  updatedAt: string;
  groups: SessionGroupingGroup[];
}
export interface SessionGroupingGroupSet {
  revision: number;
  createdAt: string;
  groups: SessionGroupingGroup[];
}
export interface SessionGroupingOverview {
  sessionId: string;
  classroomId: string;
  sessionState: LocalSessionState;
  participants: SessionGroupingParticipant[];
  currentGroupSet: SessionGroupingGroupSet | null;
  activeDraft: SessionGroupingDraft | null;
}
export interface CreateSessionGroupingDraftFromPresetRequest { sessionId: string; presetId: string }
export interface CreateRandomGroupingDraftRequest { sessionId: string; groupCount: number }
export interface UpdateSessionGroupingDraftRequest {
  draftId: string;
  groups: Array<{ key: string; id?: string; name: string; position: number; capacity: number | null }>;
  assignments: Array<{ groupKey: string; participantId: string }>;
}
import type { CreateQuestionInput, CreateQuestionSetInput, Question, QuestionAsset, QuestionAssetPreview, QuestionSet, UpdateQuestionInput, UpdateQuestionSetInput } from "@classtools/domain";
export type { Question, QuestionAsset, QuestionAssetPreview, QuestionSet } from "@classtools/domain";

export interface QuestionDraft { id: string }
export interface DraftQuestionAsset {
  id: string;
  draftId: string;
  assetType: "image" | "pdf";
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  assetUrl: string;
}

export interface TeacherApi {
  getLocalDatabaseStatus(): Promise<LocalDatabaseStatus>
  startLocalServer(): Promise<LocalServerStatus>
  stopLocalServer(): Promise<LocalServerStatus>
  getLocalServerStatus(): Promise<LocalServerStatus>
  createLocalSession(classroomId: string): Promise<LocalSession>
  openLocalSessionLobby(sessionId: string): Promise<LocalSession>
  startLocalSession?(sessionId: string): Promise<LocalSession>
  getActiveLocalSession(): Promise<LocalSession | null>
  listClassroomSessionHistory?(classroomId: string, limit?: number, offset?: number): Promise<SessionHistory[]>
  endLocalSession(sessionId: string): Promise<LocalSession>
  listLocalSessionParticipants(sessionId: string): Promise<LocalSessionParticipant[]>
  publishSessionQuestion?(sessionId: string, sourceQuestionId: string): Promise<SessionQuestion>
  listSessionQuestions?(sessionId: string): Promise<SessionQuestion[]>
  openSessionQuestion?(sessionQuestionId: string): Promise<SessionQuestion>
  lockSessionQuestion?(sessionQuestionId: string): Promise<SessionQuestion>
  reopenSessionQuestion?(sessionQuestionId: string): Promise<SessionQuestion>
  revealSessionQuestion?(sessionQuestionId: string): Promise<SessionQuestion>
  getSessionQuestionProgress?(sessionQuestionId: string, sessionId: string): Promise<TeacherQuestionProgress>
  getQuestionStatistics?(sessionId: string, sessionQuestionId: string): Promise<QuestionStatistics>
  listQuestionStatistics?(sessionId: string): Promise<QuestionStatistics[]>
  getParticipantSessionStatistics?(sessionId: string, participantId: string): Promise<ParticipantSessionStatistics>
  getSessionStatistics?(sessionId: string): Promise<SessionStatistics>
  getDifficultQuestions?(sessionId: string): Promise<QuestionDifficulty[]>
  listClassrooms(): Promise<Classroom[]>
  createClassroom(request: CreateClassroomRequest): Promise<Classroom>
  updateClassroom(id: string, request: CreateClassroomRequest): Promise<Classroom>
  deleteClassroom(id: string): Promise<void>
  listStudents(classId: string): Promise<Student[]>
  createStudent(request: CreateStudentRequest): Promise<Student>
  updateStudent(id: string, request: Omit<CreateStudentRequest, "class_id">): Promise<Student>
  deleteStudent(id: string): Promise<void>
  listGroupPresets?(classroomId: string): Promise<GroupPresetSummary[]>
  getGroupPreset?(classroomId: string, presetId: string): Promise<GroupPresetDetail>
  createGroupPreset?(request: CreateGroupPresetRequest): Promise<GroupPresetDetail>
  updateGroupPreset?(request: UpdateGroupPresetRequest): Promise<GroupPresetDetail>
  deleteGroupPreset?(classroomId: string, presetId: string): Promise<void>
  getSessionGrouping?(sessionId: string): Promise<SessionGroupingOverview>
  createGroupingDraftFromPreset?(request: CreateSessionGroupingDraftFromPresetRequest): Promise<SessionGroupingOverview>
  createRandomGroupingDraft?(request: CreateRandomGroupingDraftRequest): Promise<SessionGroupingOverview>
  createManualGroupingDraft?(sessionId: string): Promise<SessionGroupingOverview>
  cloneCurrentGroupingDraft?(sessionId: string): Promise<SessionGroupingOverview>
  updateSessionGroupingDraft?(request: UpdateSessionGroupingDraftRequest): Promise<SessionGroupingOverview>
  cancelSessionGroupingDraft?(draftId: string): Promise<SessionGroupingOverview>
  finalizeSessionGroupingDraft?(draftId: string): Promise<SessionGroupingOverview>
  listCourses(): Promise<Course[]>
  createCourse(request: CreateCourseRequest): Promise<Course>
  updateCourse(id: string, request: CreateCourseRequest): Promise<Course>
  deleteCourse(id: string): Promise<void>
  listLessons(courseId: string): Promise<Lesson[]>
  listAllLessons(): Promise<Lesson[]>
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
  createQuestionWithDraftAssets(request: CreateQuestionInput, draftId: string): Promise<Question>
  updateQuestion(id: string, request: Omit<UpdateQuestionInput, "id">): Promise<Question>
  deleteQuestion(id: string): Promise<void>
  reorderQuestions(questionSetId: string, orderedQuestionIds: string[]): Promise<Question[]>
  listQuestionAssets(questionId: string): Promise<QuestionAsset[]>
  importQuestionAsset(questionId: string, sourcePath: string): Promise<QuestionAsset>
  createQuestionDraft(): Promise<QuestionDraft>
  importQuestionDraftAsset(draftId: string, sourcePath: string): Promise<DraftQuestionAsset>
  deleteQuestionDraftAsset(draftId: string, draftAssetId: string): Promise<void>
  discardQuestionDraft(draftId: string): Promise<void>
  deleteQuestionAsset(assetId: string): Promise<void>
  getQuestionAssetPreview(assetId: string): Promise<QuestionAssetPreview>
  updateQuestionAssetPageReference(assetId: string, pageReference: number | null): Promise<QuestionAsset>
}
