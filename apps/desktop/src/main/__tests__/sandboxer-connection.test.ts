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
    expect(await signedOut.readStatus()).toMatchObject({ configured: false, sandboxerCliState: "not_signed_in", detail: expect.stringContaining("/usr/local/bin/sbx login") });
    for (const output of ["invalid", "{}", '{"signedIn":true,"apiReachable":false}']) {
      expect(await new SandboxerConnection(async () => output).readStatus()).toMatchObject({ configured: false, sandboxerCliState: "unavailable" });
    }
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
