import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const runGitMock = vi.fn();

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

vi.mock("../app-server/git-executable", () => ({
  runGitCommand: runGitMock,
}));

describe("runtime identity ipc", () => {
  beforeEach(() => {
    handlers.clear();
    runGitMock.mockReset();
  });

  it("resolves cwd and the current git branch", async () => {
    runGitMock.mockResolvedValue({ stdout: "codex/show-runtime-identity\n" });
    const { resolveRuntimeIdentity } = await import("../ipc/runtime-identity");

    expect(await resolveRuntimeIdentity("/repo/PwrAgent")).toEqual({
      branch: "codex/show-runtime-identity",
      cwd: "/repo/PwrAgent",
    });
    expect(runGitMock).toHaveBeenCalledWith(
      "/repo/PwrAgent",
      ["branch", "--show-current"],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
    );
  });

  it("falls back to the short commit when HEAD is detached", async () => {
    runGitMock
      .mockResolvedValueOnce({ stdout: "\n" })
      .mockImplementationOnce(() => {
        throw new Error("not symbolic");
      })
      .mockResolvedValueOnce({ stdout: "ab12cd3344556677889900aabbccddeeff001122\n" });
    const { resolveRuntimeIdentity } = await import("../ipc/runtime-identity");

    expect(await resolveRuntimeIdentity("/repo/PwrAgent")).toEqual({
      commitSha: "ab12cd3344556677889900aabbccddeeff001122",
      cwd: "/repo/PwrAgent",
      detachedHead: true,
    });
  });

  it("registers and disposes the IPC handler", async () => {
    runGitMock.mockResolvedValue({ stdout: "main\n" });
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
