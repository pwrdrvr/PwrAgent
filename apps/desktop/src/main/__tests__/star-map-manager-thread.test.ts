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
} = {}) {
  const startThread =
    options.startThread
    ?? vi.fn(async () => ({ backend: "codex", threadId: "made-1" }));
  const renameThread = options.renameThread ?? vi.fn(async () => ({}));
  const setRemembered = options.setRemembered ?? vi.fn();
  return {
    workspaceDir: () => workspace,
    registry: { startThread, renameThread } as never,
    overlayStore: {
      getStarMapManagerThread: () => options.remembered,
      setStarMapManagerThread: setRemembered,
      getLaunchpadDefaults: async () => ({
        backend: "codex" as const,
        executionMode: "default" as const,
        model: "gpt-5",
      }),
    } as never,
    listThreadKeys:
      options.listThreadKeys
      ?? (async () => new Set(options.existingThreadKeys ?? [])),
    handles: { startThread, renameThread, setRemembered },
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
