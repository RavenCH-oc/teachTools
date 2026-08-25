import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeacherApiError } from "../../services/teacherApi";
import type { Classroom, GroupPresetDetail, GroupPresetSummary, Student } from "../../types/teacher";
import { GroupPresetPage, type GroupingApi } from "./GroupPresetPage";

const classroom: Classroom = { id: "class-1", name: "三年甲班", academic_year: "2026", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
const students: Student[] = [
  { id: "student-1", class_id: classroom.id, seat_number: 1, name: "王小明", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: "student-2", class_id: classroom.id, seat_number: 2, name: "李小華", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
];

function summary(id: string, name: string): GroupPresetSummary {
  return { id, classroomId: classroom.id, name, groupCount: 1, assignedStudentCount: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
}

function detail(id: string, name: string, groups = [{ id: "group-1", presetId: id, name: "第一組", position: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }], members = [{ id: "member-1", presetId: id, groupId: "group-1", studentId: "student-1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }]): GroupPresetDetail {
  return { preset: { ...summary(id, name), groupCount: groups.length, assignedStudentCount: members.length }, groups, members };
}

function api(overrides: Partial<GroupingApi> = {}): GroupingApi {
  const first = detail("preset-1", "平時分組");
  return {
    listGroupPresets: vi.fn().mockResolvedValue([summary("preset-1", "平時分組")]),
    getGroupPreset: vi.fn().mockResolvedValue(first),
    createGroupPreset: vi.fn().mockResolvedValue(detail("preset-new", "新分組" , [], [])),
    updateGroupPreset: vi.fn().mockResolvedValue(first),
    deleteGroupPreset: vi.fn().mockResolvedValue(undefined),
    listStudents: vi.fn().mockResolvedValue(students),
    ...overrides,
  };
}

function renderPage(groupingApi: GroupingApi) {
  return render(<GroupPresetPage api={groupingApi} classrooms={[classroom]} initialClassroomId={classroom.id} onBack={vi.fn()} onDirtyChange={vi.fn()} />);
}

describe("GroupPresetPage", () => {
  it("shows the empty state and creates a preset with local group and assignment editing", async () => {
    const created = detail("preset-new", "實驗課分組", [], []);
    const update = vi.fn().mockResolvedValue(detail("preset-new", "實驗課分組", [{ id: "group-new", presetId: "preset-new", name: "第一組", position: 0, createdAt: "now", updatedAt: "now" }], [{ id: "member-new", presetId: "preset-new", groupId: "group-new", studentId: "student-1", createdAt: "now", updatedAt: "now" }]));
    const groupingApi = api({
      listGroupPresets: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([summary("preset-new", "實驗課分組")]),
      createGroupPreset: vi.fn().mockResolvedValue(created),
      updateGroupPreset: update,
    });
    renderPage(groupingApi);

    expect(await screen.findByText("目前還沒有分組預設。")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "建立分組預設" })[0]!);
    expect(screen.getByRole("alert")).toHaveTextContent("請輸入分組預設名稱。");
    fireEvent.change(screen.getByLabelText("建立分組預設"), { target: { value: "實驗課分組" } });
    fireEvent.click(screen.getAllByRole("button", { name: "建立分組預設" })[0]!);
    await screen.findByRole("heading", { name: "編輯「實驗課分組」" });

    fireEvent.click(screen.getByRole("button", { name: "新增組別" }));
    fireEvent.change(screen.getByRole("textbox", { name: "第 1 組名稱" }), { target: { value: "甲組" } });
    const studentGroup = screen.getByLabelText("王小明 分組");
    const newGroupOption = within(studentGroup).getByRole("option", { name: "甲組" }) as HTMLOptionElement;
    fireEvent.change(studentGroup, { target: { value: newGroupOption.value } });
    fireEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const request = update.mock.calls[0]?.[0] as { groups: Array<{ name: string }>; assignments: Array<{ studentId: string }> };
    expect(request.groups[0]?.name).toBe("甲組");
    expect(request.assignments[0]?.studentId).toBe("student-1");
  });

  it("supports rename, reorder, unassign, delete-group semantics, cancel, and dirty switching", async () => {
    const second = detail("preset-2", "報告分組", [{ id: "group-2", presetId: "preset-2", name: "報告組", position: 0 } as GroupPresetDetail["groups"][number]], []);
    const groupingApi = api({
      listGroupPresets: vi.fn().mockResolvedValue([summary("preset-1", "平時分組"), summary("preset-2", "報告分組")]),
      getGroupPreset: vi.fn().mockImplementation((_classroomId: string, presetId: string) => Promise.resolve(presetId === "preset-2" ? second : detail("preset-1", "平時分組", [
        { id: "group-1", presetId: "preset-1", name: "第一組", position: 0, createdAt: "now", updatedAt: "now" },
        { id: "group-2", presetId: "preset-1", name: "第二組", position: 1, createdAt: "now", updatedAt: "now" },
      ]))),
      updateGroupPreset: vi.fn().mockResolvedValue(detail("preset-1", "已儲存", [], [])),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      renderPage(groupingApi);
      await screen.findByRole("heading", { name: "編輯「平時分組」" });
      fireEvent.change(screen.getByRole("textbox", { name: "第 1 組名稱" }), { target: { value: "新第一組" } });
      expect(screen.getByText("尚有未儲存的變更")).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("王小明 分組"), { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "第 1 組刪除" }));
      fireEvent.click(screen.getByRole("button", { name: "取消變更" }));
      await waitFor(() => expect(screen.getByRole("textbox", { name: "第 1 組名稱" })).toHaveValue("第一組"));
      fireEvent.change(screen.getByRole("textbox", { name: "第 1 組名稱" }), { target: { value: "尚未儲存" } });
      confirm.mockReturnValueOnce(false);
      fireEvent.click(screen.getByRole("button", { name: /報告分組/ }));
      expect(screen.getByRole("heading", { name: "編輯「平時分組」" })).toBeInTheDocument();
      confirm.mockReturnValueOnce(true);
      fireEvent.click(screen.getByRole("button", { name: /報告分組/ }));
      await screen.findByRole("heading", { name: "編輯「報告分組」" });
    } finally {
      confirm.mockRestore();
    }
  });

  it("maps controlled backend validation errors to Traditional Chinese", async () => {
    const groupingApi = api({ updateGroupPreset: vi.fn().mockRejectedValue(new TeacherApiError({ code: "group_name_conflict", message: "internal" })) });
    renderPage(groupingApi);
    await screen.findByRole("heading", { name: "編輯「平時分組」" });
    fireEvent.change(screen.getByRole("textbox", { name: "預設名稱" }), { target: { value: "更新名稱" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("同一個分組預設內不能有重複的組別名稱。"));
  });

  it("requires confirmation before deleting a preset", async () => {
    const deletePreset = vi.fn().mockResolvedValue(undefined);
    const groupingApi = api({ deleteGroupPreset: deletePreset });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      renderPage(groupingApi);
      await screen.findByRole("heading", { name: "編輯「平時分組」" });
      const presetList = screen.getByRole("region", { name: "分組預設清單" });
      fireEvent.click(within(presetList).getByRole("button", { name: "刪除" }));
      expect(deletePreset).not.toHaveBeenCalled();
      confirm.mockReturnValue(true);
      fireEvent.click(within(presetList).getByRole("button", { name: "刪除" }));
      await waitFor(() => expect(deletePreset).toHaveBeenCalledWith(classroom.id, "preset-1"));
    } finally {
      confirm.mockRestore();
    }
  });
});
