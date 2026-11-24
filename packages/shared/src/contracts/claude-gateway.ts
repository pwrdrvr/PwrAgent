/**
 * Claude Code's interactive gateway sign-in, driven through
 * `claude auth login --gateway-json`. Claude Code owns the flow and the
 * token; PwrAgent shows its questions and passes on the operator's answers.
 */

/** A question Claude Code asks before it continues. */
export type ClaudeGatewaySignInQuestion = {
  state: "url_input" | "trust_prompt" | "confirm_account";
  title?: string;
  detail?: string;
  /** What the operator is confirming: the URL, a certificate fingerprint, or the account. */
  shown: string;
  shownLabel?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

export type ClaudeGatewaySignInStep =
  | { state: "connecting" | "saving" | "done" | "cancelled" }
  | ClaudeGatewaySignInQuestion
  | {
      state: "polling";
      detail?: string;
      userCode?: string;
      verificationUri?: string;
      browserUrl?: string;
    }
  | { state: "error"; message: string; detail?: string };

export type ClaudeGatewaySignInProgress = {
  id: string;
  /** Increases with every step, so a waiter asks only for newer ones. */
  revision: number;
  step: ClaudeGatewaySignInStep;
};

export type ClaudeGatewayRequest =
  | { action: "start"; url: string }
  /** Resolves when a step newer than `after` arrives, or with the current one after a while. */
  | { action: "wait"; id: string; after: number }
  /** Accepts the question shown at `revision`. A stale revision is ignored. */
  | { action: "answer"; id: string; revision: number }
  | { action: "openBrowser"; id: string }
  | { action: "cancel"; id: string }
  /** `claude auth logout`; `forget` also removes the gateway from Claude Code's settings. */
  | { action: "signOut"; forget: boolean };

export type ClaudeGatewayResponse = { progress?: ClaudeGatewaySignInProgress };

export function isClaudeGatewaySignInFinished(step: ClaudeGatewaySignInStep): boolean {
  return step.state === "done" || step.state === "error" || step.state === "cancelled";
}
