import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandoffInstanceThreadResult } from "@pwragent/shared";
import { FEDERATION_HANDOFF_THREAD_CHANNEL } from "../../shared/ipc";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      },
    ),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

const runtime = {
  handoffInstanceThread: vi.fn(),
};

vi.mock("../federation/federation-runtime", () => ({
  getDesktopFederationRuntime: () => runtime,
}));
vi.mock("../federation/federation-tailscale", () => ({
  getFederationTailscaleService: () => ({}),
}));
vi.mock("../federation/federation-window", () => ({
  createFederationWindow: vi.fn(),
}));

const result: HandoffInstanceThreadResult = {
  handoffId: "handoff-1",
  sourceThreadId: "thread-1",
  instanceId: "pwr_studio",
  backend: "codex",
  threadId: "thread-2",
  directoryPath: "/Users/operator/src/PwrAgent/.worktrees/abc/PwrAgent",
  sourceArchived: false,
  warnings: [],
};

async function invokeHandoff(request: unknown): Promise<unknown> {
  const { registerFederationIpcHandlers } = await import("../ipc/federation");
  registerFederationIpcHandlers();
  return await handlers.get(FEDERATION_HANDOFF_THREAD_CHANNEL)!({}, request);
}

describe("federation handoff-thread ipc", () => {
  beforeEach(() => {
    handlers.clear();
    runtime.handoffInstanceThread.mockReset().mockResolvedValue(result);
  });

  it("sends a local thread with only the fields the backend reads", async () => {
    await expect(invokeHandoff({
      sourceThreadId: "thread-1",
      targetInstanceId: "pwr_studio",
      operation: "move",
      targetRepositoryPath: "  /Users/operator/src/PwrAgent ",
      sourceInstanceId: "pwr_other",
    })).resolves.toEqual(result);

    // The dialog only sends threads this window owns: a renderer-supplied
    // source instance never reaches the runtime.
    expect(runtime.handoffInstanceThread).toHaveBeenCalledWith({
      sourceThreadId: "thread-1",
      targetInstanceId: "pwr_studio",
      operation: "move",
      targetRepositoryPath: "/Users/operator/src/PwrAgent",
    });
  });

  it("omits a blank repository path, as a Workspaces thread sends none", async () => {
    await invokeHandoff({
      sourceThreadId: "thread-1",
      targetInstanceId: "pwr_studio",
      operation: "copy",
      targetRepositoryPath: "   ",
    });
    expect(runtime.handoffInstanceThread).toHaveBeenCalledWith({
      sourceThreadId: "thread-1",
      targetInstanceId: "pwr_studio",
      operation: "copy",
    });
  });

  it.each([
    ["no thread", { targetInstanceId: "pwr_studio", operation: "copy" }],
    ["a malformed instance id", { sourceThreadId: "thread-1", targetInstanceId: "../x", operation: "copy" }],
    ["an unknown operation", { sourceThreadId: "thread-1", targetInstanceId: "pwr_studio", operation: "fork" }],
    ["a non-string path", { sourceThreadId: "thread-1", targetInstanceId: "pwr_studio", operation: "copy", targetRepositoryPath: 7 }],
  ])("rejects %s before reaching the runtime", async (_label, request) => {
    await expect(invokeHandoff(request)).rejects.toThrow("Invalid thread handoff request");
    expect(runtime.handoffInstanceThread).not.toHaveBeenCalled();
  });
});
