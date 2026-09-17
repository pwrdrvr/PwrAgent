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
  | "dash-mtls"
  | "dash-service-tokens"
  | "dash-applications"
  | "dash-policies"
  | "dash-tunnels"
  | "dash-zone-overview";

/**
 * Which credential Cloudflare Access admits this endpoint's clients with.
 *
 * `service-token` works on every Zero Trust plan and is the default. `mtls`
 * needs a paid plan — confirmed unavailable on Free, where the certificate
 * authority upload is refused outright.
 */
export type CloudflareFederationGate = "service-token" | "mtls";

export type CloudflareSetupRequest =
  | { action: "status" }
  | { action: "token-link" }
  | { action: "install-link" }
  | { action: "open-link"; link: CloudflareSetupLink }
  | { action: "connect"; token: string; accountId: string; zoneId: string }
  | { action: "disconnect" }
  | { action: "provision"; hostname: string; listenPort: number; gate?: CloudflareFederationGate }
  | { action: "audit" }
  | { action: "validate" }
  | { action: "start" }
  | { action: "stop" }
  | { action: "export-client"; label: string; password: string }
  | { action: "import-client"; password: string }
  | { action: "revoke-client"; id: string };

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
  checks?: CloudflareSecurityCheck[];
  checkedAt?: string;
  message?: string;
};
