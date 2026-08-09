export const APP_NAME = "Classroom" as const;
export const SHARED_PACKAGE_VERSION = 1 as const;

export type AppRuntimeInfo = {
  appName: typeof APP_NAME;
  phase: "Phase 1";
};
