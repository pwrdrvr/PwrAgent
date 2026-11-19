import { describe, expect, it } from "vitest";
import type {
  CodexNativeSubAgentSummary,
  ThreadSubAgentSummary,
} from "../index";
import {
  CODEX_NATIVE_SUBAGENT_NAVIGATION_RETENTION_MS,
  CODEX_NATIVE_SUBAGENT_PANEL_RETENTION_MS,
  isCodexNativeSubAgentVisibleInNavigation,
  isThreadSubAgentVisibleInPanel,
  projectActiveThreadSubAgents,
} from "../subagent-visibility";

const NOW = 1_800_000_000_000;

describe("active sub-agent display", () => {
  it("keeps live rows and both failure spellings while excluding terminal evidence", () => {
    const live = { monitorId: "running", task: "Watch the build", status: "running" as const,
      createdAt: NOW, updatedAt: NOW, monitorThreadId: "child", monitorTurnId: "turn" };
    expect(projectActiveThreadSubAgents([
      live,
      { ...live, monitorId: "blocked", status: "blocked" },
      { ...live, monitorId: "pending", status: "pending" },
      { ...live, monitorId: "cancelling", status: "cancelling" },
      { ...live, monitorId: "failed", status: "failed" },
      { ...live, monitorId: "failure", status: "failure", completedAt: NOW },
      { ...live, monitorId: "done", status: "success" },
      { ...live, monitorId: "cancelled", status: "cancelled" },
      { ...live, monitorId: "completed", completedAt: NOW },
      { ...live, monitorId: "outcome", outcome: "success" },
      { ...live, monitorId: "boundary", completionSource: { type: "monitor_tool" } },
    ]).map((agent) => agent.monitorId)).toEqual(["running", "blocked", "pending", "cancelling", "failed", "failure"]);
  });

  // Rule: decision batches are not sub-agents. Cards an earlier version
  // wrote for them, whatever their status, never reach the strip or the
  // Sub-agents tab; every other monitor kind is unaffected.
  it("hides cards an earlier version wrote for decision batches", () => {
    const base = { task: "Decision batch triage: 3 of 40 done", createdAt: NOW, updatedAt: NOW };
    const statuses = ["running", "failed", "failure", "success", "cancelled"] as const;
    const legacy: ThreadSubAgentSummary[] = statuses.map((status) => ({
      ...base,
      monitorId: `system:decision-batch:batch_${status}`,
      status,
    }));
    const monitor: ThreadSubAgentSummary = { ...base, monitorId: "monitor-1", status: "running" };
    expect(projectActiveThreadSubAgents([...legacy, monitor]).map((agent) => agent.monitorId)).toEqual(["monitor-1"]);
    for (const card of legacy) expect(isThreadSubAgentVisibleInPanel(card, NOW)).toBe(false);
    expect(isThreadSubAgentVisibleInPanel(monitor, NOW)).toBe(true);
  });
});

function nativeSummary(
  overrides: Partial<CodexNativeSubAgentSummary> = {},
): CodexNativeSubAgentSummary {
  return {
    threadId: "native-worker",
    title: "Native worker",
    threadStatus: "idle",
    updatedAt: NOW,
    ...overrides,
  };
}

function panelSummary(
  overrides: Partial<ThreadSubAgentSummary> = {},
): ThreadSubAgentSummary {
  return {
    monitorId: "codex-native:native-worker",
    task: "Native worker",
    status: "success",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

describe("Codex native sub-agent visibility", () => {
  it("keeps active and recently active workers in navigation", () => {
    expect(isCodexNativeSubAgentVisibleInNavigation(nativeSummary({
      threadStatus: "active",
      updatedAt: NOW - (14 * 24 * 60 * 60 * 1000),
    }), NOW)).toBe(true);
    expect(isCodexNativeSubAgentVisibleInNavigation(nativeSummary({
      updatedAt: NOW - CODEX_NATIVE_SUBAGENT_NAVIGATION_RETENTION_MS,
    }), NOW)).toBe(true);
  });

  it("hides stale idle workers from navigation", () => {
    expect(isCodexNativeSubAgentVisibleInNavigation(nativeSummary({
      updatedAt: NOW - CODEX_NATIVE_SUBAGENT_NAVIGATION_RETENTION_MS - 1,
    }), NOW)).toBe(false);
  });

  it("keeps workers whose age cannot be established", () => {
    expect(isCodexNativeSubAgentVisibleInNavigation(nativeSummary({
      createdAt: undefined,
      updatedAt: undefined,
    }), NOW)).toBe(true);
  });

  it("keeps native workers in the selected-thread panel for one day", () => {
    expect(isThreadSubAgentVisibleInPanel(panelSummary({
      completedAt: NOW - CODEX_NATIVE_SUBAGENT_PANEL_RETENTION_MS,
    }), NOW)).toBe(true);
    expect(isThreadSubAgentVisibleInPanel(panelSummary({
      completedAt: NOW - CODEX_NATIVE_SUBAGENT_PANEL_RETENTION_MS - 1,
    }), NOW)).toBe(false);
  });

  it("does not age out active native workers or other monitor kinds", () => {
    expect(isThreadSubAgentVisibleInPanel(panelSummary({
      completedAt: undefined,
      outcome: undefined,
      status: "running",
      updatedAt: 1,
    }), NOW)).toBe(true);
    expect(isThreadSubAgentVisibleInPanel(panelSummary({
      monitorId: "monitor:pwragent",
      completedAt: 1,
      updatedAt: 1,
    }), NOW)).toBe(true);
  });
});
