/**
 * A downloaded managed Grok bundle whose code signature did not match the
 * running PwrAgent build's own signing identity.
 *
 * PwrAgent verifies the bundle before it is ever executed and deletes it when
 * the identity does not match, so this event describes a runtime that was
 * thrown away rather than one that ran. It is surfaced to the operator because
 * a mismatch is exactly the signal worth seeing if a download were ever
 * substituted — and because the download happens while the operator is doing
 * something else, so a silent rejection reads as Grok simply being missing.
 */
export type ManagedGrokSignatureRejectedEvent = {
  /** Underlying verification failure, for the toast's copyable detail. */
  detail: string;
  /** Directory that held the rejected bundle. */
  directory: string;
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
