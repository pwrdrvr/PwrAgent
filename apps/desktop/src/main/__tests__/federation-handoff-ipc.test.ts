import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandoffInstanceThreadResult, ThreadHandoffProgress } from "@pwragent/shared";
import {
  FEDERATION_CANCEL_HANDOFF_THREAD_CHANNEL,
  FEDERATION_HANDOFF_THREAD_CHANNEL,
  FEDERATION_HANDOFF_THREAD_PROGRESS_CHANNEL,
  FEDERATION_RETRY_HANDOFF_THREAD_NOW_CHANNEL,
  THREAD_HANDOFF_CANCELLED_MESSAGE,
} from "../../shared/ipc";
import type { ThreadHandoffSendOptions } from "../federation/thread-instance-handoff-service";

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

const HANDOFF_ID = "0f0e0d0c-0b0a-4908-8706-050403020100";

function windowSender(id = 1) {
  const destroyed: Array<() => void> = [];
  const sent: ThreadHandoffProgress[] = [];
  return {
    id,
    sent,
    destroy: () => destroyed.forEach((listener) => listener()),
    isDestroyed: () => false,
    send: (channel: string, progress: ThreadHandoffProgress) => {
      expect(channel).toBe(FEDERATION_HANDOFF_THREAD_PROGRESS_CHANNEL);
      sent.push(progress);
    },
    once: (_event: "destroyed", listener: () => void) => {
      destroyed.push(listener);
    },
  };
}

async function register(): Promise<void> {
  const { registerFederationIpcHandlers } = await import("../ipc/federation");
  registerFederationIpcHandlers();
}

async function invokeHandoff(request: unknown, sender = windowSender()): Promise<unknown> {
  await register();
  return await handlers.get(FEDERATION_HANDOFF_THREAD_CHANNEL)!({ sender }, request);
}

function progress(overrides: Partial<ThreadHandoffProgress>): ThreadHandoffProgress {
  return {
    handoffId: HANDOFF_ID,
    sourceThreadId: "thread-1",
    phase: "send",
    link: "connected",
    cancelable: true,
    transport: "single_shot",
    ...overrides,
  };
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
      handoffId: HANDOFF_ID,
    })).resolves.toEqual(result);

    // The dialog only sends threads this window owns: a renderer-supplied
    // source instance never reaches the runtime.
    expect(runtime.handoffInstanceThread).toHaveBeenCalledWith({
      sourceThreadId: "thread-1",
      targetInstanceId: "pwr_studio",
      operation: "move",
      handoffId: HANDOFF_ID,
      targetRepositoryPath: "/Users/operator/src/PwrAgent",
    }, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("omits a blank repository path, as a Workspaces thread sends none", async () => {
    await invokeHandoff({
      sourceThreadId: "thread-1",
      targetInstanceId: "pwr_studio",
      operation: "copy",
      targetRepositoryPath: "   ",
      handoffId: HANDOFF_ID,
    });
    expect(runtime.handoffInstanceThread).toHaveBeenCalledWith({
      sourceThreadId: "thread-1",
      targetInstanceId: "pwr_studio",
      operation: "copy",
      handoffId: HANDOFF_ID,
    }, undefined, expect.any(Object));
  });

  it.each([
    ["no thread", { targetInstanceId: "pwr_studio", operation: "copy" }],
    ["a malformed instance id", { sourceThreadId: "thread-1", targetInstanceId: "../x", operation: "copy" }],
    ["an unknown operation", { sourceThreadId: "thread-1", targetInstanceId: "pwr_studio", operation: "fork" }],
    ["a non-string path", { sourceThreadId: "thread-1", targetInstanceId: "pwr_studio", operation: "copy", targetRepositoryPath: 7, handoffId: HANDOFF_ID }],
    ["no handoff id", { sourceThreadId: "thread-1", targetInstanceId: "pwr_studio", operation: "copy" }],
    ["a handoff id that is not a UUID", { sourceThreadId: "thread-1", targetInstanceId: "pwr_studio", operation: "copy", handoffId: "../x" }],
  ])("rejects %s before reaching the runtime", async (_label, request) => {
    await expect(invokeHandoff(request)).rejects.toThrow("Invalid thread handoff request");
    expect(runtime.handoffInstanceThread).not.toHaveBeenCalled();
  });

  it("sends each step change at once and throttles only mid-send byte counts", async () => {
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    runtime.handoffInstanceThread.mockImplementation(async (
      _request: unknown,
      _source: unknown,
      options: ThreadHandoffSendOptions,
    ) => {
      options.onProgress?.(progress({ phase: "package" }));
      options.onProgress?.(progress({ bytesCommitted: 0, bytesTotal: 300 }));
      clock += 10;
      options.onProgress?.(progress({ bytesCommitted: 100, bytesTotal: 300 }));
      clock += 200;
      options.onProgress?.(progress({ bytesCommitted: 200, bytesTotal: 300 }));
      clock += 10;
      options.onProgress?.(progress({ bytesCommitted: 250, bytesTotal: 300, link: "waiting" }));
      options.onProgress?.(progress({ bytesCommitted: 300, bytesTotal: 300 }));
      options.onProgress?.(progress({ phase: "import", cancelable: false }));
      return result;
    });
    const sender = windowSender();
    await invokeHandoff({
      sourceThreadId: "thread-1", targetInstanceId: "pwr_studio", operation: "copy", handoffId: HANDOFF_ID,
    }, sender);
    expect(sender.sent.map((event) => [event.phase, event.bytesCommitted, event.link])).toEqual([
      ["package", undefined, "connected"],
      ["send", 0, "connected"],
      ["send", 200, "connected"],
      ["send", 250, "waiting"],
      ["send", 300, "connected"],
      ["import", undefined, "connected"],
    ]);
    vi.mocked(Date.now).mockRestore();
  });

  it("lets only the owning window cancel or wake a handoff, and a closed window cancels it", async () => {
    const seen: { signal?: AbortSignal; retries: number } = { retries: 0 };
    let finish!: () => void;
    runtime.handoffInstanceThread.mockImplementation(async (
      _request: unknown,
      _source: unknown,
      options: ThreadHandoffSendOptions,
    ) => {
      seen.signal = options.signal;
      options.retryNow?.addEventListener("retry-now", () => {
        seen.retries += 1;
      });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return result;
    });
    const owner = windowSender(1);
    await register();
    const running = handlers.get(FEDERATION_HANDOFF_THREAD_CHANNEL)!({ sender: owner }, {
      sourceThreadId: "thread-1", targetInstanceId: "pwr_studio", operation: "copy", handoffId: HANDOFF_ID,
    });
    await vi.waitFor(() => expect(seen.signal).toBeDefined());

    await handlers.get(FEDERATION_RETRY_HANDOFF_THREAD_NOW_CHANNEL)!({ sender: { id: 2 } }, { handoffId: HANDOFF_ID });
    await handlers.get(FEDERATION_CANCEL_HANDOFF_THREAD_CHANNEL)!({ sender: { id: 2 } }, { handoffId: HANDOFF_ID });
    expect(seen.retries).toBe(0);
    expect(seen.signal?.aborted).toBe(false);

    await handlers.get(FEDERATION_RETRY_HANDOFF_THREAD_NOW_CHANNEL)!({ sender: owner }, { handoffId: HANDOFF_ID });
    expect(seen.retries).toBe(1);

    owner.destroy();
    expect(seen.signal?.aborted).toBe(true);
    finish();
    await expect(running).resolves.toEqual(result);
  });

  it("tells the window a Cancel apart from a failure that follows it", async () => {
    const request = {
      sourceThreadId: "thread-1", targetInstanceId: "pwr_studio", operation: "copy", handoffId: HANDOFF_ID,
    };
    const owner = windowSender(1);
    await register();
    runtime.handoffInstanceThread.mockImplementation(async (
      _request: unknown,
      _source: unknown,
      options: ThreadHandoffSendOptions,
    ) => await new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
    }));
    const cancelled = handlers.get(FEDERATION_HANDOFF_THREAD_CHANNEL)!({ sender: owner }, request);
    await vi.waitFor(() => expect(runtime.handoffInstanceThread).toHaveBeenCalled());
    await handlers.get(FEDERATION_CANCEL_HANDOFF_THREAD_CHANNEL)!({ sender: owner }, { handoffId: HANDOFF_ID });
    await expect(cancelled).rejects.toThrow(THREAD_HANDOFF_CANCELLED_MESSAGE);

    // The sender ignores an abort once the import began; a failure after that
    // is the receiver's, and the window must show it as one.
    runtime.handoffInstanceThread.mockImplementation(async (
      _request: unknown,
      _source: unknown,
      options: ThreadHandoffSendOptions,
    ) => await new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("no rollout found for thread id")));
    }));
    const failed = handlers.get(FEDERATION_HANDOFF_THREAD_CHANNEL)!({ sender: owner }, request);
    await vi.waitFor(() => expect(runtime.handoffInstanceThread).toHaveBeenCalledTimes(2));
    await handlers.get(FEDERATION_CANCEL_HANDOFF_THREAD_CHANNEL)!({ sender: owner }, { handoffId: HANDOFF_ID });
    await expect(failed).rejects.toThrow("no rollout found for thread id");
  });
});
