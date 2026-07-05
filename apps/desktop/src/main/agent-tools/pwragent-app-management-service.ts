import { app } from "electron";
import type {
  PwrAgentAppManagementData,
  PwrAgentAppRequest,
  PwrAgentAppResponse,
  PwrAgentUpdateToolStatus,
} from "@pwragent/shared";
import type {
  AppUpdateCheckResult,
  AppUpdateStatus,
} from "../../shared/app-metadata";
import {
  checkForAppUpdatesNow,
  installDownloadedAppUpdate,
  readAppUpdateStatus,
} from "../auto-updater";
import { requestQuit } from "../quit-manager";

export type PwrAgentAppManagementServiceOptions = {
  now?: () => number;
  requestRestart?: (performRestart: () => void) => Promise<boolean>;
  requestStop?: (performStop: () => void) => Promise<boolean>;
  startedAt: number;
  version?: () => string;
};

const DEFER_QUIT_MS = 150;

export function createPwrAgentAppManagementHandler(
  options: PwrAgentAppManagementServiceOptions,
) {
  return async (request: PwrAgentAppRequest): Promise<PwrAgentAppResponse> => {
    if (request.operation !== "manage_pwragent") {
      return {
        ok: false,
        error: {
          code: "unsupported_operation",
          message: "Unsupported PwrAgent app management operation.",
        },
      };
    }

    const action = request.args.action;
    try {
      if (action === "upgrade_check") {
        const check = await checkForAppUpdatesNow("manual");
        return {
          ok: true,
          data: buildManagementData({
            action,
            check,
            options,
            result: {
              status: "check_completed",
              check: toToolUpdateStatus(check),
            },
            updateStatus: toToolUpdateStatus(check),
          }),
        };
      }

      if (action === "restart") {
        const status = readAppUpdateStatus();
        if (status.status === "downloaded") {
          const install = await installDownloadedAppUpdate({
            requestQuit: async (performQuit) =>
              await requestQuit({
                performQuit: () => defer(performQuit),
                source: "update-install",
              }),
          });
          if (install.status === "error") {
            return {
              ok: true,
              data: buildManagementData({
                action,
                options,
                result: { status: "cancelled", message: install.message },
                updateStatus: status,
              }),
            };
          }
          return {
            ok: true,
            data: buildManagementData({
              action,
              options,
              result: {
                status: "restart_accepted",
                installingDownloadedUpdate: true,
              },
              updateStatus: status,
            }),
          };
        }

        const accepted = await (
          options.requestRestart
          ?? (async (performRestart) =>
            await requestQuit({
              performQuit: () => defer(performRestart),
              source: "agent-tool",
            }))
        )(() => {
          app.relaunch();
          app.quit();
        });
        return {
          ok: true,
          data: buildManagementData({
            action,
            options,
            result: accepted
              ? {
                  status: "restart_accepted",
                  installingDownloadedUpdate: false,
                }
              : { status: "cancelled", message: "PwrAgent restart cancelled." },
            updateStatus: status,
          }),
        };
      }

      if (action === "stop") {
        const status = readAppUpdateStatus();
        const accepted = await (
          options.requestStop
          ?? (async (performStop) =>
            await requestQuit({
              performQuit: () => defer(performStop),
              source: "agent-tool",
            }))
        )(() => {
          app.quit();
        });
        return {
          ok: true,
          data: buildManagementData({
            action,
            options,
            result: accepted
              ? { status: "stop_accepted" }
              : { status: "cancelled", message: "PwrAgent stop cancelled." },
            updateStatus: status,
          }),
        };
      }

      return {
        ok: true,
        data: buildManagementData({
          action,
          options,
          result: { status: "reported" },
          updateStatus: readAppUpdateStatus(),
        }),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };
}

function buildManagementData(params: {
  action: PwrAgentAppManagementData["action"];
  check?: AppUpdateCheckResult;
  options: PwrAgentAppManagementServiceOptions;
  result: PwrAgentAppManagementData["result"];
  updateStatus: AppUpdateStatus | PwrAgentUpdateToolStatus;
}): PwrAgentAppManagementData {
  const status = toToolUpdateStatus(params.updateStatus);
  return {
    action: params.action,
    runtime: buildRuntimeStatus(params.options),
    update: {
      status,
      updateAvailableToDownload: status.status === "available",
      updateDownloadedWillInstallOnRestart: status.status === "downloaded",
    },
    result: params.result,
  };
}

function buildRuntimeStatus(
  options: PwrAgentAppManagementServiceOptions,
): PwrAgentAppManagementData["runtime"] {
  const now = options.now?.() ?? Date.now();
  const uptimeMs = Math.max(0, now - options.startedAt);
  return {
    currentVersion: options.version?.() ?? app.getVersion(),
    startedAt: options.startedAt,
    startedAtIso: new Date(options.startedAt).toISOString(),
    startedAtLocal: formatLocalDateTime(options.startedAt),
    now,
    nowIso: new Date(now).toISOString(),
    nowLocal: formatLocalDateTime(now),
    uptimeMs,
    uptimeHuman: formatDuration(uptimeMs),
  };
}

function toToolUpdateStatus(
  status: AppUpdateStatus | AppUpdateCheckResult | PwrAgentUpdateToolStatus,
): PwrAgentUpdateToolStatus {
  switch (status.status) {
    case "idle":
    case "checking":
      return { status: status.status };
    case "skipped":
      return { status: "skipped", reason: status.reason };
    case "no-update":
    case "available":
    case "downloaded":
      return { status: status.status, version: status.version };
    case "downloading":
      return {
        status: "downloading",
        version: status.version,
        ...(status.percent !== undefined ? { percent: status.percent } : {}),
      };
    case "error":
      return { status: "error", message: status.message };
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${hours}h`);
  if (minutes || parts.length) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatLocalDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function defer(fn: () => void): void {
  setTimeout(fn, DEFER_QUIT_MS).unref?.();
}
