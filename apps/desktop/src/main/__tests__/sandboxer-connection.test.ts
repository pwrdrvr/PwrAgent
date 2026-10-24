import { execFile } from "node:child_process";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxerConnection, SANDBOXER_CLI_PATH } from "../mcp-connections/sandboxer-connection";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  getDefaultEnvironment: () => ({ HOME: "/fixture/home", PATH: "/fixture/bin" }),
  StdioClientTransport: vi.fn(function () {}),
}));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("SandboxerConnection", () => {
  it("uses the absolute CLI and bounded status command, without reading credentials", async () => {
    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
      (callback as (error: null, stdout: string) => void)(null, '{"signedIn":true,"apiReachable":true}');
      return {} as ReturnType<typeof execFile>;
    });
    const connection = new SandboxerConnection();
    expect(await connection.readStatus()).toMatchObject({ configured: true, sandboxerCliState: "signed_in" });
    expect(execFile).toHaveBeenCalledWith(SANDBOXER_CLI_PATH,
      ["status", "--json", "--no-update"],
      expect.objectContaining({ timeout: 8_000, maxBuffer: 256 * 1024 }), expect.any(Function));
    await connection.readStatus();
    expect(execFile).toHaveBeenCalledOnce();
    await connection.readStatus(true);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("distinguishes missing CLI, login, malformed output and API failure", async () => {
    const missing = new SandboxerConnection(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
    expect(await missing.readStatus()).toMatchObject({ configured: false, sandboxerCliState: "cli_missing", detail: expect.stringContaining("Install") });
    const signedOut = new SandboxerConnection(async () => '{"signedIn":false}');
    expect(await signedOut.readStatus()).toMatchObject({ configured: false, sandboxerCliState: "not_signed_in", detail: expect.stringContaining("/usr/local/bin/sbx onboard") });
    for (const output of ["invalid", "{}", '{"signedIn":true,"apiReachable":false}']) {
      expect(await new SandboxerConnection(async () => output).readStatus()).toMatchObject({ configured: false, sandboxerCliState: "unavailable" });
    }
  });

  it("keeps a signed-in account that can't start a machine out of threads", async () => {
    const status = (plan: Record<string, unknown>) => JSON.stringify({
      signedIn: true, apiReachable: true,
      user: { email: "operator@example.com" }, plan,
    });
    for (const [plan, sandboxerCliState] of [
      [{ canStart: false, dollars: 0, billingStatus: "none" }, "no_plan"],
      [{ canStart: false, billingStatus: "inactive" }, "no_plan"],
      [{ canStart: false, dollars: 20, billingStatus: "past_due", creditBalanceHours: 4 }, "billing_issue"],
      [{ canStart: false, dollars: 20, billingStatus: "active", creditBalanceHours: 0 }, "out_of_credit"],
      [{ canStart: false, dollars: 20, billingStatus: "trialing", creditBalanceHours: 0 }, "out_of_credit"],
      [{ canStart: false, dollars: 20, billingStatus: "active", creditBalanceHours: 3 }, "cannot_start"],
    ] as const) {
      const read = await new SandboxerConnection(async () => status(plan)).readStatus();
      expect(read).toMatchObject({ configured: false, state: "disconnected", sandboxerCliState });
      expect(read.detail).not.toContain("operator@example.com");
    }
    expect((await new SandboxerConnection(async () => status({ canStart: false, dollars: 0 })).readStatus()).detail)
      .toContain("/usr/local/bin/sbx onboard");
  });

  it("reports the billed account, and treats a status without a plan as able to start", async () => {
    const able = await new SandboxerConnection(async () => JSON.stringify({
      signedIn: true, apiReachable: true, user: { email: "operator@example.com" },
      plan: { canStart: true, dollars: 20, billingStatus: "active", creditBalanceHours: 21.4 },
    })).readStatus();
    expect(able).toMatchObject({
      configured: true, sandboxerCliState: "signed_in",
      sandboxerAccount: { email: "operator@example.com", planDollars: 20, creditBalanceHours: 21.4 },
    });
    // Older CLIs print no plan; that must not block a working login.
    const older = await new SandboxerConnection(async () => '{"signedIn":true,"apiReachable":true}').readStatus();
    expect(older).toMatchObject({ configured: true, sandboxerCliState: "signed_in" });
    expect(older).not.toHaveProperty("sandboxerAccount");
  });

  it("opens only fixed Sandboxer pages and a dashboard link on the Sandboxer origin", async () => {
    const openExternal = vi.fn(async () => undefined);
    const dashboard = vi.fn(async () => '{"ok":true,"type":"cli.dashboard","url":"https://sandboxer.com/auth/link?code=fixture"}');
    const connection = new SandboxerConnection(async () => "{}", { dashboardCommand: dashboard, openExternal });
    expect(await connection.openLink("pricing")).toEqual({ opened: true });
    expect(openExternal).toHaveBeenLastCalledWith("https://sandboxer.com/pricing");
    expect(await connection.openLink("quickstart")).toEqual({ opened: true });
    expect(openExternal).toHaveBeenLastCalledWith("https://sandboxer.com/docs/quickstart");
    expect(await connection.openLink("dashboard")).toEqual({ opened: true });
    expect(openExternal).toHaveBeenLastCalledWith("https://sandboxer.com/auth/link?code=fixture");
    expect(openExternal).toHaveBeenCalledTimes(3);

    for (const url of ["https://sandboxer.com.example.net/auth", "http://sandboxer.com/auth", "file:///etc/passwd", 7]) {
      dashboard.mockResolvedValueOnce(JSON.stringify({ ok: true, url }));
      expect(await connection.openLink("dashboard")).toMatchObject({ opened: false });
    }
    dashboard.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    expect(await connection.openLink("dashboard")).toMatchObject({ opened: false, error: expect.stringContaining("CLI missing") });
    expect(openExternal).toHaveBeenCalledTimes(3);
  });

  it("asks the CLI for a dashboard link without letting it open a browser", async () => {
    vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
      (callback as (error: null, stdout: string) => void)(null, '{"ok":true,"url":"https://sandboxer.com/auth/link"}');
      return {} as ReturnType<typeof execFile>;
    });
    await new SandboxerConnection(undefined, { openExternal: async () => undefined }).openLink("dashboard");
    expect(execFile).toHaveBeenCalledWith(SANDBOXER_CLI_PATH,
      ["dashboard", "--no-open", "--json", "--no-update"],
      expect.objectContaining({ timeout: 8_000 }), expect.any(Function));
  });

  it("coalesces concurrent status reads and refreshes after login", async () => {
    let complete!: (value: string) => void;
    const run = vi.fn(() => new Promise<string>((resolve) => { complete = resolve; }));
    const connection = new SandboxerConnection(run);
    const first = connection.readStatus();
    const second = connection.readStatus();
    complete('{"signedIn":false}');
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledOnce();
    run.mockResolvedValue('{"signedIn":true}');
    expect((await connection.readStatus(true)).configured).toBe(true);
  });

  it("spawns only official MCP with finite small defaults and a limited environment", () => {
    vi.stubEnv("SANDBOXER_API_KEY", "fixture-key");
    vi.stubEnv("SANDBOXER_ORG", "fixture-org");
    vi.stubEnv("UNRELATED_SECRET", "must-not-inherit");
    new SandboxerConnection().createTransport();
    expect(StdioClientTransport).toHaveBeenCalledWith({
      command: "/usr/local/bin/sbx",
      args: ["mcp", "--type", "small", "--ttl", "1800", "--no-update"],
      env: expect.objectContaining({ HOME: "/fixture/home", SANDBOXER_API_KEY: "fixture-key", SANDBOXER_ORG: "fixture-org" }),
      stderr: "ignore",
    });
    const params = vi.mocked(StdioClientTransport).mock.calls[0]![0];
    expect(params.env).not.toHaveProperty("UNRELATED_SECRET");
  });
});
