// Resolving the Star Map manager thread.
//
// The manager is an ordinary thread; all this owns is which thread the
// map's Manager button reopens, and the workspace its standing
// instructions live in. Both failure modes are quiet ones: silently
// creating a second manager on every click, or reopening a card onto a
// thread that no longer exists.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAR_MAP_MANAGER_THREAD_TITLE } from "@pwragent/shared";
import { openStarMapManagerThread } from "../star-map/star-map-manager-thread";

let workspace: string;

function deps(options: {
  remembered?: { backend: string; threadId: string };
  existingThreadKeys?: string[];
  startThread?: ReturnType<typeof vi.fn>;
  renameThread?: ReturnType<typeof vi.fn>;
  setRemembered?: ReturnType<typeof vi.fn>;
  listThreadKeys?: () => Promise<Set<string>>;
  /**
   * Supply this instead of `listThreadKeys` to exercise the real membership
   * check, including its archived-thread filter.
   */
  listThreads?: ReturnType<typeof vi.fn>;
} = {}) {
  const startThread =
    options.startThread
    ?? vi.fn(async () => ({ backend: "codex", threadId: "made-1" }));
  const renameThread = options.renameThread ?? vi.fn(async () => ({}));
  const setRemembered = options.setRemembered ?? vi.fn();
  const listThreads = options.listThreads ?? vi.fn(async () => []);
  return {
    workspaceDir: () => workspace,
    registry: { startThread, renameThread, listThreads } as never,
    overlayStore: {
      getStarMapManagerThread: () => options.remembered,
      setStarMapManagerThread: setRemembered,
      getLaunchpadDefaults: async () => ({
        backend: "codex" as const,
        executionMode: "default" as const,
        model: "gpt-5",
      }),
    } as never,
    // Omitted entirely when the caller supplies `listThreads`, so the real
    // membership check runs instead of being stubbed past.
    ...(options.listThreads
      ? {}
      : {
          listThreadKeys:
            options.listThreadKeys
            ?? (async () => new Set(options.existingThreadKeys ?? [])),
        }),
    handles: { startThread, renameThread, setRemembered, listThreads },
  };
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "star-map-manager-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("openStarMapManagerThread", () => {
  it("reopens the remembered thread without creating another", async () => {
    const injected = deps({
      remembered: { backend: "codex", threadId: "kept-1" },
      existingThreadKeys: ["codex:kept-1"],
    });
    const response = await openStarMapManagerThread({}, injected);
    expect(response).toEqual({
      status: "ready",
      backend: "codex",
      threadId: "kept-1",
      created: false,
    });
    expect(injected.handles.startThread).not.toHaveBeenCalled();
  });

  it("creates, titles and remembers a manager on first use", async () => {
    const injected = deps();
    const response = await openStarMapManagerThread({}, injected);
    expect(response).toMatchObject({ status: "ready", created: true });
    expect(injected.handles.startThread).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "codex", cwd: workspace }),
    );
    expect(injected.handles.renameThread).toHaveBeenCalledWith(
      expect.objectContaining({ name: STAR_MAP_MANAGER_THREAD_TITLE }),
    );
    expect(injected.handles.setRemembered).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "made-1",
    });
  });

  it("writes the manager's instructions where every backend will read them", async () => {
    await openStarMapManagerThread({}, deps());
    const agents = await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8");
    // AGENTS.md is the delivery mechanism: thread `agent` metadata marks a
    // persona for search and the Agents browser, but nothing injects it
    // into a turn.
    expect(agents).toMatch(/read_star_map_view/);
    expect(agents).toMatch(/Star Map manager/);
  });

  it("replaces a remembered thread that no longer exists", async () => {
    const injected = deps({
      remembered: { backend: "codex", threadId: "archived-1" },
      existingThreadKeys: [],
    });
    const response = await openStarMapManagerThread({}, injected);
    expect(response).toMatchObject({ threadId: "made-1", created: true });
  });

  it("keeps the remembered thread when the existence check itself fails", async () => {
    const injected = deps({
      remembered: { backend: "codex", threadId: "kept-1" },
      listThreadKeys: async () => {
        throw new Error("snapshot unavailable");
      },
    });
    const response = await openStarMapManagerThread({}, injected);
    // Reopening a stale card is recoverable; quietly minting a new manager
    // on every transient failure is not.
    expect(response).toMatchObject({ threadId: "kept-1", created: false });
    expect(injected.handles.startThread).not.toHaveBeenCalled();
  });

  it("replaces a remembered thread the operator archived", async () => {
    // Goes through the real membership check rather than a stubbed key set:
    // the archived filter lives inside it, and stubbing the seam meant the
    // filter could be deleted with every test still green.
    const injected = deps({
      remembered: { backend: "codex", threadId: "archived-1" },
      listThreads: vi.fn(async () => [
        { id: "archived-1", archivedAt: 1_700_000_000_000 },
        { id: "other-1" },
      ]),
    });
    const response = await openStarMapManagerThread({}, injected);
    expect(response).toMatchObject({ threadId: "made-1", created: true });
    // Scoped to the remembered thread's own backend: the check is on the
    // click path, and a fleet-wide listing is a lot of work for one lookup.
    expect(injected.handles.listThreads).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "codex" }),
    );
  });

  it("keeps a remembered thread the real membership check still finds", async () => {
    const injected = deps({
      remembered: { backend: "codex", threadId: "kept-1" },
      listThreads: vi.fn(async () => [{ id: "kept-1" }]),
    });
    const response = await openStarMapManagerThread({}, injected);
    expect(response).toMatchObject({ threadId: "kept-1", created: false });
    expect(injected.handles.startThread).not.toHaveBeenCalled();
  });

  it("still reopens a manager when its instructions cannot be rewritten", async () => {
    const injected = deps({
      remembered: { backend: "codex", threadId: "kept-1" },
      existingThreadKeys: ["codex:kept-1"],
    });
    // A path whose parent is a file: mkdir fails the way a read-only or
    // permission-denied profile directory would.
    const blocker = path.join(workspace, "blocker");
    await fs.writeFile(blocker, "not a directory", "utf8");
    const response = await openStarMapManagerThread(
      {},
      { ...injected, workspaceDir: () => path.join(blocker, "manager") },
    );
    // Reopening needs nothing from the filesystem, so a failed instruction
    // refresh must not take the manager away with it.
    expect(response).toMatchObject({ threadId: "kept-1", created: false });
  });

  it("fails to CREATE a manager when its workspace cannot be made", async () => {
    const injected = deps();
    const blocker = path.join(workspace, "blocker");
    await fs.writeFile(blocker, "not a directory", "utf8");
    const response = await openStarMapManagerThread(
      {},
      { ...injected, workspaceDir: () => path.join(blocker, "manager") },
    );
    // The create path genuinely needs the directory — it is the thread's cwd.
    expect(response.status).toBe("failed");
    expect(injected.handles.startThread).not.toHaveBeenCalled();
  });

  it("starts a fresh manager when the operator asks to reset", async () => {
    const injected = deps({
      remembered: { backend: "codex", threadId: "kept-1" },
      existingThreadKeys: ["codex:kept-1"],
    });
    const response = await openStarMapManagerThread({ reset: true }, injected);
    expect(response).toMatchObject({ threadId: "made-1", created: true });
  });

  it("keeps a manager whose title could not be set", async () => {
    const injected = deps({
      renameThread: vi.fn(async () => {
        throw new Error("rename unsupported");
      }),
    });
    const response = await openStarMapManagerThread({}, injected);
    expect(response).toMatchObject({ status: "ready", threadId: "made-1" });
    expect(injected.handles.setRemembered).toHaveBeenCalled();
  });

  it("reports a failure to start rather than throwing at the caller", async () => {
    const injected = deps({
      startThread: vi.fn(async () => {
        throw new Error("no backend configured");
      }),
    });
    const response = await openStarMapManagerThread({}, injected);
    expect(response).toEqual({
      status: "failed",
      error: "no backend configured",
    });
  });
});
