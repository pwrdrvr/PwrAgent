import { describe, expect, it } from "vitest";
import { AcpSubAgentTracker } from "../acp/acp-subagents";

/**
 * Antigravity 1.5 relays a worker's own tool calls on the parent session,
 * with ids `<child conversation>:<call>`, and its launch names no
 * conversation. These frames follow the captured order: the launch, then the
 * worker's `ls -la` and `pwd`, then the parent turn ending.
 */
const launch = (toolCallId: string, role: string, status: "in_progress" | "completed") => ({
  sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update",
  toolCallId, name: "invoke_subagent", title: "Run invoke_subagent", kind: "other", status,
  rawInput: { Prompt: "Run `ls -la`, then `pwd`, then read notes.txt.", Role: role, TypeName: "self" },
});
const step = (conversation: string, call: string, title: string, kind = "execute") => ({
  sessionUpdate: "tool_call", toolCallId: `${conversation}:${call}`, title, kind, status: "pending",
  rawInput: { CommandLine: title },
});

describe("ACP sub-agent step lines", () => {
  it("show a worker's latest step under its card, and none once its turn settles", () => {
    const tracker = new AcpSubAgentTracker(() => 1_000);
    tracker.apply({ backendId: "acp:antigravity", turnId: "turn-1", update: launch("call_2077", "Folder Inspector", "in_progress") });
    tracker.apply({ backendId: "acp:antigravity", turnId: "turn-1", update: launch("call_2077", "Folder Inspector", "completed") });
    tracker.takeDirtySubAgentCards();

    expect(tracker.observeStep(step("32e00c43-8734-4a37-be08-6f79fda02d23", "call_7264", "ls -la"))).toBe(true);
    expect(tracker.subAgentActivities()).toEqual([{ monitorId: "acp-native:call_2077", activity: "Running ls -la" }]);
    expect(tracker.observeStep(step("32e00c43-8734-4a37-be08-6f79fda02d23", "call_7832", "pwd"))).toBe(true);
    expect(tracker.subAgentActivities()).toEqual([{ monitorId: "acp-native:call_2077", activity: "Running pwd" }]);
    // A step is live only: it never dirties the durable card.
    expect(tracker.takeDirtySubAgentCards()).toEqual([]);

    tracker.settleTurn({ turnId: "turn-1", outcome: "completed" });
    expect(tracker.subAgentActivities()).toEqual([]);
  });

  it("shows no line when it cannot tell which running worker a conversation belongs to", () => {
    const tracker = new AcpSubAgentTracker(() => 1_000);
    tracker.apply({ backendId: "acp:antigravity", turnId: "turn-1", update: launch("call_a", "Reader", "in_progress") });
    tracker.apply({ backendId: "acp:antigravity", turnId: "turn-1", update: launch("call_b", "Writer", "in_progress") });
    expect(tracker.observeStep(step("11111111-aaaa-4bbb-8ccc-dddddddddddd", "call_1", "ls -la"))).toBe(false);
    expect(tracker.subAgentActivities()).toEqual([]);
  });

  it("ignores the parent's own tool calls", () => {
    const tracker = new AcpSubAgentTracker(() => 1_000);
    tracker.apply({ backendId: "acp:antigravity", turnId: "turn-1", update: launch("call_a", "Reader", "in_progress") });
    expect(tracker.observeStep({ sessionUpdate: "tool_call", toolCallId: "call_9", title: "git status", kind: "execute" }))
      .toBe(false);
    expect(tracker.subAgentActivities()).toEqual([]);
  });

  it("ignores a parent call whose id merely contains a colon", () => {
    // Only a child conversation's UUID prefixes a worker's step; another
    // agent may name its own calls `functions.run:12`.
    const tracker = new AcpSubAgentTracker(() => 1_000);
    tracker.apply({ backendId: "acp:antigravity", turnId: "turn-1", update: launch("call_a", "Reader", "in_progress") });
    for (const toolCallId of ["functions.run:12", "toolu_abcdefgh:1", "32e00c43-8734-4a37-be08:call_1"]) {
      expect(tracker.observeStep({ sessionUpdate: "tool_call", toolCallId, title: "git status", kind: "execute" }))
        .toBe(false);
    }
    expect(tracker.subAgentActivities()).toEqual([]);
    // The worker's own step still ties to the one running launch.
    expect(tracker.observeStep(step("32e00c43-8734-4a37-be08-6f79fda02d23", "call_7264", "ls -la"))).toBe(true);
    expect(tracker.subAgentActivities()).toEqual([{ monitorId: "acp-native:call_a", activity: "Running ls -la" }]);
  });
});
