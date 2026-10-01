import { invoke } from "@tauri-apps/api/core";
import {
  remoteTeacherSessionStatusSchema,
  remoteTeacherStatusSchema,
  type RemoteTeacherSessionStatus,
  type RemoteTeacherStatus,
} from "@classtools/backend-contract";
import { TeacherApiError } from "./teacherApi";

async function call(command: string, args?: Record<string, unknown>): Promise<unknown> {
  try { return await invoke<unknown>(command, args); }
  catch (error) { throw new TeacherApiError(error); }
}

export interface RemoteTeacherApi {
  status(): Promise<RemoteTeacherStatus>;
  enroll(activationCode: string): Promise<void>;
  create(classroomId: string): Promise<RemoteTeacherSessionStatus>;
  close(): Promise<void>;
}

export const remoteTeacherApi: RemoteTeacherApi = {
  status: async () => remoteTeacherStatusSchema.parse(await call("get_remote_control_status")),
  enroll: async (activationCode) => { await call("enroll_remote_installation", { activationCode }); },
  create: async (classroomId) => remoteTeacherSessionStatusSchema.parse(
    await call("create_remote_session", { classroomId })),
  close: async () => { await call("close_remote_session"); },
};
