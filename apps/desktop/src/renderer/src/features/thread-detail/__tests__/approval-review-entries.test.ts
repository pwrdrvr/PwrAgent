import { describe, expect, it } from "vitest";
import type { AppServerThreadMessageEntry } from "@pwragent/shared";
import { buildTranscriptRenderItems } from "../transcript-render-items";
import { injectApprovalReviews } from "../approval-review-entries";

describe("approval review transcript entries", () => {
  const finalAnswer: AppServerThreadMessageEntry = {
    type: "message",
    id: "final-1",
    role: "assistant",
    phase: "final",
    text: "Fixture health is good.",
    createdAt: 3_000,
    turn: { id: "turn-1", status: "completed", completedAt: 3_000 },
  };

  it("adds one row per decision, with the reviewer's reason, inside the turn's work", () => {
    const entries = injectApprovalReviews([finalAnswer], [
      { id: "a", kind: "invocation", action: "accept", subject: "Fixture / lookup", reason: "Reads the requested record.", turnId: "turn-1", occurredAt: 1_000 },
      { id: "b", kind: "question", action: "cancel", subject: "a question from Fixture", reason: "The task does not say.", turnId: "turn-1", occurredAt: 2_000 },
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(["approval-review:a", "approval-review:b", "final-1"]);
    expect(entries[0]).toMatchObject({
      type: "activity",
      summary: "Approval reviewer allowed Fixture / lookup",
      status: "completed",
      details: [{ label: "Reviewer's reason", markdown: "Reads the requested record." }],
    });
    expect(entries[0]).not.toHaveProperty("tone", "warning");
    expect(entries[1]).toMatchObject({ summary: "Approval reviewer cancelled a question from Fixture", tone: "warning" });
    expect(buildTranscriptRenderItems({ entries })).toMatchObject([
      { type: "workPhaseGroup", entries: [{ id: "approval-review:a" }, { id: "approval-review:b" }] },
      { type: "entry", entry: finalAnswer },
    ]);
  });

  it("leaves the entries untouched without decisions", () => {
    const entries = [finalAnswer];
    expect(injectApprovalReviews(entries, undefined)).toBe(entries);
    expect(injectApprovalReviews(entries, [])).toBe(entries);
  });
});
