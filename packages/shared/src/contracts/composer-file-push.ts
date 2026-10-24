import type { FederationRemoteTarget } from "./federation";

/**
 * Copy one file the operator picked or dropped on this machine to the
 * instance that owns a remote thread, so the turn can reference the owner's
 * copy. `uploadId` is minted by the renderer and names the transfer for
 * progress events and cancellation.
 */
export type PushComposerFileRequest = {
  uploadId: string;
  target: FederationRemoteTarget;
  /** Absolute path on this machine. */
  sourcePath: string;
};

/** Where the owner saved the file, in its own path syntax. */
export type PushComposerFileResult = {
  path: string;
  sizeBytes: number;
  sha256: string;
};

export type CancelComposerFilePushRequest = {
  uploadId: string;
};

/** Bytes the owner has acknowledged so far. */
export type ComposerFilePushProgress = {
  uploadId: string;
  sentBytes: number;
  totalBytes: number;
};
