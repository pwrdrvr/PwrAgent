import { beforeEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { PwrAgentAppRequest } from "@pwragent/shared";
import type { AppUpdateStatus } from "../../shared/app-metadata";
import { getOwnerHostServices } from "../owner-host";
import { createPwrAgentAppManagementHandler } from "../agent-tools/pwragent-app-management-service";
import { authorizeAppManagement } from "../agent-tools/app-management-authorization";

let state: AppUpdateStatus;
const nativeInstall = vi.fn();
const download = vi.fn();
const cancelDownload = vi.fn();
const quit = vi.fn();
const prepareRestart = vi.fn();
const caller = { backend: "codex" as const, threadId: "manager", turnId: "turn" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  state = { status: "available", version: "1.4.8" };
  nativeInstall.mockReset();
  download.mockReset().mockImplementation(async () => { state = { status: "downloading", version: "1.4.8", percent: 0 }; return state; });
  cancelDownload.mockReset().mockReturnValue({ canceled: true });
  prepareRestart.mockReset().mockResolvedValue(vi.fn());
  quit.mockReset().mockImplementation(async (options) => {
    if (!await options.authorizeAgent?.() || !options.beforeQuit?.()) return false;
    options.performQuit();
    return true;
  });
  getOwnerHostServices().updates = {
    read: () => state, stateToken: () => JSON.stringify(state),
    check: vi.fn(async () => state.status === "available" ? state : { status: "no-update" as const, version: "1.4.7" }), download, cancelDownload, requestQuit: quit,
    install: vi.fn(async (options) => await options.requestQuit(nativeInstall, () => true)
      ? { status: "restarting" as const } : { status: "error" as const, message: "Cancelled" }),
  };
});

const request = (args: PwrAgentAppRequest["args"], responseFlushed?: Promise<void>): PwrAgentAppRequest => ({
  operation: "manage_pwragent", context: { ...caller, ...(responseFlushed ? { responseFlushed } : {}) }, args,
});

it("completes 1.4.7 → available 1.4.8 → download → acknowledged quiet install through tools", async () => {
  const handler = createPwrAgentAppManagementHandler({ startedAt: 1, version: () => "1.4.7", authorize: async () => true, prepareRestart });
  expect(await handler(request({ action: "status" }))).toMatchObject({ data: { runtime: { currentVersion: "1.4.7" } } });
  expect(await handler(request({ action: "upgrade_check" }))).toMatchObject({ data: { update: { updateAvailableToDownload: true, updateDownloadedWillInstallOnRestart: false } } });
  expect(await handler(request({ action: "download", expectedVersion: "1.4.8" }))).toMatchObject({ data: { result: { status: "download_requested" } } });
  expect(download).toHaveBeenCalledExactlyOnceWith({ expectedVersion: "1.4.8" });
  expect(await handler(request({ action: "restart", expectedVersion: "1.4.8" }, Promise.resolve()))).toMatchObject({ ok: false });
  expect(quit).not.toHaveBeenCalled();
  state = { status: "downloaded", version: "1.4.8" };
  const flush = deferred();
  const response = await handler(request({ action: "restart", expectedVersion: "1.4.8" }, flush.promise));
  expect(response).toMatchObject({ data: { result: { status: "restart_scheduled", installingDownloadedUpdate: true } } });
  expect(nativeInstall).not.toHaveBeenCalled();
  flush.resolve();
  await vi.waitFor(() => expect(nativeInstall).toHaveBeenCalledOnce());
  expect(quit).toHaveBeenCalledWith(expect.objectContaining({ quietRestart: true, authorizeAgent: expect.any(Function) }));
  expect(prepareRestart).toHaveBeenCalledWith(expect.objectContaining(caller), expect.objectContaining({ expectedVersion: "1.4.8" }));
  expect(await handler(request({ action: "status" }))).toMatchObject({ data: { operation: { status: "handed_off" } } });
});

it("never installs a different requested version across update-state races (generated)", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("available", "downloading", "downloaded", "no-update", "error"), async (status) => {
    state = status === "error" ? { status, message: "Download failed" } : { status, version: "1.4.9" };
    const handler = createPwrAgentAppManagementHandler({ startedAt: 1, version: () => "1.4.7", authorize: async () => true });
    const flush = deferred();
    expect(await handler(request({ action: "restart", expectedVersion: "1.4.8" }, flush.promise))).toMatchObject({ ok: false });
    expect(nativeInstall).not.toHaveBeenCalled();
  }));
});

it("cancels a scheduled operation by identity before its acknowledgement and permits an explicit retry", async () => {
  state = { status: "downloaded", version: "1.4.8" };
  const handler = createPwrAgentAppManagementHandler({ startedAt: 1, version: () => "1.4.7", authorize: async () => true });
  const flush = deferred();
  const scheduled = await handler(request({ action: "restart", expectedVersion: "1.4.8" }, flush.promise));
  if (!scheduled.ok || !scheduled.data.operation) throw new Error("No scheduled operation");
  expect(await handler(request({ action: "cancel", operationId: scheduled.data.operation.id }))).toMatchObject({ data: { operation: { status: "cancelled" } } });
  flush.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(nativeInstall).not.toHaveBeenCalled();
  await handler(request({ action: "restart", expectedVersion: "1.4.8" }, Promise.resolve()));
  await vi.waitFor(() => expect(nativeInstall).toHaveBeenCalledOnce());
});

it("does not resurrect a cancellation while post-acknowledgement authorization is pending", async () => {
  state = { status: "downloaded", version: "1.4.8" };
  const authorization = deferred();
  let calls = 0;
  const handler = createPwrAgentAppManagementHandler({ startedAt: 1, version: () => "1.4.7", authorize: async () => {
    calls++;
    if (calls === 2) await authorization.promise;
    return true;
  } });
  const flush = deferred();
  const result = await handler(request({ action: "restart", expectedVersion: "1.4.8" }, flush.promise));
  if (!result.ok || !result.data.operation) throw new Error("No operation");
  flush.resolve();
  await vi.waitFor(() => expect(calls).toBe(2));
  expect(await handler(request({ action: "cancel", operationId: result.data.operation.id }))).toMatchObject({ ok: true });
  authorization.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(nativeInstall).not.toHaveBeenCalled();
  expect(await handler(request({ action: "status" }))).toMatchObject({ data: { operation: { status: "cancelled" } } });
});

it("keeps an accepted restart authorized when its initiating turn ends during quieting", async () => {
  state = { status: "downloaded", version: "1.4.8" };
  let active = true;
  const ports = { isActive: () => active, isToolAllowed: () => true, isAgent: async () => true,
    readOrigin: async () => ({ kind: "messaging" as const, causalMessagingSource: { ownerId: "profile", requestId: "owner" } }),
    authorizeActor: async () => true };
  const handler = createPwrAgentAppManagementHandler({ startedAt: 1, version: () => "1.4.7",
    authorize: async (context, phase?: string) => await authorizeAppManagement({ ...ports, allowCompleted: phase === "accepted" }, context) });
  quit.mockImplementation(async (options) => {
    expect(await options.authorizeAgent()).toBe(true);
    expect(options.beforeQuit()).toBe(true);
    active = false; // The Agent finishes after receiving the quiet steer.
    if (!await options.authorizeAgent() || !options.beforeQuit()) return false;
    options.performQuit();
    return true;
  });
  await handler(request({ action: "restart", expectedVersion: "1.4.8" }, Promise.resolve()));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(nativeInstall).toHaveBeenCalledOnce();
  // A fresh request never inherits the accepted operation's authority.
  expect(await handler(request({ action: "status" }))).toMatchObject({ ok: false });
});
