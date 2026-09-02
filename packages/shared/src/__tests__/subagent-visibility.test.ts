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
} from "../subagent-visibility";

const NOW = 1_800_000_000_000;

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
