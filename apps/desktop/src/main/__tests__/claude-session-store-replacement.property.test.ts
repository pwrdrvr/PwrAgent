import { mkdtemp, open, readdir, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeBackend } from "../claude/claude-backend";
import { ClaudeSessionStore, type ClaudeSession } from "../claude/claude-session-store";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

vi.mock("node:timers/promises", async (importOriginal) => {
  const timers = await importOriginal<typeof import("node:timers/promises")>();
  return { ...timers, setTimeout: vi.fn(timers.setTimeout) };
});

const realRename = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rename;
const renameMock = vi.mocked(rename);
const delayMock = vi.mocked(delay);
const id = "a4444444-4444-4444-8444-444444444444";
const sidecar = `${id}.json`;
const initial: ClaudeSession = {
  cwd: "/fixture", thread: { id, source: "claude", title: "Fixture", titleSource: "explicit", linkedDirectories: [] },
};

afterEach(() => {
  vi.restoreAllMocks();
  delayMock.mockReset();
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
    delayMock.mockClear();
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
    expect(delayMock.mock.calls).toEqual([[5], [10], [20]].slice(0, blockedAttempts));
    expect(new Set(renameMock.mock.calls.map(([source]) => source)).size).toBe(1);
    expect(await peer.read(id)).toEqual(replacement);
    expect(await readdir(root)).toEqual([sidecar]);
  });
}

async function overlappingMetadataUpdates(title: string, renameFirst: boolean): Promise<void> {
  await withSidecar(async (root, store) => {
    const peer = new ClaudeSessionStore(root);
    const makeBackend = (sessions: ClaudeSessionStore) => new ClaudeBackend({
      store: sessions, emit: vi.fn(), request: vi.fn(), cancelRequest: vi.fn(),
      inspectInstallation: async () => ({ authStatus: "unknown" }),
    });
    const [first, second] = [makeBackend(store), makeBackend(peer)] as const;
    const peerRead = vi.spyOn(peer, "read");
    const retrying = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    delayMock.mockImplementationOnce(async () => {
      retrying.resolve();
      await resume.promise;
    });
    renameMock.mockRejectedValueOnce(Object.assign(new Error("Replacement blocked by an open handle"), { code: "EPERM" }));
    const changeName = (backend: ClaudeBackend) => backend.renameThread(id, title);
    const changeMode = (backend: ClaudeBackend) => backend.setExecutionMode(id, "full-access");
    const firstUpdate = (renameFirst ? changeName : changeMode)(first);
    try {
      await Promise.race([retrying.promise, firstUpdate]);
      const secondUpdate = (renameFirst ? changeMode : changeName)(second);
      const readsDuringRetry = peerRead.mock.calls.length;
      resume.resolve();
      await Promise.all([firstUpdate, secondUpdate]);

      expect(readsDuringRetry).toBe(0);
      expect((await store.read(id)).thread).toMatchObject({ title, titleSource: "explicit", executionMode: "full-access" });
    } finally {
      resume.resolve();
      await Promise.all([first.close(), second.close()]);
    }
  });
}

describe("Claude session metadata replacement", () => {
  it("publishes the init sidecar after a Windows handle releases it", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    delayMock.mockResolvedValue(undefined);
    await saveThroughBlockedRenames(1, "initialized");
  });

  it("keeps the prior sidecar and the mutation lock until a complete snapshot can replace it", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    delayMock.mockResolvedValue(undefined);
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 3 }), fc.uuid(), saveThroughBlockedRenames), { numRuns: 40 });
  });

  it("reads the rename snapshot only after the pending execution mode is published", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await overlappingMetadataUpdates("Renamed", false);
  });

  it("preserves both acknowledged updates regardless of which metadata writer retries", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await fc.assert(fc.asyncProperty(fc.uuid(), fc.boolean(), overlappingMetadataUpdates), { numRuns: 25 });
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
    delayMock.mockResolvedValue(undefined);
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
