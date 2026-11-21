import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKTREE_REFLINK_CAPABILITIES_CHANNEL,
  WORKTREE_REFLINK_RUN_CHANNEL,
} from "../../shared/ipc";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const registry = {
  resolveThreadLinkedWorkspace: vi.fn(),
  resolveThreadWorktreeGitReadContext: vi.fn(),
  workspaceHasActiveTurn: vi.fn(),
};
const service = { readCapabilities: vi.fn(), run: vi.fn() };
const federationWindow = { value: false };

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => registry }));
vi.mock("../git-worktree-reflink", () => ({ getWorktreeReflinkService: () => service }));
vi.mock("../shell/window", () => ({ isFederationWindowWebContents: () => federationWindow.value }));

const target = { backend: "codex" as const, threadId: "thread-1", worktreePath: "/renderer/spelling" };

async function invoke(channel: string, request: unknown): Promise<unknown> {
  return await handlers.get(channel)!({ sender: {} }, request);
}

beforeEach(async () => {
  vi.clearAllMocks();
  federationWindow.value = false;
  registry.resolveThreadLinkedWorkspace.mockResolvedValue({
    worktreePath: "/work/wt",
    workspacePaths: ["/work/project", "/work/wt", "/work/other"],
  });
  service.readCapabilities.mockResolvedValue({
    capabilities: { reflink: true, verifyFilters: true }, runtimeKey: "k", answered: true,
  });
  service.run.mockResolvedValue({ status: "failed", reason: "stub" });
  const { registerWorktreeReflinkIpc } = await import("../shell/ipc/worktree-reflink-ipc");
  registerWorktreeReflinkIpc();
});

describe("worktree reflink IPC", () => {
  it("reads capabilities in the thread's own target first, then its other workspaces", async () => {
    await expect(invoke(WORKTREE_REFLINK_CAPABILITIES_CHANNEL, target)).resolves.toEqual({
      status: "ready", capabilities: { reflink: true, verifyFilters: true }, runtimeKey: "k",
    });
    expect(service.readCapabilities).toHaveBeenCalledWith(["/work/wt", "/work/project", "/work/other"]);
  });

  it("does not report a Git as unable to share when no directory answered", async () => {
    service.readCapabilities.mockResolvedValue({
      capabilities: { reflink: false, verifyFilters: false }, runtimeKey: "k", answered: false,
    });
    await expect(invoke(WORKTREE_REFLINK_CAPABILITIES_CHANNEL, target))
      .resolves.toMatchObject({ status: "unavailable", reason: expect.stringContaining("could not be run") });
  });

  it("runs in the thread's spelling of the path, with a busy check for that worktree", async () => {
    await invoke(WORKTREE_REFLINK_RUN_CHANNEL, { ...target, mode: "share", verifyFilters: "yes", runtimeKey: "k" });
    const params = service.run.mock.calls[0][0];
    expect(params).toMatchObject({ cwd: "/work/wt", mode: "share", verifyFilters: false, runtimeKey: "k" });
    registry.workspaceHasActiveTurn.mockResolvedValue(true);
    await expect(params.isBusy()).resolves.toBe(true);
    expect(registry.workspaceHasActiveTurn).toHaveBeenCalledWith("/work/wt");
  });

  it("authorizes through the check that excludes archived threads and reads no pull requests", async () => {
    await invoke(WORKTREE_REFLINK_RUN_CHANNEL, { ...target, mode: "share", runtimeKey: "k" });
    expect(registry.resolveThreadLinkedWorkspace).toHaveBeenCalledWith(target);
    expect(registry.resolveThreadWorktreeGitReadContext).not.toHaveBeenCalled();
  });

  it("runs nothing for a directory the thread does not work in, or from a federation window", async () => {
    registry.resolveThreadLinkedWorkspace.mockResolvedValue(undefined);
    await expect(invoke(WORKTREE_REFLINK_RUN_CHANNEL, { ...target, mode: "share", runtimeKey: "k" }))
      .resolves.toMatchObject({ status: "failed" });
    await expect(invoke(WORKTREE_REFLINK_CAPABILITIES_CHANNEL, target))
      .resolves.toMatchObject({ status: "unavailable" });
    federationWindow.value = true;
    await expect(invoke(WORKTREE_REFLINK_RUN_CHANNEL, { ...target, mode: "share", runtimeKey: "k" }))
      .resolves.toMatchObject({ status: "failed" });
    expect(registry.resolveThreadLinkedWorkspace).toHaveBeenCalledTimes(2);
    expect(service.run).not.toHaveBeenCalled();
    expect(service.readCapabilities).not.toHaveBeenCalled();
  });
});
