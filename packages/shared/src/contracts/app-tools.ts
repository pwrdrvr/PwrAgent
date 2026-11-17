import type { AppServerBackendKind } from "./normalized-app-server";

/** @deprecated Use PWRAGENT_TOOL_NAMESPACE for advertised dynamic tools. */
export const PWRAGENT_APP_TOOL_NAMESPACE = "pwragent_app";

export const PWRAGENT_APP_OPERATION_NAMES = ["manage_pwragent"] as const;

export type PwrAgentAppOperationName =
  (typeof PWRAGENT_APP_OPERATION_NAMES)[number];

export const PWRAGENT_APP_MANAGEMENT_ACTIONS = [
  "status",
  "upgrade_check",
  "download",
  "cancel",
  "restart",
  "stop",
] as const;

export type PwrAgentAppManagementAction =
  (typeof PWRAGENT_APP_MANAGEMENT_ACTIONS)[number];

export const PWRAGENT_APP_ERROR_CODES = [
  "invalid_arguments",
  "forbidden",
  "unsupported_operation",
  "internal_error",
] as const;

export type PwrAgentAppErrorCode = (typeof PWRAGENT_APP_ERROR_CODES)[number];

export type PwrAgentAppManagementContext = {
  /** Caller identity supplied by the local provider transport, never tool arguments. */
  backend?: AppServerBackendKind;
  threadId?: string;
  turnId?: string;
  now?: number;
  /** Trusted local transport acknowledgement, never a tool argument. */
  responseFlushed?: Promise<void>;
};

export type ManagePwrAgentToolArgs = {
  action: PwrAgentAppManagementAction;
  /** Opaque status token binds a mutation to the inspected owner and update state. */
  expectedStateToken?: string;
  /** Exact target, required for a download or download cancellation. */
  expectedVersion?: string;
  /** Cancel only this scheduled lifecycle operation, before preparation starts. */
  operationId?: string;
};

export function isPwrAgentUpdateVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128
    && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

export type PwrAgentAppToolArgsByOperation = {
  manage_pwragent: ManagePwrAgentToolArgs;
};

export type PwrAgentAppToolArgs<
  TOperation extends PwrAgentAppOperationName = PwrAgentAppOperationName,
> = PwrAgentAppToolArgsByOperation[TOperation];

/**
 * `"downgrade"` means the offered build is *older* than the running one: the
 * release resolved for the operator's own channel selection, which they can
 * only reach by moving back down. Absent means the normal forward case.
 */
export type PwrAgentUpdateToolDirection = "downgrade";

export type PwrAgentUpdateToolStatus =
  | { status: "idle" }
  | { status: "skipped"; reason: string }
  | { status: "checking" }
  | { status: "no-update"; version: string }
  | {
      status: "available";
      version: string;
      direction?: PwrAgentUpdateToolDirection;
    }
  | {
      status: "downloading";
      version: string;
      percent?: number;
      direction?: PwrAgentUpdateToolDirection;
    }
  | {
      status: "downloaded";
      version: string;
      direction?: PwrAgentUpdateToolDirection;
    }
  /** The operator stopped the download. Nothing failed and nothing is
   *  downloading, so the agent must not report it as either. */
  | {
      status: "canceled";
      version: string;
      direction?: PwrAgentUpdateToolDirection;
    }
  | { status: "error"; message: string };

export type PwrAgentAppRuntimeStatus = {
  runtimeId?: string;
  currentVersion: string;
  startedAt: number;
  startedAtIso: string;
  startedAtLocal: string;
  now: number;
  nowIso: string;
  nowLocal: string;
  uptimeMs: number;
  uptimeHuman: string;
};

/**
 * The Codex app server PwrAgent supervises, for troubleshooting. A long-lived
 * server is replaced while idle once it runs too long or starts too many
 * processes; `recycle` holds that policy and its last result.
 */
export type PwrAgentCodexAppServerStatus = {
  running: boolean;
  pid?: number;
  uptimeMs?: number;
  uptimeHuman?: string;
  /** Every process below the server: MCP servers, commands, terminals. */
  childProcessCount?: number;
  /** Reported where the OS lists descriptors cheaply (Linux). */
  openFdCount?: number;
  recycle: {
    enabled: boolean;
    idleMinutes: number;
    maxUptimeHours: number;
    maxChildProcesses: number;
    maxOpenFds: number;
    recycleCount: number;
    lastRecycle?: {
      atIso: string;
      reasons: string[];
      uptimeMs: number;
      idleMs: number;
      childProcessCount?: number;
      openFdCount?: number;
      orphansReaped?: number;
    };
    lastCheck?: { atIso: string; outcome: string; blocker?: string };
  };
};

export type PwrAgentLifecycleOperation = {
  id: string;
  action: "restart" | "stop";
  status: "waiting_for_response" | "confirming" | "preparing" | "handed_off" | "cancelled" | "failed";
  message?: string;
  expectedVersion?: string;
};

export type PwrAgentAppManagementData = {
  /** Read status again after a stale-state refusal. This token is process-local. */
  stateToken?: string;
  operation?: PwrAgentLifecycleOperation;
  action: PwrAgentAppManagementAction;
  runtime: PwrAgentAppRuntimeStatus;
  /** Present on `status` when the app server can be read. */
  codexAppServer?: PwrAgentCodexAppServerStatus;
  update: {
    status: PwrAgentUpdateToolStatus;
    updateAvailableToDownload: boolean;
    updateDownloadedWillInstallOnRestart: boolean;
  };
  result:
    | { status: "reported" }
    | { status: "check_completed"; check: PwrAgentUpdateToolStatus }
    | { status: "download_requested"; download: PwrAgentUpdateToolStatus }
    | { status: "download_cancel_requested"; cancelRequested: boolean }
    | { status: "restart_scheduled"; installingDownloadedUpdate: boolean }
    | { status: "stop_scheduled" }
    | { status: "restart_accepted"; installingDownloadedUpdate: boolean }
    | { status: "stop_accepted" }
    | { status: "cancelled"; message: string };
};

export type PwrAgentAppRequest<
  TOperation extends PwrAgentAppOperationName = PwrAgentAppOperationName,
> = {
  [TOperationKey in TOperation]: {
    operation: TOperationKey;
    context: PwrAgentAppManagementContext;
    args: PwrAgentAppToolArgs<TOperationKey>;
  };
}[TOperation];

export type PwrAgentAppResponse =
  | {
      ok: true;
      data: PwrAgentAppManagementData;
    }
  | {
      ok: false;
      error: {
        code: PwrAgentAppErrorCode;
        message: string;
      };
    };
