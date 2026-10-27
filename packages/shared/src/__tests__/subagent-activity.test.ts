import { describe, expect, it } from "vitest";
import {
  buildSubAgentActivityDetail,
  codexAgentPathName,
  codexNativeSubAgentName,
  readCodexNativeSubAgentName,
  readSubAgentActivity,
} from "../subagent-activity";

describe("Codex worker names", () => {
  it("prefers the parent's path segment, then Codex's nickname", () => {
    expect(codexNativeSubAgentName({
      agentPath: "/root/breakfast_politics", agentNickname: "Jason",
    })).toBe("breakfast_politics");
    expect(codexNativeSubAgentName({ agentPath: null, agentNickname: "@Jason" })).toBe("Jason");
    expect(codexNativeSubAgentName({})).toBeUndefined();
  });

  it("does not name a worker after the root agent", () => {
    expect(codexAgentPathName("/root")).toBeUndefined();
    expect(codexAgentPathName("/root/review/style_pass")).toBe("style_pass");
    expect(codexAgentPathName("")).toBeUndefined();
  });

  it("finds a path anywhere before a nickname anywhere", () => {
    // An agent state that carries only a nickname must not outrank the
    // receiver thread's path, whichever is passed first.
    const state = { status: "running", agent_nickname: "Jason" };
    const receiverThread = {
      id: "worker-1",
      source: {
        subAgent: {
          thread_spawn: {
            agent_path: "/root/breakfast_politics",
            agent_nickname: "Jason",
          },
        },
      },
    };
    expect(readCodexNativeSubAgentName(state, receiverThread)).toBe("breakfast_politics");
    expect(readCodexNativeSubAgentName({ thread: receiverThread })).toBe("breakfast_politics");
    expect(readCodexNativeSubAgentName(state)).toBe("Jason");
    expect(readCodexNativeSubAgentName(undefined, { status: "running" })).toBeUndefined();
  });

  it("names a subAgentActivity report by its path", () => {
    expect(readSubAgentActivity({
      type: "subAgentActivity", id: "a", kind: "started",
      agentThreadId: "worker-1", agentPath: "/root/breakfast_poem",
    })).toMatchObject({ agentName: "breakfast_poem" });
  });
});

describe("Codex worker metadata", () => {
  it.each([
    { model: "resolved-model", reasoningEffort: "high" },
    { model: null, reasoningEffort: null },
    {},
    { model: 42, reasoningEffort: false },
    { model: "", reasoningEffort: " " },
  ])("preserves only reported metadata: %j", (metadata) => {
    const report = readSubAgentActivity({
      type: "subAgentActivity", id: "a", kind: "started",
      agentThreadId: "worker", agentPath: "/root/worker", ...metadata,
    })!;
    const detail = buildSubAgentActivityDetail(report).command!.subAgent!;
    const known = metadata.model === "resolved-model";
    expect(report.model).toBe(known ? "resolved-model" : undefined);
    expect(report.reasoningEffort).toBe(known ? "high" : undefined);
    expect(detail.model).toBe(report.model);
    expect(detail.reasoningEffort).toBe(report.reasoningEffort);
  });
});
