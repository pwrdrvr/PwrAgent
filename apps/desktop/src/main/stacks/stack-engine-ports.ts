import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  parseGhStackCatalog, requireWritableCatalog,
  type ApplyHooks, type CatalogStore, type GhStackCatalog, type GitRunner, type StackJournal,
} from "@pwragent/owner-core/stacks/engine/index";
import type { StackNotification } from "@pwragent/owner-core/stacks/stack-coordinator";
import { runGitCommand } from "../app-server/git-executable";
import { acquireNativeFileLock } from "../app-server/maintenance-native-lock";
import { nativeRelayPath } from "../native-relay-path";

const execute = promisify(execFile);
const ownJournal = "pwragent-stack-op.json";
const foreignJournals = {
  "gh-stack-rebase-state": "gh stack is mid-rebase in this clone.",
  "gh-stack-modify-state": "gh stack is modifying a stack in this clone.",
  "gh-stack-migration": "gh stack is migrating a stack in this clone.",
  "pwrgit-stack-op.json": "PwrGit has an unfinished stack operation in this clone.",
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
type RuntimeJournal = StackJournal & { notification: StackNotification; committed?: true };

async function exists(filename: string): Promise<boolean> {
  return await lstat(filename).then(() => true, (error: unknown) => {
    if (missing(error)) return false;
    throw error;
  });
}

export const stackGitRunner: GitRunner = {
  async run(cwd, args, opts) {
    try {
      return { ...(await runGitCommand(cwd, args, { input: opts?.stdin })), exitCode: 0 };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: string; stderr?: string };
      if (typeof failure.code !== "number") throw error;
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: failure.code };
    }
  },
};

export class StackCatalogError extends Error {
  constructor(readonly code: "gh_stack_busy" | "stale_plan", message: string) {
    super(message);
  }
}

async function syncDirectory(commonDir: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(commonDir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class GhStackCatalogStore implements CatalogStore {
  constructor(private readonly relayPath = nativeRelayPath()) {}

  private async withLock<T>(commonDir: string, filename: string, fn: () => Promise<T>): Promise<T> {
    const deadline = performance.now() + 5_000;
    for (;;) {
      const lock = await acquireNativeFileLock("--stack-lock", join(commonDir, filename), this.relayPath);
      if (lock) {
        try {
          lock.assertHeld();
          return await fn();
        } finally {
          await lock.release();
        }
      }
      if (performance.now() >= deadline) throw new StackCatalogError("gh_stack_busy", `The stack lock ${filename} is held by another operation.`);
      await delay(100);
    }
  }

  async read(commonDir: string) {
    const file = await open(join(commonDir, "gh-stack"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error: unknown) => { if (!missing(error)) throw error; });
    if (!file) return { catalog: { schemaVersion: 1, repository: "", stacks: [] } as GhStackCatalog, sha256: "" };
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Invalid gh stack catalog file");
      const bytes = await file.readFile();
      if (bytes.length !== info.size) throw new Error("Stack catalog changed while reading");
      return { catalog: parseGhStackCatalog(bytes.toString("utf8")), sha256: createHash("sha256").update(bytes).digest("hex") };
    } finally {
      await file.close();
    }
  }

  async withOperationLock<T>(commonDir: string, fn: () => Promise<T>): Promise<T> {
    return await this.withLock(commonDir, "gh-stack-operation.lock", async () => {
      await this.assertForeignJournalsAbsent(commonDir);
      if (await this.hasJournal(commonDir)) {
        throw new StackCatalogError("gh_stack_busy", "PwrAgent has an unfinished stack operation in this clone.");
      }
      return await fn();
    });
  }

  hasJournal(commonDir: string): Promise<boolean> {
    return exists(join(commonDir, ownJournal));
  }

  private async assertForeignJournalsAbsent(commonDir: string): Promise<void> {
    for (const [name, message] of Object.entries(foreignJournals)) {
      if (await exists(join(commonDir, name))) throw new StackCatalogError("gh_stack_busy", message);
    }
  }

  async recover(commonDir: string, recover: (entry: RuntimeJournal) => Promise<void | "retain">): Promise<void> {
    await this.withLock(commonDir, "gh-stack-operation.lock", async () => {
      await this.assertForeignJournalsAbsent(commonDir);
      const file = await open(join(commonDir, ownJournal), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        .catch((error: unknown) => { if (!missing(error)) throw error; });
      if (!file) return;
      let entry: RuntimeJournal;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error("Invalid PwrAgent stack journal");
        entry = JSON.parse(await file.readFile("utf8")) as RuntimeJournal;
        if (!entry.notification || (entry.direction !== "apply" && entry.direction !== "undo")) throw new Error("Invalid PwrAgent stack journal");
      } finally {
        await file.close();
      }
      // The callback can replace the journal under this lock. Windows
      // cannot replace it while our read handle is open.
      if (await recover(entry) === "retain") return;
      await this.clearJournal(commonDir);
    });
  }

  async writeIfUnchanged(commonDir: string, next: GhStackCatalog, sha256: string): Promise<void> {
    await this.withLock(commonDir, "gh-stack.lock", async () => {
      const current = await this.read(commonDir);
      requireWritableCatalog(current.catalog);
      requireWritableCatalog(next);
      if (current.sha256 !== sha256) throw new StackCatalogError("stale_plan", "The stack catalog changed. Plan the operation again.");
      if (JSON.stringify(current.catalog) !== JSON.stringify(next)) await this.atomicWrite(commonDir, "gh-stack", next);
    });
  }

  journalHooks(commonDir: string, notification?: StackNotification): ApplyHooks {
    return {
      begin: async (entry) => await this.atomicWrite(commonDir, ownJournal, { ...entry, notification }),
      finish: async () => await this.clearJournal(commonDir),
    };
  }

  async markJournalCommitted(commonDir: string, entry: StackJournal, notification: StackNotification): Promise<void> {
    await this.atomicWrite(commonDir, ownJournal, { ...entry, notification, committed: true });
  }

  private async clearJournal(commonDir: string): Promise<void> {
    await unlink(join(commonDir, ownJournal));
    await syncDirectory(commonDir);
  }

  private async atomicWrite(commonDir: string, filename: "gh-stack" | typeof ownJournal, value: unknown): Promise<void> {
    const temporary = join(commonDir, `.pwragent-stack-${randomUUID()}.tmp`);
    const destination = join(commonDir, filename);
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(value, null, 2) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      if (process.platform === "win32") {
        await execute(this.relayPath, ["--stack-replace", temporary, destination], { windowsHide: true });
      } else {
        await rename(temporary, destination);
        await syncDirectory(commonDir);
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; });
    }
  }
}
