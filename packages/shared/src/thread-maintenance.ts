import type { DesktopThreadArchivePolicy } from "./thread-archive-policy";

/**
 * Thread maintenance: a reviewed, operator-driven version of the hourly
 * archive sweep. A scan never changes anything. An apply runs only the
 * selections the operator (or an agent acting for them) made from one scan,
 * and re-checks each one before it acts.
 */

export type ThreadMaintenanceRules = Pick<DesktopThreadArchivePolicy, "mode" | "keepPerProject" | "inactivityDays"> & {
  /** Count dependency and build output folders (node_modules, dist, target…)
   * as clean. Other ignored files still keep the checkout. */
  rebuildableOutputIsClean: boolean;
};

/** Ignored directory names that a package manager or build recreates. Any
 * other ignored path, such as `.env.local`, is treated as operator data. */
export const REBUILDABLE_OUTPUT_NAMES: ReadonlySet<string> = new Set([
  "node_modules", ".pnpm-store", "bower_components",
  "dist", "build", "out", "target", "coverage", ".nyc_output",
  ".next", ".nuxt", ".svelte-kit", ".output", ".vite", ".turbo", ".parcel-cache", ".cache",
  ".angular", ".expo", ".docusaurus", "storybook-static",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".venv", "venv",
  ".gradle", "DerivedData", ".build", "Pods", "obj",
]);

export type ThreadMaintenanceWorkspace =
  /** Nothing to save. Commits are on a branch, so removing the checkout loses nothing. */
  | { kind: "clean"; rebuildableOutput?: string[] }
  /** Uncommitted changes that fit in a recovery snapshot. */
  | { kind: "changes"; files: number; bytes: number; rebuildableOutput?: string[] }
  /** Uncommitted changes larger than the snapshot limit. Needs a decision. */
  | { kind: "overLimit"; files: number; bytes: number; limitBytes: number; largest: { path: string; bytes: number }[] }
  /** Not a Git checkout (a scratch folder). Archive leaves the folder in place. */
  | { kind: "notGit" }
  /** A repository's primary checkout. Archive never removes it. */
  | { kind: "inPlace" }
  /** The folder no longer exists. */
  | { kind: "missing" };

/** Reserved for the space-first view: filled only by a disk accounting
 * provider (PwrDisk). Electron never measures checkouts itself. */
export type ThreadMaintenanceSpace = {
  /** Bytes freed if this item alone is removed. */
  privateBytes: number;
  /** True when measurement stopped early and privateBytes is a lower bound. */
  lowerBound?: boolean;
  largest?: { name: string; bytes: number }[];
};

export type ThreadMaintenanceIdleThread = {
  backend: string;
  threadId: string;
  title: string;
  branch?: string;
  /** The checkout archive would remove, when the thread has one. */
  worktreePath?: string;
  lastActivityAt: number;
  /** Native sub-agent threads archived with this root. */
  subThreads: number;
  workspace: ThreadMaintenanceWorkspace;
  space?: ThreadMaintenanceSpace;
};

export type ThreadMaintenanceProject = {
  key: string;
  label: string;
  path?: string;
  idle: ThreadMaintenanceIdleThread[];
  /** Threads kept in this project, counted by reason. */
  kept: Record<string, number>;
  space?: { totalBytes: number; idleBytes: number; lowerBound?: boolean };
};

export type ThreadMaintenanceArchivedCheckout = ThreadMaintenanceOwnedCheckout | ThreadMaintenanceUnreferencedCheckout;

/** An archived thread's checkout. */
export type ThreadMaintenanceOwnedCheckout = {
  backend: string;
  threadId: string;
  title?: string;
  worktreePath: string;
  /** removable: an archived thread's checkout that is safe to remove.
   * repositoryGone: its repository no longer exists, so Git cannot save
   * anything from it; only Move to Trash applies, and never by default. */
  kind: "removable" | "repositoryGone";
  workspace?: ThreadMaintenanceWorkspace;
  missingRepositoryPath?: string;
  space?: ThreadMaintenanceSpace;
};

/** A checkout under PwrAgent's own worktree root that no thread, active or
 * archived, refers to. Never selected by default and never removed by the
 * hourly sweep. Removing one saves a recovery snapshot first. */
export type ThreadMaintenanceUnreferencedCheckout = {
  kind: "unreferenced";
  worktreePath: string;
  workspace: Extract<ThreadMaintenanceWorkspace, { kind: "clean" | "changes" }>;
  space?: ThreadMaintenanceSpace;
};

export type ThreadMaintenanceFailure = {
  step: ThreadMaintenanceStep;
  message: string;
  path?: string;
  threadId?: string;
};

export type ThreadMaintenanceStep = "threads" | "checkouts" | "expired";

export type ThreadMaintenanceScan = {
  scanId: string;
  startedAt: number;
  finishedAt: number;
  rules: ThreadMaintenanceRules;
  /** Set when the scan was limited to one project. */
  projectKey?: string;
  /** "none" until a disk accounting provider is connected. */
  spaceSource: "none" | "pwrdisk";
  threads: {
    checked: number;
    projects: ThreadMaintenanceProject[];
    kept: Record<string, number>;
    /** Why the step could not run, if it could not. */
    skipped?: string;
  };
  checkouts: {
    items: ThreadMaintenanceArchivedCheckout[];
    kept: Record<string, number>;
    emptyFolders: number;
    skipped?: string;
  };
  expired: {
    enabled: boolean;
    retentionDays: number;
  };
  failures: ThreadMaintenanceFailure[];
};

/** What to do with an idle thread whose changes are over the snapshot limit. */
export type ThreadMaintenanceOverLimitChoice = "keepCheckout" | "snapshotAll";

export type ThreadMaintenanceApplyRequest = {
  scanId: string;
  archive: { backend: string; threadId: string; overLimit?: ThreadMaintenanceOverLimitChoice }[];
  removeCheckouts: { backend: string; threadId: string; worktreePath: string }[];
  /** Orphaned checkouts to move to the Trash. Never selected by default. */
  trashCheckouts: { worktreePath: string }[];
  /** Checkouts no thread refers to, to snapshot and remove. Never selected
   * by default. Older callers omit it. */
  removeUnreferenced?: { worktreePath: string }[];
  /** Remove empty worktree folders left by earlier cleanups. */
  removeEmptyFolders: boolean;
};

export type ThreadMaintenanceProblem = {
  step: ThreadMaintenanceStep;
  /** failed: something requested did not happen. kept: kept on purpose. */
  kind: "failed" | "kept";
  object: string;
  /** Short lead phrase, e.g. "New activity during the run". */
  reason: string;
  detail?: string;
  backend?: string;
  threadId?: string;
  path?: string;
};

export type ThreadMaintenanceStepResult = {
  step: ThreadMaintenanceStep;
  ran: boolean;
  done: number;
  kept: number;
  failed: number;
};

export type ThreadMaintenanceRun = {
  runId: string;
  /** Grows with every snapshot main publishes, across runs. The newest
   * snapshot wins however it arrives (apply reply, event, or fetch). */
  revision: number;
  scanId: string;
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  current?: { step: ThreadMaintenanceStep; processed: number; total: number; object?: string };
  steps: ThreadMaintenanceStepResult[];
  problems: ThreadMaintenanceProblem[];
  stopRequested?: boolean;
};

export function defaultThreadMaintenanceRules(policy: DesktopThreadArchivePolicy): ThreadMaintenanceRules {
  return {
    mode: policy.mode,
    keepPerProject: policy.keepPerProject,
    inactivityDays: policy.inactivityDays,
    rebuildableOutputIsClean: true,
  };
}
