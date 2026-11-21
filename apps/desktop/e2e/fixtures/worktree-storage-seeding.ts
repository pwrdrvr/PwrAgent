/**
 * State for auditing the Share storage dialog.
 *
 * The dialog is offered only when the selected Git's own help lists
 * `git worktree reflink`, and it shows what that command reports. The audit
 * selects a stand-in Git through `PWRAGENT_GIT_PATH`: a shell script that
 * answers `worktree reflink` from files and hands every other command to the
 * `git` on PATH. The dialog's states then do not depend on the runner's
 * filesystem being able to share storage, and nothing in the main process
 * knows it is under test: the path is authorized, probed and run exactly as
 * for a real Git.
 *
 * The help is the help 2.56.1-dev-pwrgit.2 printed, which the unit suite
 * also reads. A shell script is not a Windows executable, so the audit does
 * not run there.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";
import { PWRGIT_2_HELP } from "../../src/main/__tests__/worktree-reflink-fixtures";
import { SqliteOverlayStore } from "../../src/main/state/overlay-store-sqlite";
import { StateDb } from "../../src/main/state/state-db";
import { stateDbPathForHomeRoot } from "./readme-state-seeding";

/** The smoke fixture's thread, which has no linked directory of its own. */
const WORKTREE_STORAGE_AUDIT_THREAD_ID = "thread-smoke";
export const WORKTREE_STORAGE_AUDIT_LABEL = "storage-audit";

const SCANNED = 3310;
const SHARED = 1204;
const BYTES_BEFORE = 1_288_490_188;
const BYTES_FREED = 431_947_776;

/** One `--porcelain -z` run: a header record and the summary record. */
function porcelain(options: { dryRun: boolean }): string {
  const after = options.dryRun ? BYTES_BEFORE : BYTES_BEFORE - BYTES_FREED;
  return [
    "reflink 1", "worktree /work/storage-audit", `dry-run ${options.dryRun ? 1 : 0}`,
    "backend clone-replace", "",
    "summary", `scanned ${SCANNED}`, `eligible ${options.dryRun ? SHARED : 0}`,
    "already-shared 0", `reshared ${options.dryRun ? 0 : SHARED}`, "skipped 2", "failed 0",
    `allocated-before ${BYTES_BEFORE}`, `allocated-after ${after}`,
    `private-before ${BYTES_BEFORE}`, `private-after ${after}`,
    `observed-private-reduction ${options.dryRun ? 0 : BYTES_FREED}`,
    `potential-private-reduction ${options.dryRun ? BYTES_FREED : 0}`,
    "",
  ].map((field) => `${field}\0`).join("");
}

// Named so that the `git` it hands other commands to is never itself: the
// app puts a selected Git's own directory first on PATH.
const STAND_IN_GIT = [
  "#!/bin/sh",
  "here=$(dirname \"$0\")",
  "case \" $* \" in",
  "  *\" worktree reflink \"*)",
  "    case \" $* \" in",
  "      *\" -h \"*) cat \"$here/help.txt\" ;;",
  "      *\" --dry-run \"*) cat \"$here/estimate.porcelain\" ;;",
  "      *) cat \"$here/share.porcelain\" ;;",
  "    esac",
  "    exit 0 ;;",
  "esac",
  "exec git \"$@\"",
  "",
].join("\n");

export type WorktreeStorageAudit = {
  /** For `PWRAGENT_GIT_PATH`. */
  gitPath: string;
  directory: LinkedDirectorySummary;
};

/** Write the stand-in Git and the directories the thread will link, under `root`. */
export async function prepareWorktreeStorageAudit(root: string): Promise<WorktreeStorageAudit> {
  const checkout = path.join(root, "checkout");
  const worktreePath = path.join(root, WORKTREE_STORAGE_AUDIT_LABEL);
  const bin = path.join(root, "bin");
  await Promise.all([checkout, worktreePath, bin].map((directory) => mkdir(directory, { recursive: true })));
  const gitPath = path.join(bin, "pwragent-e2e-git");
  await writeFile(path.join(bin, "help.txt"), PWRGIT_2_HELP);
  await writeFile(path.join(bin, "estimate.porcelain"), porcelain({ dryRun: true }));
  await writeFile(path.join(bin, "share.porcelain"), porcelain({ dryRun: false }));
  await writeFile(gitPath, STAND_IN_GIT);
  await chmod(gitPath, 0o755);
  return {
    gitPath,
    directory: {
      id: worktreePath,
      kind: "worktree",
      label: WORKTREE_STORAGE_AUDIT_LABEL,
      path: checkout,
      worktreePath,
    },
  };
}

/** Link the worktree to the smoke thread, through the overlay store's own writer. */
export async function seedWorktreeStorageAuditState(
  homeRoot: string,
  audit: WorktreeStorageAudit,
): Promise<void> {
  const stateDb = StateDb.open(stateDbPathForHomeRoot(homeRoot), { profileName: "default" });
  try {
    await new SqliteOverlayStore(stateDb).addLinkedDirectory({
      backend: "codex",
      threadId: WORKTREE_STORAGE_AUDIT_THREAD_ID,
      directory: audit.directory,
    });
  } finally {
    stateDb.close();
  }
}
