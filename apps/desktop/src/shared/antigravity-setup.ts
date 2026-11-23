export type AntigravityRuntimeStatus =
  | { status: "unsupported" | "not-installed" }
  | { status: "installed"; runtime: { command: string; version: string } };

export type AntigravitySetupRequest =
  | { action: "read" | "install" | "install-guide" }
  | { action: "start" | "wait" | "cancel" | "reopen" | "copy-link"; attemptId: string }
  | { action: "submit"; attemptId: string; code: string };

export type AntigravitySetupResult =
  | { ok: false; message: string }
  | { ok: true; runtime?: AntigravityRuntimeStatus; expiresAt?: number; verifiedCommand?: string };
