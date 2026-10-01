import type { AppServerThreadReplay } from "./normalized-app-server";

export type HandoffInstanceThreadRequest = {
  sourceThreadId: string;
  targetInstanceId: string;
  operation: "copy" | "move";
  /** Native absolute path of an existing repository on the receiver. */
  targetRepositoryPath?: string;
};

export type HandoffInstanceThreadToolArgs = HandoffInstanceThreadRequest & {
  sourceInstanceId?: string;
};

export type HandoffInstanceThreadResult = {
  handoffId: string;
  sourceThreadId: string;
  instanceId: string;
  backend: "codex";
  threadId: string;
  directoryPath: string;
  sourceArchived: boolean;
  warnings: string[];
};

/** PwrAgent-owned envelope. The Codex payload is opaque, never parsed. */
export type ThreadHandoffPackage = {
  version: 1;
  handoffId: string;
  sourceThreadId: string;
  title?: string;
  historyDigest: string;
  rolloutBase64: string;
  git?: {
    bundleBase64: string;
    head: string;
    indexCommit: string;
    workingCommit: string;
    sourceBranch?: string;
    cwdRelative?: string;
    files: { path: string; dataBase64: string; mode: "100644" | "100755" }[];
  };
};

export type ThreadHandoffExport = {
  rolloutBase64: string;
  replay: AppServerThreadReplay;
  cwd?: string;
  title?: string;
};
