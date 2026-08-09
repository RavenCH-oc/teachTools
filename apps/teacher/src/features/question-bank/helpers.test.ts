import { describe, expect, it } from "vitest";
import type { Question, QuestionAsset } from "@classtools/domain";
import { questionToPublicView } from "./helpers";

const question: Question = { id: "q-1", questionSetId: "set-1", type: "true_false", prompt: "Safe?", points: 1, position: 0, metadata: {}, configVersion: 1, createdAt: "now", updatedAt: "now", answerConfig: { correctAnswer: true } };
const asset: QuestionAsset = { id: "asset-1", questionId: "q-1", assetType: "pdf", displayName: "chapter.pdf", mimeType: "application/pdf", sizeBytes: 42, position: 0, pageReference: 3, createdAt: "now", status: "ready" };

describe("Question public projection", () => {
  it("includes safe media references without answers or storage metadata", () => {
    const publicView = questionToPublicView(question, [asset]);
    expect(publicView).not.toHaveProperty("answerConfig");
    expect(publicView.assets).toEqual([{ id: "asset-1", assetType: "pdf", displayName: "chapter.pdf", mimeType: "application/pdf", sizeBytes: 42, position: 0, pageReference: 3 }]);
    expect(JSON.stringify(publicView)).not.toMatch(/storagePath|sha256|C:\\\\Users/);
  });
});
