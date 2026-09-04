import { beforeEach, describe, expect, it, vi } from "vitest";
import { PwrGitConnectionService } from "../mcp-connections/pwrgit-connection-service";

type Stored = { value?: string };

function settingsStub(stored: Stored) {
  return {
    resolvePwrGitMcpCredential: vi.fn(async () => stored.value),
    savePwrGitMcpCredential: vi.fn(async (value: string) => {
      stored.value = value;
    }),
    clearPwrGitMcpCredential: vi.fn(async () => {
      stored.value = undefined;
    }),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function service(options: {
  stored?: Stored;
  fetchFn: (input: string | URL, init?: RequestInit) => Promise<Response>;
  installed?: boolean;
}) {
  const stored = options.stored ?? {};
  const settings = settingsStub(stored);
  const instance = new PwrGitConnectionService({
    fetchFn: options.fetchFn,
    settings,
    resolveInstallPaths: () =>
      options.installed === false ? [] : ["/Applications/PwrGit.app"],
    // Never consult the real filesystem: whether PwrGit is installed on the
    // machine running the suite must not decide what these tests assert.
    exists: () => options.installed !== false,
    resolveBundledScript: () => "/Applications/PwrGit.app/Contents/Resources/pwrgit-mcp.mjs",
    resolveExecutable: () => "/Applications/PwrGit.app/Contents/MacOS/PwrGit",
    sleep: async () => undefined,
  });
  return { instance, settings, stored };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("PwrGitConnectionService status", () => {
  it("reports not_installed when nothing answers and nothing is installed", async () => {
    const { instance } = service({
      installed: false,
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(instance.readStatus()).resolves.toMatchObject({
      availability: "not_installed",
      configured: false,
    });
  });

  it("separates 'agent access is off' from 'not running'", async () => {
    const { instance } = service({
      fetchFn: async () => json({ agentAccess: false }),
    });
    const status = await instance.readStatus();
    expect(status.availability).toBe("running");
    expect(status.agentAccessDisabled).toBe(true);
    expect(status.detail).toMatch(/Local agent access/u);
  });

  it("reports running and configured once a credential is stored", async () => {
    const { instance } = service({
      stored: {
        value: JSON.stringify({
          token: "pgmcp_abc",
          scriptPath: "/res/pwrgit-mcp.mjs",
          execPath: "/bin/PwrGit",
        }),
      },
      fetchFn: async () => json({ agentAccess: true }),
    });
    await expect(instance.readStatus()).resolves.toMatchObject({
      availability: "running",
      configured: true,
    });
  });
});

describe("PwrGitConnectionService pairing", () => {
  it("stores the credential only after PwrGit approves", async () => {
    let polls = 0;
    const { instance, stored, settings } = service({
      fetchFn: async (input) => {
        const url = String(input);
        if (url.endsWith("/health")) return json({ agentAccess: true });
        if (url.endsWith("/pair/request")) {
          return json({ pairingId: "pair_1", pollIntervalMs: 1 });
        }
        polls += 1;
        return polls < 2
          ? json({ status: "pending" })
          : json({
              status: "approved",
              token: "pgmcp_granted",
              policyFile: "/policy.json",
            });
      },
    });

    const response = await instance.connect();

    expect(response.outcome).toBe("connected");
    expect(settings.savePwrGitMcpCredential).toHaveBeenCalledOnce();
    expect(JSON.parse(stored.value ?? "{}")).toMatchObject({
      token: "pgmcp_granted",
      policyFile: "/policy.json",
    });
  });

  it("stores nothing when the operator declines", async () => {
    const { instance, settings } = service({
      fetchFn: async (input) => {
        const url = String(input);
        if (url.endsWith("/health")) return json({ agentAccess: true });
        if (url.endsWith("/pair/request")) {
          return json({ pairingId: "pair_1", pollIntervalMs: 1 });
        }
        return json({ status: "denied", reason: "Not this time." });
      },
    });

    const response = await instance.connect();

    expect(response.outcome).toBe("declined");
    expect(response.detail).toBe("Not this time.");
    expect(settings.savePwrGitMcpCredential).not.toHaveBeenCalled();
  });

  it("does not request pairing while agent access is off", async () => {
    const requests: string[] = [];
    const { instance } = service({
      fetchFn: async (input) => {
        requests.push(String(input));
        return json({ agentAccess: false });
      },
    });

    const response = await instance.connect();

    expect(response.outcome).toBe("needs_local_agent_access");
    // A pairing that nothing can answer would just sit there until it expired.
    expect(requests.some((url) => url.includes("/pair/request"))).toBe(false);
  });

  it("serializes concurrent connects into one approval prompt", async () => {
    let pairRequests = 0;
    const { instance } = service({
      fetchFn: async (input) => {
        const url = String(input);
        if (url.endsWith("/health")) return json({ agentAccess: true });
        if (url.endsWith("/pair/request")) {
          pairRequests += 1;
          return json({ pairingId: "pair_1", pollIntervalMs: 1 });
        }
        return json({ status: "approved", token: "pgmcp_x" });
      },
    });

    await Promise.all([instance.connect(), instance.connect()]);

    expect(pairRequests).toBe(1);
  });
});

describe("PwrGitConnectionService registration", () => {
  it("launches the bundled server directly with the stored token", async () => {
    const { instance } = service({
      stored: {
        value: JSON.stringify({
          token: "pgmcp_abc",
          policyFile: "/policy.json",
          scriptPath: "/res/pwrgit-mcp.mjs",
          execPath: "/bin/PwrGit",
        }),
      },
      fetchFn: async () => json({ agentAccess: true }),
    });

    const registration = await instance.registerBridge("pwrgit");

    expect(registration.server).toEqual({
      name: "pwrgit",
      command: "/bin/PwrGit",
      args: ["/res/pwrgit-mcp.mjs", "serve"],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        PWRGIT_MCP_SESSION_TOKEN: "pgmcp_abc",
        PWRGIT_MCP_POLICY_FILE: "/policy.json",
      },
    });
  });

  it("refuses to register before the operator has connected", async () => {
    const { instance } = service({
      fetchFn: async () => json({ agentAccess: true }),
    });
    await expect(instance.registerBridge("pwrgit")).rejects.toThrow(
      /not connected/u,
    );
  });
});
