import type { GhStack, GhStackCatalog } from "./catalog";

export interface GitResult { stdout: string; stderr: string; exitCode: number }

export interface GitRunner {
  run(cwd: string, args: string[], opts?: { stdin?: string }): Promise<GitResult>;
}

export interface CatalogStore {
  withOperationLock<T>(commonDir: string, fn: () => Promise<T>): Promise<T>;
  read(commonDir: string): Promise<{ catalog: GhStackCatalog; sha256: string }>;
  writeIfUnchanged(commonDir: string, next: GhStackCatalog, sha256: string): Promise<void>;
}

export type StackOperation = (
  | { kind: "restack"; root: string; from?: string; stopBefore?: string }
  | { kind: "sync"; root: string; branch: string; onto: string; merged: { number: number; head: string; commit: string } }
  | { kind: "adopt"; stack: GhStack; repository: string }
  | { kind: "add_branch"; root: string; branch: string }
  | { kind: "remove"; root: string; branch: string; mode: "detach" | "forget" }
) & { conflictResolution?: { branch: string; base: string; previousTip: string } };

export type RefMove = { branch: string; old: string | null; next: string | null };
export type WorktreeFollow = { branch: string; path: string; old: string; next: string };
export type Patch = { commit: string; id: string };
export type StackStep = {
  branch: string;
  parent: string;
  oldBase: string;
  newBase: string;
  oldTip: string;
  newTip?: string;
  proof?: { preserved: number; dropped: Patch[] };
  conflict?: { commit: string; files: string[] };
};

export interface StackPlan {
  operation: StackOperation;
  expectedTips: Record<string, string | null>;
  steps: StackStep[];
  moves: RefMove[];
  worktrees: WorktreeFollow[];
  blocked: { path: string; files: string[] }[];
  catalogHash: string;
  before: GhStackCatalog;
  after: GhStackCatalog;
  /** Catalog after applying the proved prefix, available for a restack conflict. */
  cleanPrefix?: GhStackCatalog;
}

export interface StackReceipt {
  id: string;
  moves: RefMove[];
  before: GhStackCatalog;
  after: GhStackCatalog;
  when: number;
  /** Original pre-replay tips carried across unpublished rewrites. */
  publishBoundaries?: Record<string, string>;
}

export type StackJournal = {
  direction: "apply" | "undo";
  receipt: StackReceipt;
  worktrees: WorktreeFollow[];
};

/** App-owned journal lifecycle stays with the host. The portable engine calls
 * these hooks under the catalog's operation lock and never opens a file. */
export interface ApplyHooks {
  beforeTransaction?: () => Promise<void>;
  prepareReceipt?: (receipt: StackReceipt) => Promise<(manifest: string) => string[]>;
  begin?: (entry: StackJournal) => Promise<void>;
  finish?: (outcome: "committed" | "aborted", receipt: StackReceipt) => Promise<void>;
}
