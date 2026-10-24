import { describe, expect, it } from "vitest";
import type { AppServerThreadEntry } from "@pwragent/shared";
import { injectMessagingBindingTransitions } from "../messaging-binding-transition-entries";
import { injectPermissionTransitions } from "../permission-transition-entries";
import { injectQuestionnaireActivities } from "../questionnaire-activity-entries";
import { injectTurnFailures } from "../turn-failure-entries";

// The shape of a real coordinator thread. Rows carry timestamps from different
// clocks: Codex stamps a turn's final message with its second-truncated
// completion time, the renderer stamps the turn total when it mints it, and a
// live read can carry the receipt time forward onto the final message. So the
// final message can read as later than the turn total that follows it, and
// commentary and tool rows carry no timestamp at all. The array order is the
// owner's order, and adding an unrelated synthetic row must not change it.
const turnA = { id: "turn-a", status: "completed" as const };
const turnB = { id: "turn-b", status: "completed" as const };
const transcript: AppServerThreadEntry[] = [
  {
    type: "activity",
    id: "live-turn-usage-turn-a",
    summary: "Turn usage: 124,957 uncached in",
    status: "completed",
    details: [],
    createdAt: 1_000_500,
    turn: turnA,
  },
  {
    type: "message",
    id: "from-thread",
    role: "user",
    text: "Handled stale train PR dependency wake.",
    createdAt: 2_000_000,
    turn: turnB,
  },
  {
    type: "message",
    id: "commentary",
    role: "assistant",
    phase: "commentary",
    text: "Checking both PRs.",
    turn: turnB,
  },
  {
    type: "activity",
    id: "tool-work",
    summary: "Ran 2 commands",
    status: "completed",
    details: [],
    turn: turnB,
  },
  {
    type: "message",
    id: "acknowledged",
    role: "assistant",
    phase: "final",
    text: "Acknowledged: PR65 is reported merged.",
    createdAt: 2_005_400,
    turn: turnB,
  },
  {
    type: "activity",
    id: "live-turn-usage-turn-b",
    summary: "Turn usage: 94,799 uncached in",
    status: "completed",
    details: [],
    createdAt: 2_005_000,
    turn: turnB,
  },
];
const transcriptIds = transcript.map((entry) => entry.id);

function idsWithout(entries: AppServerThreadEntry[], syntheticId: string): string[] {
  return entries.map((entry) => entry.id).filter((id) => id !== syntheticId);
}

describe("synthetic transcript rows", () => {
  it("keeps transcript order when a messaging binding transition is injected", () => {
    const merged = injectMessagingBindingTransitions(transcript, [{
      id: "bind-1",
      action: "bound",
      bindingId: "binding-1",
      platform: "telegram",
      conversationKind: "topic",
      conversationTitle: "Topic",
      occurredAt: 500,
    }]);

    expect(merged.map((entry) => entry.id)).toEqual([
      "messaging-binding-transition-bind-1",
      ...transcriptIds,
    ]);
  });

  it("keeps transcript order when a permission transition is injected", () => {
    const merged = injectPermissionTransitions(transcript, [{
      id: "perm-1",
      fromExecutionMode: "default",
      toExecutionMode: "full-access",
      status: "applied",
      occurredAt: 1_500_000,
    }]);

    expect(idsWithout(merged, "permission-transition-perm-1")).toEqual(transcriptIds);
    expect(merged.map((entry) => entry.id).indexOf("permission-transition-perm-1"))
      .toBe(1);
  });

  it("keeps transcript order when a questionnaire activity is injected", () => {
    const merged = injectQuestionnaireActivities(transcript, [{
      id: "q-1",
      requestId: "request-1",
      threadId: "thread-1",
      status: "submitted",
      questions: [],
      createdAt: 500,
      updatedAt: 500,
    }]);
    const syntheticId = merged.find((entry) => !transcriptIds.includes(entry.id))?.id;

    expect(syntheticId).toBeDefined();
    expect(idsWithout(merged, syntheticId!)).toEqual(transcriptIds);
  });

  it("keeps transcript order when a turn failure is injected", () => {
    const merged = injectTurnFailures(transcript, [{
      id: "fail-1",
      turnId: "turn-c",
      error: "Model overloaded",
      occurredAt: 3_000_000,
    }]);
    const syntheticId = merged.find((entry) => !transcriptIds.includes(entry.id))?.id;

    expect(syntheticId).toBeDefined();
    expect(merged.map((entry) => entry.id)).toEqual([...transcriptIds, syntheticId]);
  });

  it("places a synthetic row after an existing entry stamped at the same time", () => {
    const turn = { id: "turn-c", status: "failed" as const };
    const merged = injectTurnFailures([
      { type: "message", id: "prompt", role: "user", text: "Go", createdAt: 100, turn },
      { type: "activity", id: "last-work", summary: "Ran 1 command", status: "completed", details: [], createdAt: 200, turn },
      { type: "message", id: "next-prompt", role: "user", text: "Retry", createdAt: 300 },
    ], [{
      id: "fail-1",
      turnId: "turn-c",
      error: "Model overloaded",
      occurredAt: 200,
    }]);

    // The failure marker follows the work it describes, never shoves it down.
    expect(merged.map((entry) => entry.id)).toEqual([
      "prompt",
      "last-work",
      "turn-failed:turn-c",
      "next-prompt",
    ]);
  });

  it("places a synthetic row before the first later entry without moving untimed rows", () => {
    const merged = injectMessagingBindingTransitions(transcript, [{
      id: "bind-2",
      action: "unbound",
      bindingId: "binding-1",
      platform: "telegram",
      occurredAt: 2_005_200,
    }]);

    // 2,005,200 is after the prompt and before the final message. The untimed
    // commentary and tool rows stay between them instead of floating to the
    // top as if they had happened at time zero.
    expect(merged.map((entry) => entry.id)).toEqual([
      "live-turn-usage-turn-a",
      "from-thread",
      "commentary",
      "tool-work",
      "messaging-binding-transition-bind-2",
      "acknowledged",
      "live-turn-usage-turn-b",
    ]);
  });
});
