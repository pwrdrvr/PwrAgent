import { describe, expect, it, vi } from "vitest";

import { buildPwrAgentAppToolRouter } from "../agent-tools/pwragent-app-agent-tools";

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
        namespace: "pwragent_app",
        name: "manage_pwragent",
      }),
    ]);

    await expect(
      router.handleDynamicToolCall({
        backend: "codex",
        call: {
          threadId: "agent-thread",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "pwragent_app",
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
          namespace: "pwragent_app",
          tool: "manage_pwragent",
          arguments: { action: "launch_missiles" },
        },
      }),
    ).resolves.toMatchObject({ success: false });
    expect(handler).not.toHaveBeenCalled();
  });
});
