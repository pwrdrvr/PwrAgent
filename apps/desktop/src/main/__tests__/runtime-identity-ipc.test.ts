import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const execFileSyncMock = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

describe("runtime identity ipc", () => {
  beforeEach(() => {
    handlers.clear();
    execFileSyncMock.mockReset();
  });

  it("resolves cwd and the current git branch", async () => {
    execFileSyncMock.mockReturnValue("codex/show-runtime-identity\n");
    const { resolveRuntimeIdentity } = await import("../ipc/runtime-identity");

    expect(resolveRuntimeIdentity("/repo/PwrAgnt")).toEqual({
      branch: "codex/show-runtime-identity",
      cwd: "/repo/PwrAgnt",
    });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo/PwrAgnt", "branch", "--show-current"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
  });

  it("falls back to the short commit when HEAD is detached", async () => {
    execFileSyncMock
      .mockReturnValueOnce("\n")
      .mockImplementationOnce(() => {
        throw new Error("not symbolic");
      })
      .mockReturnValueOnce("ab12cd3344556677889900aabbccddeeff001122\n");
    const { resolveRuntimeIdentity } = await import("../ipc/runtime-identity");

    expect(resolveRuntimeIdentity("/repo/PwrAgnt")).toEqual({
      commitSha: "ab12cd3344556677889900aabbccddeeff001122",
      cwd: "/repo/PwrAgnt",
      detachedHead: true,
    });
  });

  it("registers and disposes the IPC handler", async () => {
    execFileSyncMock.mockReturnValue("main\n");
    const { registerRuntimeIdentityIpcHandlers, disposeRuntimeIdentityIpcHandlers } =
      await import("../ipc/runtime-identity");
    const { RUNTIME_IDENTITY_CHANNEL } = await import("../../shared/ipc");

    registerRuntimeIdentityIpcHandlers();
    await expect(handlers.get(RUNTIME_IDENTITY_CHANNEL)?.({})).resolves.toMatchObject({
      branch: "main",
    });

    disposeRuntimeIdentityIpcHandlers();
    expect(handlers.has(RUNTIME_IDENTITY_CHANNEL)).toBe(false);
  });
});
