import type { AppServerThreadReplay } from "./normalized-app-server";

export type HandoffInstanceThreadRequest = {
  handoffId?: string;
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

/** Published Git history used to create the receiver's workspace. */
export type ThreadHandoffGitReference = {
  head: string;
  ref: string;
  /** Normalized repository identity; credentials are never transferred. */
  origin: string;
  sourceBranch?: string;
  cwdRelative?: string;
};

export type ThreadHandoffPrepareRequest = {
  repository?: string;
  git?: ThreadHandoffGitReference;
};

export type ThreadHandoffPrepareResult = {
  version: 2;
  platform: string;
  git?: { head: string };
};

/** PwrAgent-owned envelope. The Codex payload is opaque, never parsed. */
export type ThreadHandoffPackage = {
  version: 2;
  handoffId: string;
  sourceThreadId: string;
  title?: string;
  historyDigest: string;
  rolloutBase64: string;
  git?: ThreadHandoffGitReference;
  workspace?: {
    format: "tar.gz" | "zip";
    dataBase64: string;
    warnings: string[];
  };
};

export type ThreadHandoffExport = {
  rolloutBase64: string;
  replay: AppServerThreadReplay;
  cwd?: string;
  title?: string;
};

export type ThreadHandoffPhase = "package" | "send" | "import" | "verify" | "archive";

export interface ThreadHandoffProgress {
  handoffId: string;
  sourceThreadId: string;
  phase: ThreadHandoffPhase;
  /** Send phase only. Bytes the receiver has committed, which never decreases. */
  bytesCommitted?: number;
  /** Send phase only. Receiver-acknowledged bytes; may return to the durable offset on reconnect. */
  bytesSent?: number;
  bytesTotal?: number;
  /** Set once a transfer resumes from a non-zero committed offset. */
  resumedFromBytes?: number;
  /** "waiting": the connection dropped and a resumable transfer is held. */
  link: "connected" | "waiting";
  disconnectedAt?: string;
  /** False once thread.handoff.import has been sent. */
  cancelable: boolean;
  /** "single_shot": an older peer, where a drop fails the send. */
  transport: "resumable" | "single_shot";
}

export type CancelThreadHandoffRequest = { handoffId: string };
export type RetryThreadHandoffNowRequest = { handoffId: string };
