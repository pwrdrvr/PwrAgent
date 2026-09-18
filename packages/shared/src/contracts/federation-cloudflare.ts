/**
 * Reference material the setup pane can open, named rather than addressed.
 *
 * The renderer never supplies a URL — the main process resolves each key from a
 * fixed table — so no page or API response can turn `shell.openExternal` into an
 * arbitrary navigation. Account-scoped dashboard keys are interpolated with the
 * account id held in the main process.
 */
export type CloudflareSetupLink =
  | "mtls-docs"
  | "mtls-plans"
  | "signature-algorithms"
  | "service-token-docs"
  | "oauth-docs"
  | "github-login-docs"
  | "dash-mtls"
  | "dash-service-tokens"
  | "dash-applications"
  | "dash-policies"
  | "dash-tunnels"
  | "dash-login-methods"
  | "dash-zone-overview";

/**
 * Which credential Cloudflare Access admits this endpoint's clients with.
 *
 * `service-token` works on every Zero Trust plan and is the default. `oauth`
 * has each person sign in through the organization's login methods (GitHub,
 * one-time PIN, …) using Cloudflare's Managed OAuth, which Cloudflare marks as
 * Beta. `mtls` needs a Contract plan — confirmed unavailable on Free, where the
 * certificate authority upload is refused outright.
 */
export type CloudflareFederationGate = "service-token" | "oauth" | "mtls";

/**
 * What an operator has typed but not yet committed.
 *
 * Saved without validation and without the API token, which is never written
 * to disk. A draft is what lets setup be left half-done and resumed later; it
 * enables nothing on its own.
 */
export type CloudflareSetupDraft = {
  accountId?: string;
  zoneId?: string;
  hostname?: string;
  gate?: CloudflareFederationGate;
  emails?: string[];
};

/**
 * This instance's own sign-in to a Cloudflare endpoint that uses the `oauth`
 * gate — the client half, independent of any gateway this profile runs.
 *
 * `sign-in-required` means a refresh was refused (the grant expired or the
 * person was removed from the policy), so only an interactive sign-in helps.
 */
export type CloudflareSignInStatus = {
  endpoint: string;
  state: "signed-in" | "signed-out" | "sign-in-required";
  signedInAt?: string;
  accessExpiresAt?: string;
  lastError?: string;
};

export type CloudflareSetupRequest =
  | { action: "status" }
  | { action: "token-link" }
  | { action: "install-link" }
  | { action: "open-link"; link: CloudflareSetupLink }
  | { action: "save-draft"; draft: CloudflareSetupDraft }
  | {
      action: "connect";
      token: string;
      accountId: string;
      zoneId: string;
      /** The gate the operator chose; decides which Access permission is checked. */
      gate?: CloudflareFederationGate;
    }
  | { action: "disconnect" }
  | {
      action: "provision";
      hostname: string;
      listenPort: number;
      gate?: CloudflareFederationGate;
      /** Required for the `oauth` gate: who may sign in. */
      emails?: string[];
    }
  | { action: "set-emails"; emails: string[] }
  | { action: "audit" }
  | { action: "validate" }
  | { action: "start" }
  | { action: "stop" }
  | {
      action: "export-client";
      label: string;
      password: string;
      /** Lifetime of the enrollment invite inside the file, 1–24 hours. */
      inviteTtlHours?: number;
    }
  | { action: "import-client"; password: string }
  | { action: "revoke-client"; id: string }
  | { action: "sign-in" }
  | { action: "cancel-sign-in" }
  | { action: "sign-out" };

export type CloudflareSecurityCheck = {
  label: string;
  passed: boolean;
  detail: string;
};

export type CloudflareSetupStatus = {
  connected: boolean;
  /** The gate a provisioned endpoint uses; absent before one exists. */
  gate?: CloudflareFederationGate;
  accountId?: string;
  zoneId?: string;
  zoneName?: string;
  hostname?: string;
  tunnelId?: string;
  applicationId?: string;
  certificateId?: string;
  connectorRunning: boolean;
  connectorInstalled: boolean;
  phase?: string;
  clients: Array<{ id: string; label: string; expiresAt: string; revoked: boolean }>;
  /** `oauth` gate only: the people the Access policy lets sign in. */
  emails?: string[];
  draft?: CloudflareSetupDraft;
  signIn?: CloudflareSignInStatus;
  checks?: CloudflareSecurityCheck[];
  checkedAt?: string;
  message?: string;
};
