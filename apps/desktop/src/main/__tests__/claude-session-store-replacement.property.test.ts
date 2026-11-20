import { mkdtemp, open, readdir, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeSessionStore, type ClaudeSession } from "../claude/claude-session-store";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

const realRename = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename;
const renameMock = vi.mocked(rename);
const id = "a4444444-4444-4444-8444-444444444444";
const sidecar = `${id}.json`;
const initial: ClaudeSession = {
  cwd: "/fixture", thread: { id, source: "claude", title: "Fixture", titleSource: "explicit", linkedDirectories: [] },
};

afterEach(() => {
  vi.restoreAllMocks();
});

async function withSidecar(run: (root: string, store: ClaudeSessionStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-sidecar-"));
  try {
    const store = new ClaudeSessionStore(root);
    renameMock.mockReset();
    await store.save(initial);
    renameMock.mockClear();
    await run(root, store);
  } finally {
    renameMock.mockReset();
    await rm(root, { recursive: true, force: true });
  }
}

async function saveThroughBlockedRenames(blockedAttempts: number, sdkSessionId: string): Promise<void> {
  await withSidecar(async (root, store) => {
    const peer = new ClaudeSessionStore(root);
    const replacement = { ...initial, sdkSessionId };
    renameMock.mockImplementation(async (source, destination) => {
      expect(destination).toBe(path.join(root, sidecar));
      expect(await peer.read(id)).toEqual(initial);
      expect(JSON.parse(await readFile(source, "utf8"))).toEqual(replacement);
      await expect(peer.withMutation(id, async () => {})).rejects.toThrow("another PwrAgent instance");
      if (renameMock.mock.calls.length <= blockedAttempts) {
        throw Object.assign(new Error("Replacement blocked by an open handle"), { code: "EPERM" });
      }
      await realRename(source, destination);
    });

    await store.save(replacement);

    expect(renameMock).toHaveBeenCalledTimes(blockedAttempts + 1);
    expect(new Set(renameMock.mock.calls.map(([source]) => source)).size).toBe(1);
    expect(await peer.read(id)).toEqual(replacement);
    expect(await readdir(root)).toEqual([sidecar]);
  });
}

describe("Claude session metadata replacement", () => {
  it("publishes the init sidecar after a Windows handle releases it", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await saveThroughBlockedRenames(1, "initialized");
  });

  it("keeps the prior sidecar and the mutation lock until a complete snapshot can replace it", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 3 }), fc.uuid(), saveThroughBlockedRenames));
  });

  it.skipIf(process.platform !== "win32")("publishes after a native Node destination handle closes", async () => {
    await withSidecar(async (root, store) => {
      const handle = await open(path.join(root, sidecar), "r");
      renameMock.mockImplementationOnce(async (source, destination) => {
        try {
          await realRename(source, destination);
        } finally {
          await handle.close();
        }
      });
      const replacement = { ...initial, sdkSessionId: "native-init" };
      try {
        await store.save(replacement);
        expect(await store.read(id)).toEqual(replacement);
        expect(await readdir(root)).toEqual([sidecar]);
      } finally {
        await handle.close();
      }
    });
  });

  it.each([
    { platform: "win32", code: "EPERM", attempts: 6 },
    { platform: "win32", code: "ENOENT", attempts: 1 },
    { platform: "linux", code: "EPERM", attempts: 1 },
  ] as const)("preserves the prior sidecar after $attempts $platform $code failure(s)", async ({ platform, code, attempts }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    await withSidecar(async (root, store) => {
      const failure = Object.assign(new Error("Cannot replace the sidecar"), { code });
      renameMock.mockRejectedValue(failure);

      await expect(store.save({ ...initial, sdkSessionId: "unpublished" })).rejects.toBe(failure);
      expect(renameMock).toHaveBeenCalledTimes(attempts);
      expect(await store.read(id)).toEqual(initial);
      expect(await readdir(root)).toEqual([sidecar]);
    });
  });
});
