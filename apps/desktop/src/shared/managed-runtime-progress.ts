// What a PwrAgent-managed runtime download reports while it works.
//
// Codex and Grok install the same way (fetch a signed archive, verify it,
// unpack it, activate the version directory), so one event shape describes both
// and one strip in Settings renders either.

export type ManagedRuntimeId = "codex" | "grok";

/**
 * `idle` clears the strip: a check that found nothing new, or an abort. It is
 * never held as state, only sent so a subscriber drops what it was showing.
 */
export type ManagedRuntimePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "unpacking"
  | "activating"
  | "ready"
  | "failed";

/** The phases that make up an install, in the order they run. */
export const MANAGED_RUNTIME_INSTALL_PHASES = [
  "downloading",
  "verifying",
  "unpacking",
  "activating",
] as const;

export type ManagedRuntimeInstallPhase =
  (typeof MANAGED_RUNTIME_INSTALL_PHASES)[number];

export type ManagedRuntimeProgress = {
  runtime: ManagedRuntimeId;
  phase: ManagedRuntimePhase;
  /** Release tag being installed; absent while `checking`. */
  tag?: string;
  /** Archive bytes written so far. Only meaningful while `downloading`. */
  receivedBytes?: number;
  /** Archive size the release advertises, when it advertises one. */
  totalBytes?: number;
  bytesPerSecond?: number;
  /** `failed` only: the message, and which install phase it stopped in. */
  error?: string;
  failedPhase?: ManagedRuntimeInstallPhase | "checking";
  /** `failed` only: an older verified build is installed and still in use. */
  fallbackTag?: string;
  updatedAt: number;
};
