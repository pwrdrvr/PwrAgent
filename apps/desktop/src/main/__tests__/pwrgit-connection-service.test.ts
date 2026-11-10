import { sandboxerStub } from "./helpers/sandboxer-stub";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PwrGitConnectionService } from "../mcp-connections/pwrgit-connection-service";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import { pwrSuiteInstall, removePwrSuiteInstalls } from "./helpers/pwrsuite-install-fixture";

const services: McpConnectionGatewayService[] = [];
const directories: string[] = [];
const gateways = new Map<PwrGitConnectionService, McpConnectionGatewayService>();

function settings(initial?: string) {
  let value = initial;
  let shared: string | undefined;
  return {
    resolveMcpConnectionCredentials: vi.fn(async () => shared),
    saveMcpConnectionCredentials: vi.fn(async (next: string) => { shared = next; }),
    clearMcpConnectionCredentials: vi.fn(async () => { shared = undefined; }),
    resolvePwrSnapMcpCredential: vi.fn(async () => undefined),
    savePwrSnapMcpCredential: vi.fn(async () => undefined),
    clearPwrSnapMcpCredential: vi.fn(async () => undefined),
    resolvePwrGitMcpCredential: vi.fn(async () => value),
    savePwrGitMcpCredential: vi.fn(async (next: string) => { value = next; }),
    clearPwrGitMcpCredential: vi.fn(async () => { value = undefined; }),
  };
}

function pwrGitInstall(options: { relay?: boolean } = {}): string {
  return pwrSuiteInstall("pwrgit", options);
}

function create(options: {
  installs?: () => string[];
  listening?: () => boolean;
  settings?: ReturnType<typeof settings>;
  gatewayEnabled?: () => boolean;
  openPath?: (path: string) => Promise<string>;
  fetchFn?: typeof fetch;
  openExternal?: (url: string) => Promise<void>;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-gateway-test-"));
  directories.push(directory);
  const installs = options.installs ?? (() => [pwrGitInstallDefault]);
  const gateway = new McpConnectionGatewayService({
    sandboxer: sandboxerStub(),
    settings: options.settings ?? settings(),
    fetchFn: options.fetchFn ?? (async () => { throw new Error("PwrGit has no network endpoint."); }),
    openExternal: options.openExternal,
    leaseManager: null,
    registry: new McpConnectionRegistry({ configPath: join(directory, "config.toml") }),
    gatewayEnabled: options.gatewayEnabled ?? (() => true),
    resolvePwrGitInstallPaths: installs,
  });
  const service = new PwrGitConnectionService({
    gateway,
    resolveInstallPaths: installs,
    isListening: async () => options.listening?.() ?? true,
    ...(options.openPath ? { openPath: options.openPath } : {}),
  });
  services.push(gateway);
  gateways.set(service, gateway);
  return service;
}

let pwrGitInstallDefault = "";

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  removePwrSuiteInstalls();
  gateways.clear();
});

describe("PwrGit local relay connection", () => {
  it("reads PwrGit's install, relay, and listener as three separate facts", async () => {
    const withRelay = pwrGitInstall();
    const withoutRelay = pwrGitInstall({ relay: false });
    const fetchFn = vi.fn(async () => { throw new Error("PwrGit has no network endpoint."); });
    const status = async (installs: string[], listening: boolean) =>
      await create({ installs: () => installs, listening: () => listening, fetchFn }).readStatus();

    await expect(status([], false)).resolves.toEqual({
      connectionId: "pwrgit", displayName: "PwrGit", availability: "not_installed", configured: false,
    });
    await expect(status([withoutRelay], false)).resolves.toMatchObject({
      availability: "installed", configured: false, detail: expect.stringContaining("0.56.0"),
    });
    await expect(status([withRelay], false)).resolves.toMatchObject({
      availability: "installed", configured: true, detail: expect.stringContaining("Local Agent Access"),
    });
    const running = await status([withRelay], true);
    expect(running).toMatchObject({ availability: "running", configured: true });
    expect(running.detail).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("connects only while PwrGit listens, never launches it, and drops a pre-IPC OAuth token", async () => {
    let installs = [pwrGitInstall({ relay: false })];
    let listening = false;
    const openPath = vi.fn(async () => "");
    const openExternal = vi.fn(async () => undefined);
    const store = settings(JSON.stringify({ tokens: { access_token: "legacy-oauth", token_type: "bearer" } }));
    const service = create({
      installs: () => installs, listening: () => listening, settings: store, openPath, openExternal,
    });

    await expect(service.connect()).resolves.toMatchObject({
      outcome: "needs_update", status: { availability: "installed", configured: false },
    });
    installs = [pwrGitInstall()];
    await expect(service.connect()).resolves.toMatchObject({
      outcome: "needs_local_agent_access", status: { availability: "installed", configured: true },
    });
    listening = true;
    await expect(service.connect()).resolves.toMatchObject({
      outcome: "connected", status: { availability: "running", configured: true },
    });
    expect(await store.resolvePwrGitMcpCredential()).toBeUndefined();
    expect(openPath).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("issues reusable, revocable thread grants that name no PwrGit executable", async () => {
    pwrGitInstallDefault = pwrGitInstall();
    const service = create();
    const first = await service.registerBridge("pwrgit", "grok-thread");
    const second = await service.registerBridge("pwrgit", "grok-thread");
    expect(second.server).toEqual(first.server);
    expect(first.server.name).toBe("pwrgit");
    expect(first.server.env.PWRAGENT_MCP_CONNECTION_TOKEN).toBeTruthy();
    // The agent gets PwrAgent's bridge; only the gateway starts the relay.
    expect(JSON.stringify(first.server)).not.toContain("pwrgit-mcp");
    first.revoke();
    expect((await service.registerBridge("pwrgit", "grok-thread")).server).not.toEqual(first.server);
  });

  it("enforces global and connection switches, and keeps the relay configured through a disconnect", async () => {
    pwrGitInstallDefault = pwrGitInstall();
    let enabled = true;
    const service = create({ gatewayEnabled: () => enabled });
    const gateway = gateways.get(service)!;
    await service.registerBridge("pwrgit", "one");
    enabled = false;
    await expect(service.registerBridge("pwrgit", "two")).rejects.toThrow();
    enabled = true;
    await gateway.setConnectionEnabled("pwrgit", false);
    await expect(service.registerBridge("pwrgit", "two")).rejects.toThrow();
    await expect(service.readStatus()).resolves.toMatchObject({ configured: true });
    await gateway.setConnectionEnabled("pwrgit", true);
    await expect(service.registerBridge("pwrgit", "two")).resolves.toBeDefined();
    // There is no credential to discard: PwrGit approves each session.
    await gateway.disconnectConnection("pwrgit");
    await expect(service.readStatus()).resolves.toMatchObject({ configured: true });
    await expect(gateway.removeConnection("pwrgit")).rejects.toThrow("Built-in");
  });
});
