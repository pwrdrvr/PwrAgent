import type { AppServerBackendKind } from "./normalized-app-server";

/**
 * What the selected Git's `git worktree reflink -h` lists. Read from the
 * option rows of the help, never from the Git version, the command existing,
 * or its exit code: 2.56.1-dev-pwrgit.1 has the command without
 * `--verify-filters`, and both it and .2 exit 0 for `-h`.
 */
export type WorktreeReflinkCapabilities = {
  /** The command exists with the options PwrAgent passes for an estimate. */
  reflink: boolean;
  /** The help lists `--[no-]verify-filters`. */
  verifyFilters: boolean;
};

/**
 * A capability answer and the Git it describes. `runtimeKey` is opaque. It
 * changes when the selected Git changes, including a new binary at the same
 * path, so an answer for one Git is never applied to another.
 */
export type WorktreeReflinkRuntime = {
  capabilities: WorktreeReflinkCapabilities;
  runtimeKey: string;
};

export type WorktreeReflinkTarget = {
  backend?: AppServerBackendKind;
  threadId: string;
  /** Must be a directory linked to the thread. */
  worktreePath: string;
};

export type ReadWorktreeReflinkCapabilitiesRequest = WorktreeReflinkTarget;

export type ReadWorktreeReflinkCapabilitiesResponse =
  | ({ status: "ready" } & WorktreeReflinkRuntime)
  | { status: "unavailable"; reason: string };

export type RunWorktreeReflinkRequest = WorktreeReflinkTarget & {
  /**
   * `estimate` is Git's dry run. It never runs filters, whatever
   * `verifyFilters` says. `share` replaces matching files with clones.
   */
  mode: "estimate" | "share";
  /**
   * Run clean filters to verify files Git cannot match by stat alone. Only an
   * explicit `true` on a `share` asks for it.
   */
  verifyFilters?: boolean;
  /** The `runtimeKey` of the capabilities the operator was shown. */
  runtimeKey: string;
};

/** Totals from the `summary` record of `git worktree reflink --porcelain`. */
export type WorktreeReflinkSummary = {
  scanned: number;
  eligible: number;
  alreadyShared: number;
  reshared: number;
  skipped: number;
  failed: number;
  /** Bytes this run stopped storing privately. Zero for an estimate. */
  observedPrivateReduction: number;
  /** Bytes an estimate found it could stop storing privately. */
  potentialPrivateReduction: number;
  /** Paths whose allocation the filesystem did not report. */
  allocationUnknown: number;
};

export type RunWorktreeReflinkResponse =
  | ({
      status: "completed";
      mode: "estimate" | "share";
      /** Whether Git was run with `--verify-filters`. */
      verifiedFilters: boolean;
      /** False when the filesystem cannot share data in place. */
      supported: boolean;
      summary: WorktreeReflinkSummary;
    } & WorktreeReflinkRuntime)
  /**
   * The selected Git is not the one the request was made for. Nothing ran;
   * the answer for the Git now selected is attached.
   */
  | ({ status: "runtime-changed" } & WorktreeReflinkRuntime)
  | { status: "failed"; reason: string };
