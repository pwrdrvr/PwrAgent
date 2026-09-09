export type CloudflareSetupRequest =
  | { action: "status" }
  | { action: "token-link" }
  | { action: "install-link" }
  | { action: "connect"; token: string; accountId: string; zoneId: string }
  | { action: "disconnect" }
  | { action: "provision"; hostname: string; listenPort: number }
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
