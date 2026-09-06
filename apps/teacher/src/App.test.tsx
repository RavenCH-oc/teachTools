import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { LocalSession, QuestionSet, TeacherApi } from "./types/teacher";
import { draftFixture, reviewApiFixture, setupFixture } from "./features/peer-review/testFixtures";

it("opens Teacher peer review from Live Quiz and protects dirty navigation then rehydrates saved drafts", async()=>{
  const session:LocalSession={id:"session",classroomId:"class",classroomName:"測試班級",serverInstanceId:"server",state:"ACTIVE",joinMode:"roster_match",joinCode:"ABCDEFGH",createdAt:"now",lobbyOpenedAt:null,endedAt:null,endedReason:null};
  const api=mockApi({getActiveLocalSession:vi.fn().mockResolvedValue(session),getLocalServerStatus:vi.fn().mockResolvedValue({running:true,serverInstanceId:"server",lifecycleState:"running",candidateUrls:[],webSocketUrls:[]}),listSessionQuestions:vi.fn().mockResolvedValue([])});
  const context=setupFixture();context.activities=[draftFixture()];const reviewApi=reviewApiFixture(context);
  const confirm=vi.spyOn(window,"confirm").mockReturnValue(false);
  try {
    render(<App api={api} reviewApi={reviewApi}/>);
    await screen.findByText("本機儲存空間已就緒");
    fireEvent.click(screen.getByRole("button",{name:"即時測驗"}));
    fireEvent.click(await screen.findByRole("button",{name:"同儕互評"}));
    await screen.findByLabelText("互評方式");
    fireEvent.change(screen.getByLabelText("互評方式"),{target:{value:"STUDENT_SELECT"}});
    fireEvent.click(screen.getByRole("button",{name:"返回即時測驗"}));
    expect(screen.getByLabelText("互評方式")).toHaveValue("STUDENT_SELECT");
    fireEvent.click(screen.getByRole("button",{name:"首頁"}));expect(confirm).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button",{name:"儲存設定"}));
    await waitFor(()=>expect(screen.queryByText("尚有未儲存的變更")).not.toBeInTheDocument());
    await waitFor(()=>expect(screen.getByRole("button",{name:"返回即時測驗"})).toBeEnabled());
    fireEvent.click(screen.getByRole("button",{name:"返回即時測驗"}));
    fireEvent.click(await screen.findByRole("button",{name:"同儕互評"}));
    expect(await screen.findByLabelText("互評方式")).toHaveValue("STUDENT_SELECT");
    expect(reviewApi.getPeerReviewSetupContext).toHaveBeenCalledTimes(3);expect(confirm).toHaveBeenCalledTimes(2);
  } finally {confirm.mockRestore();}
});

const mockApi = (overrides: Partial<TeacherApi> = {}): TeacherApi => ({
  getLocalDatabaseStatus: vi.fn().mockResolvedValue({ database_open: true, schema_version: 1, path_classification: "app_data" }),
  getLocalServerStatus: vi.fn().mockResolvedValue({ running: false, lifecycleState: "stopped", port: null, localUrl: null, serverInstanceId: null, candidateUrls: [], webSocketUrls: [], protocolVersion: 1 }),
  createLocalSession: vi.fn(), openLocalSessionLobby: vi.fn(), getActiveLocalSession: vi.fn().mockResolvedValue(null), endLocalSession: vi.fn(), listLocalSessionParticipants: vi.fn().mockResolvedValue([]),
  startLocalServer: vi.fn(), stopLocalServer: vi.fn(),
  listClassrooms: vi.fn().mockResolvedValue([]), createClassroom: vi.fn(), updateClassroom: vi.fn(), deleteClassroom: vi.fn(),
  listStudents: vi.fn().mockResolvedValue([]), createStudent: vi.fn(), updateStudent: vi.fn(), deleteStudent: vi.fn(),
  listCourses: vi.fn().mockResolvedValue([]), createCourse: vi.fn(), updateCourse: vi.fn(), deleteCourse: vi.fn(),
  listLessons: vi.fn().mockResolvedValue([]), listAllLessons: vi.fn().mockResolvedValue([]), createLesson: vi.fn(), updateLesson: vi.fn(), deleteLesson: vi.fn(),
  listQuestionSets: vi.fn().mockResolvedValue([]), getQuestionSet: vi.fn(), createQuestionSet: vi.fn(), updateQuestionSet: vi.fn(), deleteQuestionSet: vi.fn(),
  listQuestions: vi.fn().mockResolvedValue([]), getQuestion: vi.fn(), createQuestion: vi.fn(), createQuestionWithDraftAssets: vi.fn(), updateQuestion: vi.fn(), deleteQuestion: vi.fn(), reorderQuestions: vi.fn(),
  listQuestionAssets: vi.fn().mockResolvedValue([]), importQuestionAsset: vi.fn(), createQuestionDraft: vi.fn().mockResolvedValue({ id: "019fe923-090a-7aa0-85dc-c216080117fa" }), importQuestionDraftAsset: vi.fn(), deleteQuestionDraftAsset: vi.fn(), discardQuestionDraft: vi.fn(), deleteQuestionAsset: vi.fn(), getQuestionAssetPreview: vi.fn(), updateQuestionAssetPageReference: vi.fn(), ...overrides,
});

describe("Teacher basic data workspace", () => {
  it("renders navigation and local storage readiness", async () => {
    render(<App api={mockApi()} />);
    expect(screen.getByText("正在載入本機工作區…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("本機儲存空間已就緒")).toBeInTheDocument());
    expect(screen.getByRole("navigation", { name: "教師導覽" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "班級" })).toBeInTheDocument();
  });

  it("keeps an unsaved Question draft in the Question Bank until the teacher creates or cancels it", async () => {
    const set: QuestionSet = { id: "set-1", lessonId: null, title: "Fractions", description: null, createdAt: "now", updatedAt: "now" };
    render(<App api={mockApi({ listQuestionSets: vi.fn().mockResolvedValue([set]), listQuestions: vi.fn().mockResolvedValue([]) })} />);
    await screen.findByText("本機儲存空間已就緒");
    fireEvent.click(screen.getByRole("button", { name: "題庫" }));
    await screen.findByRole("button", { name: "＋ 新增題目" });
    fireEvent.click(screen.getByRole("button", { name: "＋ 新增題目" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "加入圖片" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "首頁" }));

    expect(screen.getByRole("alert")).toHaveTextContent("請先建立或取消目前的題目草稿，再離開題庫。");
    expect(screen.getByRole("heading", { name: "建立題目" })).toBeInTheDocument();
  });

  it("shows an empty classroom state and validates a blank create", async () => {
    render(<App api={mockApi()} />);
    await waitFor(() => screen.getByText("本機儲存空間已就緒"));
    within(screen.getByRole("navigation", { name: "教師導覽" })).getByRole("button", { name: "班級" }).click();
    await waitFor(() => expect(screen.getByRole("heading", { name: "班級" })).toBeInTheDocument());
    expect(screen.getByText("尚未建立班級。請建立第一個班級。")).toBeInTheDocument();
    screen.getByRole("button", { name: "建立班級" }).click();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("請輸入班級名稱。"));
  });

  it("clears a stale student seat validation error before rendering the participant lobby", async () => {
    const classroom = { id: "019fe920-0e14-7e30-8a9d-367f86c03bcc", name: "三年甲班", academic_year: null, created_at: "2026-08-11T00:00:00Z", updated_at: "2026-08-11T00:00:00Z" };
    const session = { id: "019fe91e-7606-7d00-aede-59c50a724f4d", classroomId: classroom.id, classroomName: classroom.name, serverInstanceId: "019fe91f-5d66-7e40-a01b-0a69f36caeff", state: "LOBBY" as const, joinMode: "roster_match" as const, joinCode: "AB7K9M2Q", createdAt: "2026-08-11T00:00:00Z", lobbyOpenedAt: "2026-08-11T00:00:00Z", endedAt: null, endedReason: null };
    const api = mockApi({
      listClassrooms: vi.fn().mockResolvedValue([classroom]),
      getLocalServerStatus: vi.fn().mockResolvedValue({ running: true, lifecycleState: "running", port: 49561, localUrl: "http://127.0.0.1:49561", serverInstanceId: session.serverInstanceId, candidateUrls: [], webSocketUrls: [], protocolVersion: 1 }),
      getActiveLocalSession: vi.fn().mockResolvedValue(session),
      listLocalSessionParticipants: vi.fn().mockResolvedValue([
        { participantId: "019fe921-2844-7a50-afd5-65ab3159f0e1", studentId: classroom.id, seatNumber: 1, displayName: "Test", joinedAt: "2026-08-11T00:00:00Z", online: true },
        { participantId: "019fe923-090a-7aa0-85dc-c216080117fa", studentId: classroom.id, seatNumber: 2, displayName: "T", joinedAt: "2026-08-11T00:00:00Z", online: false },
      ]),
    });
    render(<App api={api} />);
    await waitFor(() => screen.getByText("本機儲存空間已就緒"));
    const navigation = screen.getByRole("navigation", { name: "教師導覽" });
    within(navigation).getByRole("button", { name: "學生" }).click();
    await screen.findByRole("heading", { name: "學生" });
    screen.getByRole("button", { name: "新增學生" }).click();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("座號必須為正整數。"));

    within(navigation).getByRole("button", { name: "課堂" }).click();
    expect(await screen.findByText("1 號 Test")).toBeInTheDocument();
    expect(screen.getByText("2 號 T")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("starts from the lobby and rehydrates the same ACTIVE session after navigation", async () => {
    const classroom = { id: "019fe920-0e14-7e30-8a9d-367f86c03bcc", name: "三年甲班", academic_year: null, created_at: "2026-08-11T00:00:00Z", updated_at: "2026-08-11T00:00:00Z" };
    const lobbySession = { id: "019fe91e-7606-7d00-aede-59c50a724f4d", classroomId: classroom.id, classroomName: classroom.name, serverInstanceId: "019fe91f-5d66-7e40-a01b-0a69f36caeff", state: "LOBBY" as const, joinMode: "roster_match" as const, joinCode: "AB7K9M2Q", createdAt: "2026-08-11T00:00:00Z", lobbyOpenedAt: "2026-08-11T00:00:00Z", endedAt: null, endedReason: null };
    let currentSession: LocalSession = lobbySession;
    const api = mockApi({
      listClassrooms: vi.fn().mockResolvedValue([classroom]),
      getLocalServerStatus: vi.fn().mockResolvedValue({ running: true, lifecycleState: "running", port: 49561, localUrl: "http://127.0.0.1:49561", serverInstanceId: lobbySession.serverInstanceId, candidateUrls: [], webSocketUrls: [], protocolVersion: 1 }),
      getActiveLocalSession: vi.fn().mockImplementation(async () => currentSession),
      startLocalSession: vi.fn().mockImplementation(async (sessionId: string) => {
        expect(sessionId).toBe(lobbySession.id);
        currentSession = { ...currentSession, state: "ACTIVE" };
        return currentSession;
      }),
      listQuestionSets: vi.fn().mockResolvedValue([]),
      listSessionQuestions: vi.fn().mockResolvedValue([]),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    try {
      render(<App api={api} />);
      await screen.findByText("本機儲存空間已就緒");
      const navigation = screen.getByRole("navigation", { name: "教師導覽" });
      within(navigation).getByRole("button", { name: "課堂" }).click();
      await screen.findByText("等候大廳已開放");
      within(navigation).getByRole("button", { name: "即時測驗" }).click();
      await screen.findByRole("button", { name: "開始課堂" });

      screen.getByRole("button", { name: "開始課堂" }).click();
      await screen.findByText("發布題目");
      expect(screen.queryByText("請先開啟伺服器並建立課堂。")).not.toBeInTheDocument();

      within(navigation).getByRole("button", { name: "首頁" }).click();
      await screen.findByText("準備好開始下一堂課。");
      within(navigation).getByRole("button", { name: "即時測驗" }).click();
      await screen.findByText("發布題目");
      expect(api.listSessionQuestions).toHaveBeenLastCalledWith(lobbySession.id);
      expect(api.startLocalSession).toHaveBeenCalledWith(lobbySession.id);
    } finally {
      confirm.mockRestore();
    }
  });

  it("keeps the Live Quiz breadcrumb as a normal-flow sibling of the lobby content", async () => {
    const classroom = { id: "019fe920-0e14-7e30-8a9d-367f86c03bcc", name: "三年甲班", academic_year: null, created_at: "2026-08-11T00:00:00Z", updated_at: "2026-08-11T00:00:00Z" };
    const session = { id: "019fe91e-7606-7d00-aede-59c50a724f4d", classroomId: classroom.id, classroomName: classroom.name, serverInstanceId: "019fe91f-5d66-7e40-a01b-0a69f36caeff", state: "LOBBY" as const, joinMode: "roster_match" as const, joinCode: "AB7K9M2Q", createdAt: "2026-08-11T00:00:00Z", lobbyOpenedAt: "2026-08-11T00:00:00Z", endedAt: null, endedReason: null };
    const api = mockApi({
      listClassrooms: vi.fn().mockResolvedValue([classroom]),
      getLocalServerStatus: vi.fn().mockResolvedValue({ running: true, lifecycleState: "running", port: 49561, localUrl: "http://127.0.0.1:49561", serverInstanceId: session.serverInstanceId, candidateUrls: [], webSocketUrls: [], protocolVersion: 1 }),
      getActiveLocalSession: vi.fn().mockResolvedValue(session),
      listQuestionSets: vi.fn().mockResolvedValue([]),
      listSessionQuestions: vi.fn().mockResolvedValue([]),
    });
    render(<App api={api} />);
    await screen.findByText("本機儲存空間已就緒");
    within(screen.getByRole("navigation", { name: "教師導覽" })).getByRole("button", { name: "即時測驗" }).click();
    await screen.findByRole("button", { name: "開始課堂" });
    const liveQuiz = document.querySelector(".live-quiz-page");
    const breadcrumb = screen.getByText("教師工作區 / 即時測驗");
    expect(liveQuiz).not.toBeNull();
    expect((liveQuiz?.compareDocumentPosition(breadcrumb) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("asks before leaving a dirty Group Preset editor", async () => {
    const classroom = { id: "019fe920-0e14-7e40-8a9d-367f86c03bcc", name: "三年甲班", academic_year: null, created_at: "2026-08-11T00:00:00Z", updated_at: "2026-08-11T00:00:00Z" };
    const preset = { id: "preset-1", classroomId: classroom.id, name: "平時分組", groupCount: 1, assignedStudentCount: 0, createdAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z" };
    const api = mockApi({
      listClassrooms: vi.fn().mockResolvedValue([classroom]),
      listGroupPresets: vi.fn().mockResolvedValue([preset]),
      getGroupPreset: vi.fn().mockResolvedValue({ preset, groups: [{ id: "group-1", presetId: preset.id, name: "第一組", position: 0, createdAt: preset.createdAt, updatedAt: preset.updatedAt }], members: [] }),
      listStudents: vi.fn().mockResolvedValue([]),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      render(<App api={api} />);
      await screen.findByText("本機儲存空間已就緒");
      fireEvent.click(screen.getByRole("button", { name: "分組設定" }));
      await screen.findByRole("heading", { name: "編輯「平時分組」" });
      fireEvent.click(screen.getByRole("button", { name: "新增組別" }));
      fireEvent.click(screen.getByRole("button", { name: "首頁" }));
      expect(confirm).toHaveBeenCalledWith("尚有未儲存的變更，確定要離開嗎？");
      expect(screen.getByRole("heading", { name: /編輯/ })).toBeInTheDocument();
      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "首頁" }));
      await screen.findByText("準備好開始下一堂課。");
    } finally {
      confirm.mockRestore();
    }
  });
});
