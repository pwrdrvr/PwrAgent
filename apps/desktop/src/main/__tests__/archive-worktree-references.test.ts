import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArchiveWorktreeReferences } from "../app-server/archive-worktree-references";
import type { ArchiveCleanupIntent } from "../state/archive-cleanup-checkpoint";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, realpath: vi.fn(fs.realpath) };
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.mocked(realpath).mockClear();
});
const intent = (threadId: string): ArchiveCleanupIntent => ({ backend: "codex", threadId, archivedAt: 1, codexRolloutMissing: false, messagingCleanup: {} });

describe("pending worktree references", () => {
  it("deduplicates canonical checkouts across archived owners and schedules only a final release", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pending-worktree-"));
    roots.push(root);
    const checkout = path.join(root, "checkout");
    const alias = path.join(root, "alias");
    await mkdir(checkout);
    await symlink(checkout, alias, process.platform === "win32" ? "junction" : "dir");
    const refs = new ArchiveWorktreeReferences();
    for (const [owner, worktreePath] of [["first", checkout], ["second", alias]]) {
      await refs.retain(intent(owner!), { worktreePath: worktreePath!, blockers: ["codex:one", "claude:two"] });
    }
    expect(await refs.observe("codex:one", refs.beginObservation("codex:one"), [])).toEqual([]);
    expect(refs.hasReference("codex:unrelated")).toBe(false);
    const ready = await refs.observe("claude:two", refs.beginObservation("claude:two"), []);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.deferredWorktrees).toHaveLength(1);
    await refs.fulfilled(alias);
    expect(refs.intents()).toEqual([]);
  });

  it("keeps read failures and stale canonical completions from releasing a reference", async () => {
    const refs = new ArchiveWorktreeReferences();
    await refs.retain(intent("target"), { worktreePath: "/fixture/checkout", blockers: ["codex:owner"] });
    await expect(refs.observe("codex:owner", refs.beginObservation("codex:owner"), ["relative"])).rejects.toThrow("Unknown worktree path");
    expect(refs.intents()[0]?.deferredWorktrees?.[0]?.blockers).toEqual(["codex:owner"]);
    let release!: (value: string) => void;
    vi.mocked(realpath).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const old = refs.observe("codex:owner", refs.beginObservation("codex:owner"), ["/fixture/other"]);
    const current = refs.beginObservation("codex:owner");
    release("/fixture/other");
    expect(await old).toEqual([]);
    expect(await refs.observe("codex:owner", current, ["/fixture/checkout"])).toEqual([]);
    expect(refs.intents()[0]?.deferredWorktrees?.[0]?.blockers).toEqual(["codex:owner"]);
  });

  it("retains all checkouts but retries one physical request per canonical checkout after restart", async () => {
    const refs = new ArchiveWorktreeReferences();
    await refs.retain(intent("first"), { worktreePath: "/fixture/one", blockers: ["codex:owner"] });
    await refs.retain(intent("first"), { worktreePath: "/fixture/two", blockers: ["codex:owner"] });
    await refs.retain(intent("second"), { worktreePath: "/fixture/one", blockers: ["codex:owner"] });
    const recovered = new ArchiveWorktreeReferences();
    for (const request of refs.intents()) for (const worktree of request.deferredWorktrees!) await recovered.retain(request, worktree);
    expect(recovered.intents()).toHaveLength(2);
    expect(recovered.recoveryIntents()).toHaveLength(1);
    expect(recovered.recoveryIntents()[0]?.deferredWorktrees).toHaveLength(2);
  });
});
