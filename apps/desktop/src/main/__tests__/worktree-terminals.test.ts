import { expect, it } from "vitest";
import { registerWorktreeTerminalOwner, withWorktreeTerminalsClosed } from "../terminal/worktree-terminals";

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
