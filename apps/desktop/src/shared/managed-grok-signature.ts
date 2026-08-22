/**
 * A managed Grok bundle whose code signature did not match the running
 * PwrAgent build's own signing identity.
 *
 * A staged download has not been installed or executed. An installed cache may
 * have been activated during an earlier launch, so this event only promises
 * that the current validation attempt refused to run it.
 */
export type ManagedGrokSignatureRejectedEvent = {
  /** Underlying verification failure, for the toast's copyable detail. */
  detail: string;
  /** Directory that held the rejected bundle. */
  directory: string;
  /** Stable identity used to replay and acknowledge this safety event. */
  id: string;
  occurredAt: number;
  /** Whether the rejected bundle was removed from disk. */
  removed: boolean;
  /**
   * `download` — rejected in staging, before it could be installed.
   * `installed` — an already-installed copy failed its re-verification.
   */
  stage: "download" | "installed";
  tag?: string;
};
