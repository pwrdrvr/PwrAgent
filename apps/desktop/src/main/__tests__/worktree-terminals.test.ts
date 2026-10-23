import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isWithinWorktree, registerWorktreeTerminalOwner, withWorktreeTerminalsClosed } from "../terminal/worktree-terminals";

it("recognizes directory aliases and missing descendants in either worktree spelling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "worktree-terminal-alias-"));
  const worktree = path.join(root, "worktree");
  const alias = path.join(root, "alias");
  try {
    await mkdir(path.join(worktree, "child"), { recursive: true });
    await symlink(worktree, alias, process.platform === "win32" ? "junction" : "dir");
    expect(isWithinWorktree(path.join(alias, "child"), worktree, process.platform)).toBe(true);
    expect(isWithinWorktree(path.join(alias, "missing", "child"), worktree, process.platform)).toBe(true);
    expect(isWithinWorktree(path.join(worktree, "child"), alias, process.platform)).toBe(true);
    expect(isWithinWorktree(path.join(root, "worktree-sibling"), alias, process.platform)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("holds every local and remote terminal owner closed until worktree removal settles", async () => {
  const events: string[] = [];
  const owner = (name: string) => ({
    async withWorktreeClosed<T>(_path: string, work: () => Promise<T>): Promise<T> {
      events.push(`${name}:closed`);
      try { return await work(); }
      finally { events.push(`${name}:released`); }
    },
  });
  const releaseLocal = registerWorktreeTerminalOwner(owner("local"));
  const releaseRemote = registerWorktreeTerminalOwner(owner("remote"));
  try {
    await expect(withWorktreeTerminalsClosed("/worktree", async () => {
      expect(events).toEqual(["local:closed", "remote:closed"]);
      throw new Error("removal failed");
    })).rejects.toThrow("removal failed");
    expect(events).toEqual(["local:closed", "remote:closed", "remote:released", "local:released"]);
  } finally {
    releaseRemote();
    releaseLocal();
  }
});
