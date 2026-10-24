import { beforeEach, describe, expect, it, vi } from "vitest";

const appMock = {
  getVersion: vi.fn(() => "1.2.3"),
  quit: vi.fn(),
  relaunch: vi.fn(),
};
const checkForAppUpdatesNowMock = vi.fn();
const installDownloadedAppUpdateMock = vi.fn();
const readAppUpdateStatusMock = vi.fn();
const requestQuitMock = vi.fn();

vi.mock("electron", () => ({
  app: appMock,
}));

vi.mock("../auto-updater", () => ({
  checkForAppUpdatesNow: checkForAppUpdatesNowMock,
  installDownloadedAppUpdate: installDownloadedAppUpdateMock,
  readAppUpdateStatus: readAppUpdateStatusMock,
}));

vi.mock("../quit-manager", () => ({
  requestQuit: requestQuitMock,
}));

describe("PwrAgent app management service", () => {
  beforeEach(() => {
    appMock.getVersion.mockReturnValue("1.2.3");
    appMock.quit.mockReset();
    appMock.relaunch.mockReset();
    checkForAppUpdatesNowMock.mockReset();
    installDownloadedAppUpdateMock.mockReset();
    readAppUpdateStatusMock.mockReset();
    readAppUpdateStatusMock.mockReturnValue({ status: "idle" });
    requestQuitMock.mockReset();
  });

  it("reports current version, local start time fields, and uptime", async () => {
    const { createPwrAgentAppManagementHandler } = await import(
      "../agent-tools/pwragent-app-management-service"
    );
    const handler = createPwrAgentAppManagementHandler({
      now: () => 121_000,
      startedAt: 1_000,
      version: () => "9.9.9",
    });

    await expect(
      handler({
        operation: "manage_pwragent",
        context: {},
        args: { action: "status" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        action: "status",
        runtime: {
          currentVersion: "9.9.9",
          startedAt: 1_000,
          startedAtIso: "1970-01-01T00:00:01.000Z",
          now: 121_000,
          nowIso: "1970-01-01T00:02:01.000Z",
          uptimeMs: 120_000,
          uptimeHuman: "2m 0s",
        },
        update: {
          status: { status: "idle" },
          updateAvailableToDownload: false,
          updateDownloadedWillInstallOnRestart: false,
        },
        result: { status: "reported" },
      },
    });
  });

  it("checks for upgrades and marks downloaded updates as restart-ready", async () => {
    checkForAppUpdatesNowMock.mockResolvedValue({
      status: "downloaded",
      version: "1.2.4",
    });
    const { createPwrAgentAppManagementHandler } = await import(
      "../agent-tools/pwragent-app-management-service"
    );
    const handler = createPwrAgentAppManagementHandler({
      now: () => 2_000,
      startedAt: 1_000,
    });

    const response = await handler({
      operation: "manage_pwragent",
      context: {},
      args: { action: "upgrade_check" },
    });

    expect(checkForAppUpdatesNowMock).toHaveBeenCalledWith("manual");
    expect(response).toMatchObject({
      ok: true,
      data: {
        update: {
          status: { status: "downloaded", version: "1.2.4" },
          updateDownloadedWillInstallOnRestart: true,
        },
        result: {
          status: "check_completed",
          check: { status: "downloaded", version: "1.2.4" },
        },
      },
    });
  });

  it("routes plain restarts through the injected restart confirmation", async () => {
    readAppUpdateStatusMock.mockReturnValue({
      status: "available",
      version: "1.2.4",
    });
    const requestRestart = vi.fn(async (performRestart: () => void) => {
      performRestart();
      return true;
    });
    const { createPwrAgentAppManagementHandler } = await import(
      "../agent-tools/pwragent-app-management-service"
    );
    const handler = createPwrAgentAppManagementHandler({
      now: () => 2_000,
      requestRestart,
      startedAt: 1_000,
    });

    const response = await handler({
      operation: "manage_pwragent",
      context: {},
      args: { action: "restart" },
    });

    expect(requestRestart).toHaveBeenCalledTimes(1);
    expect(appMock.relaunch).toHaveBeenCalledTimes(1);
    expect(appMock.quit).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      ok: true,
      data: {
        result: {
          status: "restart_accepted",
          installingDownloadedUpdate: false,
        },
        update: {
          updateAvailableToDownload: true,
          updateDownloadedWillInstallOnRestart: false,
        },
      },
    });
  });

  it("keeps the switch-back direction on the reported update status", async () => {
    // Without this the agent describes a move back down onto the operator's
    // selected channel as an ordinary update to a lower version.
    checkForAppUpdatesNowMock.mockResolvedValue({
      status: "available",
      version: "1.0.2",
      direction: "downgrade",
    });
    const { createPwrAgentAppManagementHandler } = await import(
      "../agent-tools/pwragent-app-management-service"
    );
    const handler = createPwrAgentAppManagementHandler({ startedAt: 1_000 });

    await expect(
      handler({
        operation: "manage_pwragent",
        context: {},
        args: { action: "upgrade_check" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        result: {
          status: "check_completed",
          check: { status: "available", version: "1.0.2", direction: "downgrade" },
        },
        update: {
          status: { status: "available", version: "1.0.2", direction: "downgrade" },
        },
      },
    });
  });

  it("authorizes a downloaded install before the agent-tool quit is deferred", async () => {
    readAppUpdateStatusMock.mockReturnValue({ status: "downloaded", version: "1.2.4" });
    const beforeQuit = vi.fn(() => false);
    const performQuit = vi.fn();
    requestQuitMock.mockImplementation(async (options) => {
      expect(options.source).toBe("update-install");
      expect(options.beforeQuit).toBe(beforeQuit);
      if (!options.beforeQuit()) return false;
      options.performQuit();
      return true;
    });
    installDownloadedAppUpdateMock.mockImplementation(async (options) => {
      const accepted = await options.requestQuit(performQuit, beforeQuit);
      return accepted ? { status: "restarting" } : { status: "error", message: "Not authorized" };
    });
    const { createPwrAgentAppManagementHandler } = await import("../agent-tools/pwragent-app-management-service");
    const handler = createPwrAgentAppManagementHandler({ startedAt: 1_000 });
    const response = await handler({ operation: "manage_pwragent", context: {}, args: { action: "restart" } });
    expect(beforeQuit).toHaveBeenCalledOnce();
    expect(performQuit).not.toHaveBeenCalled();
    expect(response).toMatchObject({ data: { result: { status: "cancelled", message: "Not authorized" } } });
    vi.useFakeTimers();
    try {
      beforeQuit.mockReturnValue(true);
      await handler({ operation: "manage_pwragent", context: {}, args: { action: "restart" } });
      expect(performQuit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(150);
      expect(performQuit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses update install when restarting with a downloaded update", async () => {
    readAppUpdateStatusMock.mockReturnValue({
      status: "downloaded",
      version: "1.2.4",
    });
    installDownloadedAppUpdateMock.mockResolvedValue({ status: "restarting" });
    const { createPwrAgentAppManagementHandler } = await import(
      "../agent-tools/pwragent-app-management-service"
    );
    const handler = createPwrAgentAppManagementHandler({
      now: () => 2_000,
      startedAt: 1_000,
    });

    const response = await handler({
      operation: "manage_pwragent",
      context: {},
      args: { action: "restart" },
    });

    expect(installDownloadedAppUpdateMock).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      ok: true,
      data: {
        result: {
          status: "restart_accepted",
          installingDownloadedUpdate: true,
        },
        update: {
          updateDownloadedWillInstallOnRestart: true,
        },
      },
    });
  });
});
