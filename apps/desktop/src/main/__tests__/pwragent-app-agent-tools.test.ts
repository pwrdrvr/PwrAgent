import { describe, expect, it, vi } from "vitest";

import { buildPwrAgentAppToolRouter } from "../agent-tools/pwragent-app-agent-tools";
import { handlePwrAgentAppDynamicToolCall } from "../agent-tools/pwragent-app-codex-tools";

describe("PwrAgent app agent tools", () => {
  it("projects manage_pwragent and dispatches normalized actions", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        action: "status" as const,
        runtime: {
          currentVersion: "1.2.3",
          startedAt: 1_000,
          startedAtIso: "1970-01-01T00:00:01.000Z",
          startedAtLocal: "Jan 1, 1970, 12:00:01 AM",
          now: 61_000,
          nowIso: "1970-01-01T00:01:01.000Z",
          nowLocal: "Jan 1, 1970, 12:01:01 AM",
          uptimeMs: 60_000,
          uptimeHuman: "1m 0s",
        },
        update: {
          status: { status: "idle" as const },
          updateAvailableToDownload: false,
          updateDownloadedWillInstallOnRestart: false,
        },
        result: { status: "reported" as const },
      },
    }));
    const router = buildPwrAgentAppToolRouter(handler);

    expect(router.buildDynamicToolSpecs()).toEqual([
      expect.objectContaining({
        type: "namespace",
        name: "pwragent",
        tools: [
          expect.objectContaining({
            type: "function",
            name: "manage_pwragent",
          }),
        ],
      }),
    ]);

    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "agent-thread",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent",
          tool: "manage_pwragent",
          arguments: { action: "status" },
        },
      }),
    ).resolves.toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: expect.stringContaining('"currentVersion": "1.2.3"'),
        },
      ],
    });
    expect(handler).toHaveBeenCalledWith({
      operation: "manage_pwragent",
      context: {},
      args: { action: "status" },
    });
  });

  it("rejects unknown app management actions before dispatch", async () => {
    const handler = vi.fn();
    const router = buildPwrAgentAppToolRouter(handler);

    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "agent-thread",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent",
          tool: "manage_pwragent",
          arguments: { action: "launch_missiles" },
        },
      }),
    ).resolves.toMatchObject({ success: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it("accepts the legacy pwragent_app namespace as an invocation alias", async () => {
    const handler = vi.fn(async () => ({
      ok: true as const,
      data: {
        action: "stop" as const,
        runtime: {
          currentVersion: "1.2.3",
          startedAt: 1_000,
          startedAtIso: "1970-01-01T00:00:01.000Z",
          startedAtLocal: "Jan 1, 1970, 12:00:01 AM",
          now: 61_000,
          nowIso: "1970-01-01T00:01:01.000Z",
          nowLocal: "Jan 1, 1970, 12:01:01 AM",
          uptimeMs: 60_000,
          uptimeHuman: "1m 0s",
        },
        update: {
          status: { status: "idle" as const },
          updateAvailableToDownload: false,
          updateDownloadedWillInstallOnRestart: false,
        },
        result: { status: "stop_accepted" as const },
      },
    }));

    await expect(
      handlePwrAgentAppDynamicToolCall({
        backend: "codex",
        handler,
        call: {
          threadId: "agent-thread",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent_app",
          tool: "manage_pwragent",
          arguments: { action: "stop" },
        },
      }),
    ).resolves.toMatchObject({ success: true });
    expect(handler).toHaveBeenCalledWith({
      operation: "manage_pwragent",
      context: {},
      args: { action: "stop" },
    });
  });
});
