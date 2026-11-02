import { describe, expect, it } from "vitest";
import { buildMonitorDelegationPrompt } from "../app-server/task-monitor-codex-tools";

const base = {
  monitorId: "monitor-1",
  parentThreadId: "parent-1",
  pollIntervalSeconds: 300,
  task: "Wait for PR #8 to merge.",
};

describe("buildMonitorDelegationPrompt", () => {
  // Claude Code refuses `sleep 300; gh pr view …` and offers Monitor or
  // run_in_background. A Claude monitor told only to poll every 300 seconds
  // checked once, ended its turn, and reported no result.
  it("tells a Claude monitor to wait in a watcher and end its turn", () => {
    const prompt = buildMonitorDelegationPrompt({ ...base, claudeCode: true });
    expect(prompt).toContain("select:mcp__pwragent__inject_progress");
    expect(prompt).toContain("wait between checks with one Monitor watcher");
    expect(prompt).toContain("otherwise sleep 300 seconds");
    expect(prompt).toContain("After you start the watcher, end your turn.");
    // The parent's waiting guidance forbids Monitor; it is not this monitor's.
    expect(prompt).toContain("is for parent agents. It does not apply to this monitor.");
  });

  it("leaves a Codex monitor polling in its own shell", () => {
    const prompt = buildMonitorDelegationPrompt(base);
    expect(prompt).toContain("Repeat the delegated status check about every 300 seconds");
    expect(prompt).not.toContain("Monitor watcher");
    expect(prompt).not.toContain("ToolSearch");
  });
});
