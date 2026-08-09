export const DOMAIN_PACKAGE_VERSION = 1 as const;

export type Question = {
  id: string;
  type: "true_false" | "single_choice" | "multiple_choice" | "fill_blank" | "essay";
  prompt: string;
};

export type Student = {
  id: string;
  displayName: string;
  seatNumber: number | null;
};

export type Session = {
  id: string;
  state: "CREATED" | "LOBBY" | "ACTIVE" | "PAUSED" | "ENDED" | "ARCHIVED";
};

export type Submission = {
  submissionId: string;
  questionId: string;
  answer: unknown;
};
