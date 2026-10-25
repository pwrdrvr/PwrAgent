import { describe, expect, it } from "vitest";
import {
  formatMcpCommandLine,
  mcpConnectionsForPeer,
  resolveMcpConnectionSetup,
  splitMcpCommandLine,
  type McpConnectionStatus,
} from "../contracts/mcp-connections";
import { describeMcpConnectionAuth } from "../mcp-auth-status";

function localCommand(overrides: Partial<McpConnectionStatus> = {}): McpConnectionStatus {
  return {
    id: "project-files",
    displayName: "Project files",
    serverUrl: "stdio:project-files",
    authMode: "none",
    kind: "stdio",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    configured: true,
    state: "ready",
    stdio: {
      command: "/opt/fixture/bin/npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/example/My Projects"],
      cwd: "/home/example",
      env: [
        { name: "FIXTURE_ROOT", secret: false, value: "/home/example" },
        { name: "FIXTURE_TOKEN", secret: true },
      ],
    },
    ...overrides,
  };
}

describe("splitMcpCommandLine", () => {
  it("splits on whitespace and keeps quoted text whole", () => {
    expect(splitMcpCommandLine(`npx -y  @scope/server "My Projects" 'a b'`)).toEqual([
      "npx", "-y", "@scope/server", "My Projects", "a b",
    ]);
    expect(splitMcpCommandLine(`run --flag="x y" ''`)).toEqual(["run", "--flag=x y", ""]);
  });

  it("is not a shell: nothing expands and operators are plain text", () => {
    expect(splitMcpCommandLine("server ~/data $HOME *.json && rm")).toEqual([
      "server", "~/data", "$HOME", "*.json", "&&", "rm",
    ]);
  });

  it("escapes only before a space, a quote or a backslash, so Windows paths survive", () => {
    expect(splitMcpCommandLine(String.raw`C:\Tools\server.exe My\ Folder "say \"hi\""`)).toEqual([
      String.raw`C:\Tools\server.exe`, "My Folder", `say "hi"`,
    ]);
  });

  it("refuses an unterminated quote rather than guessing", () => {
    expect(splitMcpCommandLine(`npx "unfinished`)).toBeUndefined();
    expect(splitMcpCommandLine("   ")).toEqual([]);
  });
});

describe("formatMcpCommandLine", () => {
  it("quotes only what a shell would split, and round-trips through the splitter", () => {
    const launch = { command: "/opt/bin/npx", args: ["-y", "My Projects", "it's", "a=b"] };
    const line = formatMcpCommandLine(launch);
    expect(line).toBe(`/opt/bin/npx -y 'My Projects' 'it'\\''s' a=b`);
    expect(splitMcpCommandLine(line)).toEqual([launch.command, ...launch.args]);
  });
});

describe("local command setup and auth", () => {
  it("is ready without a sign-in, parked when withheld, and warns about an unreadable secret", () => {
    expect(resolveMcpConnectionSetup({ connection: localCommand(), gatewayEnabled: true }))
      .toMatchObject({ state: "ready", headline: "Ready", offersAvailabilitySwitch: true });
    expect(resolveMcpConnectionSetup({ connection: localCommand({ enabled: false }), gatewayEnabled: true }))
      .toMatchObject({ state: "parked" });
    expect(resolveMcpConnectionSetup({
      connection: localCommand({ configured: false, detail: "PwrAgent could not read FIXTURE_TOKEN." }),
      gatewayEnabled: true,
    })).toMatchObject({ headline: "Secret missing", detail: "PwrAgent could not read FIXTURE_TOKEN." });
    expect(resolveMcpConnectionSetup({ connection: localCommand(), gatewayEnabled: false }))
      .toMatchObject({ state: "gateway_off" });
  });

  it("describes itself as a local command, with nothing to sign in to", () => {
    expect(describeMcpConnectionAuth(localCommand())).toMatchObject({
      label: "Local command",
      canSignIn: false,
    });
    expect(describeMcpConnectionAuth(localCommand({ configured: false }))).toMatchObject({
      label: "Secret missing",
      canSignIn: false,
    });
  });
});

describe("mcpConnectionsForPeer", () => {
  it("never sends a peer the launch or the server's output", () => {
    const [peer] = mcpConnectionsForPeer([localCommand({
      discovery: {
        state: "failed",
        lastFailure: { at: 2, message: "It exited.", output: "/home/example/secret-path: denied" },
      },
    })]);
    expect(peer).not.toHaveProperty("stdio");
    expect(peer?.discovery?.lastFailure).toEqual({ at: 2, message: "It exited." });
    expect(JSON.stringify(peer)).not.toContain("/home/example");
  });
});
