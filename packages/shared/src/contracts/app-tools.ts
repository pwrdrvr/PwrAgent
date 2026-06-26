/** @deprecated Use PWRAGENT_TOOL_NAMESPACE for advertised dynamic tools. */
export const PWRAGENT_APP_TOOL_NAMESPACE = "pwragent_app";

export const PWRAGENT_APP_OPERATION_NAMES = ["manage_pwragent"] as const;

export type PwrAgentAppOperationName =
  (typeof PWRAGENT_APP_OPERATION_NAMES)[number];

export const PWRAGENT_APP_MANAGEMENT_ACTIONS = [
  "status",
  "upgrade_check",
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
  now?: number;
};

export type ManagePwrAgentToolArgs = {
  action: PwrAgentAppManagementAction;
};

export type PwrAgentAppToolArgsByOperation = {
  manage_pwragent: ManagePwrAgentToolArgs;
};

export type PwrAgentAppToolArgs<
  TOperation extends PwrAgentAppOperationName = PwrAgentAppOperationName,
> = PwrAgentAppToolArgsByOperation[TOperation];

export type PwrAgentUpdateToolStatus =
  | { status: "idle" }
  | { status: "skipped"; reason: string }
  | { status: "checking" }
  | { status: "no-update"; version: string }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent?: number }
  | { status: "downloaded"; version: string }
  | { status: "error"; message: string };

export type PwrAgentAppRuntimeStatus = {
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

export type PwrAgentAppManagementData = {
  action: PwrAgentAppManagementAction;
  runtime: PwrAgentAppRuntimeStatus;
  update: {
    status: PwrAgentUpdateToolStatus;
    updateAvailableToDownload: boolean;
    updateDownloadedWillInstallOnRestart: boolean;
  };
  result:
    | { status: "reported" }
    | { status: "check_completed"; check: PwrAgentUpdateToolStatus }
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
