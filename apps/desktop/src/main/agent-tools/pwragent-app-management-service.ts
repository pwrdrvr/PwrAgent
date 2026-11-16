import { createHash, randomUUID } from "node:crypto";
import { applicationHost as app, getOwnerHostServices } from "../owner-host";
import type {
  PwrAgentAppManagementData,
  PwrAgentLifecycleOperation,
  PwrAgentAppRequest,
  PwrAgentAppResponse,
  PwrAgentCodexAppServerStatus,
  PwrAgentUpdateToolStatus,
} from "@pwragent/shared";
import type {
  AppUpdateCheckResult,
  AppUpdateStatus,
} from "../../shared/app-metadata";
const checkForAppUpdatesNow = (source: "manual") => getOwnerHostServices().updates.check(source);
const readAppUpdateStatus = () => getOwnerHostServices().updates.read();
const installDownloadedAppUpdate = (options: Parameters<ReturnType<typeof getOwnerHostServices>["updates"]["install"]>[0]) => getOwnerHostServices().updates.install(options);
const requestQuit = (options: Parameters<ReturnType<typeof getOwnerHostServices>["updates"]["requestQuit"]>[0]) => getOwnerHostServices().updates.requestQuit(options);
import type {
  CodexAppServerProcessSample,
  CodexAppServerRecycleSettings,
  CodexAppServerRecycleStatus,
} from "../codex-app-server/app-server-recycle-policy";

export type CodexAppServerDiagnostics = {
  process?: CodexAppServerProcessSample;
  recycle: CodexAppServerRecycleStatus;
  settings: CodexAppServerRecycleSettings;
};

export type PwrAgentAppManagementServiceOptions = {
  now?: () => number;
  readCodexAppServerDiagnostics?: () => Promise<CodexAppServerDiagnostics | undefined>;
  requestRestart?: (performRestart: () => void) => Promise<boolean>;
  requestStop?: (performStop: () => void) => Promise<boolean>;
  runtimeId?: string;
  startedAt: number;
  version?: () => string;
};

export function createPwrAgentAppManagementHandler(
  input: PwrAgentAppManagementServiceOptions,
) {
  const options = { ...input, runtimeId: input.runtimeId ?? randomUUID() };
  let operation: PwrAgentLifecycleOperation | undefined;
  let operationUpdate: AppUpdateStatus | undefined;
  const tokenFor = (status: AppUpdateStatus): string => createHash("sha256")
    .update(JSON.stringify([options.runtimeId, getOwnerHostServices().updates.stateToken?.(), toToolUpdateStatus(status)]))
    .digest("hex");
  const activeOperation = (): boolean => operation !== undefined
    && operation.status !== "cancelled" && operation.status !== "failed";
  const data = (
    action: PwrAgentAppManagementData["action"],
    status: AppUpdateStatus,
    result: PwrAgentAppManagementData["result"],
  ): PwrAgentAppManagementData => ({
    ...buildManagementData({ action, options, result, updateStatus: status }),
    stateToken: tokenFor(status),
    ...(operation ? { operation: { ...operation } } : {}),
  });

  return async (request: PwrAgentAppRequest): Promise<PwrAgentAppResponse> => {
    if (request.operation !== "manage_pwragent") {
      return { ok: false, error: { code: "unsupported_operation", message: "Unsupported PwrAgent app management operation." } };
    }
    const action = request.args.action;
    try {
      const status = readAppUpdateStatus();
      if (action !== "status" && request.args.expectedStateToken !== undefined
        && request.args.expectedStateToken !== tokenFor(status)) {
        return { ok: false, error: { code: "invalid_arguments", message: "PwrAgent owner or update state changed. Read status and request the intended operation again." } };
      }
      if (action === "upgrade_check") {
        if (activeOperation()) {
          return { ok: false, error: { code: "forbidden", message: "A lifecycle request is already in progress. Read status for its outcome." } };
        }
        const check = await checkForAppUpdatesNow("manual");
        return { ok: true, data: data(action, readAppUpdateStatus(), { status: "check_completed", check: toToolUpdateStatus(check) }) };
      }
      if (action === "restart" || action === "stop") {
        if (activeOperation() && operation?.action !== action) {
          return { ok: false, error: { code: "forbidden", message: "Another lifecycle request is already in progress. Read status for its outcome." } };
        }
        if (!activeOperation()) {
          if (!request.context.responseFlushed) {
            return { ok: false, error: { code: "unsupported_operation", message: "This transport cannot acknowledge a lifecycle request safely. Use the desktop quit/update controls." } };
          }
          if (action === "restart" && ["checking", "available", "downloading"].includes(status.status)) {
            return { ok: false, error: { code: "forbidden", message: "An update check or download is in progress. Wait for it to finish before requesting restart." } };
          }
          const expectedState = tokenFor(status);
          operationUpdate = status;
          const current: PwrAgentLifecycleOperation = { id: randomUUID(), action, status: "waiting_for_response" };
          operation = current;
          // The acknowledgement names a scheduled request, not a completed
          // confirmation or install. No timer guesses when the caller heard it.
          void request.context.responseFlushed.then(async () => {
            if (tokenFor(readAppUpdateStatus()) !== expectedState) {
              current.status = "cancelled";
              current.message = "Update state changed before acknowledgement. Read status and retry.";
              return;
            }
            current.status = "confirming";
            let accepted: boolean;
            if (action === "restart" && status.status === "downloaded") {
              const install = await installDownloadedAppUpdate({
                expectedVersion: status.version,
                requestQuit: async (performQuit, beforeQuit) => await requestQuit({
                  performQuit,
                  beforeQuit: () => {
                    const authorized = beforeQuit?.() ?? true;
                    if (authorized) current.status = "preparing";
                    return authorized;
                  },
                  quietRestart: true, source: "update-install",
                }),
              });
              accepted = install.status === "restarting";
              if (!accepted && install.status === "error") current.message = install.message;
            } else {
              const performQuit = action === "restart"
                ? () => { app.relaunch(); app.quit(); }
                : () => { app.quit(); };
              const injected = action === "restart" ? options.requestRestart : options.requestStop;
              const release = getOwnerHostServices().updates.reserveQuit?.();
              accepted = false;
              try {
                accepted = injected ? await injected(performQuit) : await requestQuit({
                  performQuit,
                  beforeQuit: () => {
                    const authorized = tokenFor(readAppUpdateStatus()) === expectedState;
                    if (authorized) current.status = "preparing";
                    return authorized;
                  },
                  ...(action === "restart" ? { quietRestart: true } : {}),
                  source: "agent-tool",
                });
              } finally {
                if (!accepted) release?.();
              }
            }
            current.status = accepted ? "handed_off" : "cancelled";
            if (!accepted) current.message ??= "PwrAgent lifecycle request cancelled.";
          }).catch((error: unknown) => {
            current.status = "failed";
            current.message = error instanceof Error ? error.message : String(error);
          });
        }
        return { ok: true, data: data(action, status, action === "restart"
          ? { status: operation?.status === "handed_off" ? "restart_accepted" : "restart_scheduled", installingDownloadedUpdate: operationUpdate?.status === "downloaded" }
          : { status: operation?.status === "handed_off" ? "stop_accepted" : "stop_scheduled" }) };
      }
      const codexAppServer = await options.readCodexAppServerDiagnostics?.().catch(() => undefined);
      return { ok: true, data: {
        ...data(action, readAppUpdateStatus(), { status: "reported" }),
        ...(codexAppServer ? { codexAppServer: toCodexAppServerStatus(codexAppServer) } : {}),
      } };
    } catch (error) {
      return { ok: false, error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) } };
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
    runtimeId: options.runtimeId,
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

export function toCodexAppServerStatus(
  diagnostics: CodexAppServerDiagnostics,
): PwrAgentCodexAppServerStatus {
  const { process, recycle, settings } = diagnostics;
  const last = recycle.lastRecycle;
  return {
    running: process !== undefined,
    ...(process
      ? {
          pid: process.pid,
          uptimeMs: process.uptimeMs,
          uptimeHuman: formatDuration(process.uptimeMs),
          ...(process.childProcessCount !== undefined
            ? { childProcessCount: process.childProcessCount }
            : {}),
          ...(process.openFdCount !== undefined ? { openFdCount: process.openFdCount } : {}),
        }
      : {}),
    recycle: {
      enabled: settings.enabled,
      idleMinutes: settings.idleMs / 60_000,
      maxUptimeHours: settings.maxUptimeMs / 3_600_000,
      maxChildProcesses: settings.maxChildProcesses,
      maxOpenFds: settings.maxOpenFds,
      recycleCount: recycle.recycleCount,
      ...(last
        ? {
            lastRecycle: {
              atIso: new Date(last.at).toISOString(),
              reasons: [...last.reasons],
              uptimeMs: last.uptimeMs,
              idleMs: last.idleMs,
              ...(last.childProcessCount !== undefined
                ? { childProcessCount: last.childProcessCount }
                : {}),
              ...(last.openFdCount !== undefined ? { openFdCount: last.openFdCount } : {}),
              ...(last.orphansReaped !== undefined ? { orphansReaped: last.orphansReaped } : {}),
            },
          }
        : {}),
      ...(recycle.lastCheck
        ? {
            lastCheck: {
              atIso: new Date(recycle.lastCheck.at).toISOString(),
              outcome: recycle.lastCheck.outcome,
              ...(recycle.lastCheck.blocker ? { blocker: recycle.lastCheck.blocker } : {}),
            },
          }
        : {}),
    },
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
      return { status: "no-update", version: status.version };
    // `direction` has to survive the conversion, or the tool reports a switch
    // back onto the operator's selected channel as an ordinary update and the
    // agent describes a move backwards as forward progress.
    case "available":
    case "downloaded":
    case "canceled":
      return {
        status: status.status,
        version: status.version,
        ...(status.direction ? { direction: status.direction } : {}),
      };
    case "downloading":
      return {
        status: "downloading",
        version: status.version,
        ...(status.percent !== undefined ? { percent: status.percent } : {}),
        ...(status.direction ? { direction: status.direction } : {}),
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
