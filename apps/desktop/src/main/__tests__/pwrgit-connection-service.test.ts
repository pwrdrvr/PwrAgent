import { beforeEach, describe, expect, it, vi } from "vitest";
import { PwrGitConnectionService } from "../mcp-connections/pwrgit-connection-service";

type Stored = { value?: string };

/** What PwrGit's /health answers while Local agent access is on. */
const HEALTHY = {
  protocol: "pwrgit.agent-access/v1",
  app: "PwrGit",
  version: "0.12.0",
  agentAccess: true,
  mcpUrl: "http://127.0.0.1:51731/mcp",
};
const INSTALL_PATH = "/Applications/PwrGit.app";
const SCRIPT_PATH = `${INSTALL_PATH}/Contents/Resources/pwrgit-mcp.mjs`;

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

function credential(value: Record<string, unknown>): Stored {
  return { value: JSON.stringify(value) };
}

function service(options: {
  stored?: Stored;
  fetchFn: (input: string | URL, init?: RequestInit) => Promise<Response>;
  installed?: boolean;
  bundled?: boolean;
}) {
  const stored = options.stored ?? {};
  const settings = settingsStub(stored);
  const sleeps: number[] = [];
  // Virtual time: `sleep` is the only thing that advances `now`, so a
  // five-minute deadline costs nothing to reach.
  let clock = 0;
  const instance = new PwrGitConnectionService({
    fetchFn: options.fetchFn,
    settings,
    resolveInstallPaths: () => [INSTALL_PATH],
    // Never consult the real filesystem: whether PwrGit is installed on the
    // machine running the suite must not decide what these tests assert.
    exists: () => options.installed !== false,
    resolveBundledScript: () =>
      options.bundled === false ? undefined : SCRIPT_PATH,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { instance, settings, stored, sleeps };
}

/** A PwrGit that approves on the given poll, with the given ticket. */
function approving(options: {
  approveOnPoll?: number;
  ticket?: Record<string, unknown>;
  pollFailures?: number;
}) {
  let polls = 0;
  let pairRequests = 0;
  const fetchFn = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/health")) return json(HEALTHY);
    if (url.endsWith("/pair/request")) {
      pairRequests += 1;
      return json(options.ticket ?? { pairingId: "pair_1", pollIntervalMs: 1 });
    }
    polls += 1;
    if (polls <= (options.pollFailures ?? 0)) {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    return polls < (options.approveOnPoll ?? 1)
      ? json({ status: "pending" })
      : json({
          status: "approved",
          token: "pgmcp_granted",
          policyFile: "/policy.json",
          mcpUrl: HEALTHY.mcpUrl,
          session: { id: "s1", name: "PwrAgent", roleId: "builtin.live-status" },
        });
  };
  return { fetchFn, pairRequests: () => pairRequests, polls: () => polls };
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

  it("names the switch when PwrGit is installed but not listening", async () => {
    // PwrGit only listens while Local agent access is on, so a closed port
    // on an installed machine is the state where the switch matters.
    const { instance } = service({
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const status = await instance.readStatus();
    expect(status.availability).toBe("installed");
    expect(status.configured).toBe(false);
    expect(status.detail).toMatch(/Local agent access/u);
  });

  it("stops nagging about the switch once paired, since the server runs without the app", async () => {
    const { instance } = service({
      stored: credential({ token: "pgmcp_abc" }),
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(instance.readStatus()).resolves.toEqual({
      connectionId: "pwrgit",
      displayName: "PwrGit",
      availability: "installed",
      configured: true,
    });
  });

  it("separates 'agent access is off' from 'not running'", async () => {
    const { instance } = service({
      fetchFn: async () => json({ ...HEALTHY, agentAccess: false }),
    });
    const status = await instance.readStatus();
    expect(status.availability).toBe("running");
    expect(status.detail).toMatch(/Local agent access/u);
  });

  it("does not mistake another process on the port for PwrGit", async () => {
    const { instance } = service({
      installed: false,
      fetchFn: async () => json({ ok: true }),
    });
    await expect(instance.readStatus()).resolves.toMatchObject({
      availability: "not_installed",
    });
  });

  it("reports running and configured once a credential is stored", async () => {
    const { instance } = service({
      stored: credential({ token: "pgmcp_abc" }),
      fetchFn: async () => json(HEALTHY),
    });
    await expect(instance.readStatus()).resolves.toMatchObject({
      availability: "running",
      configured: true,
    });
  });
});

describe("PwrGitConnectionService pairing", () => {
  it("stores only the token and policy file once PwrGit approves", async () => {
    const pwrGit = approving({ approveOnPoll: 2 });
    const { instance, stored, settings } = service({ fetchFn: pwrGit.fetchFn });

    const response = await instance.connect();

    expect(response.outcome).toBe("connected");
    expect(settings.savePwrGitMcpCredential).toHaveBeenCalledOnce();
    // No install paths: those are resolved at every launch instead.
    expect(JSON.parse(stored.value ?? "{}")).toEqual({
      token: "pgmcp_granted",
      policyFile: "/policy.json",
    });
  });

  it("stores nothing when the operator declines", async () => {
    const { instance, settings } = service({
      fetchFn: async (input) => {
        const url = String(input);
        if (url.endsWith("/health")) return json(HEALTHY);
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
        return json({ ...HEALTHY, agentAccess: false });
      },
    });

    const response = await instance.connect();

    expect(response.outcome).toBe("needs_local_agent_access");
    // The status already names the switch; a second copy would stack.
    expect(response.detail).toBeUndefined();
    expect(response.status.detail).toMatch(/Local agent access/u);
    // A pairing that nothing can answer would just sit there until it expired.
    expect(requests.some((url) => url.includes("/pair/request"))).toBe(false);
  });

  it("serializes concurrent connects into one approval prompt", async () => {
    const pwrGit = approving({});
    const { instance } = service({ fetchFn: pwrGit.fetchFn });

    await Promise.all([instance.connect(), instance.connect()]);

    expect(pwrGit.pairRequests()).toBe(1);
  });

  it("reports a running PwrGit whose MCP server cannot be found without pairing", async () => {
    const pwrGit = approving({});
    const { instance, settings } = service({ fetchFn: pwrGit.fetchFn, bundled: false });

    const response = await instance.connect();

    expect(response.outcome).toBe("unavailable");
    expect(response.detail).toMatch(/could not find its MCP server/u);
    expect(pwrGit.pairRequests()).toBe(0);
    expect(settings.savePwrGitMcpCredential).not.toHaveBeenCalled();
  });

  it("reports a dropped pairing request instead of throwing", async () => {
    const { instance } = service({
      fetchFn: async (input) => {
        if (String(input).endsWith("/health")) return json(HEALTHY);
        throw new TypeError("fetch failed");
      },
    });

    const response = await instance.connect();

    expect(response.outcome).toBe("unavailable");
    expect(response.detail).toMatch(/stopped answering.*fetch failed/u);
  });

  it("keeps polling through a transient poll failure", async () => {
    // One slow poll must not abandon a pairing the operator is looking at:
    // PwrGit still hands the token out on the next one.
    const pwrGit = approving({ pollFailures: 1, approveOnPoll: 2 });
    const { instance, stored } = service({ fetchFn: pwrGit.fetchFn });

    const response = await instance.connect();

    expect(response.outcome).toBe("connected");
    expect(pwrGit.pairRequests()).toBe(1);
    expect(JSON.parse(stored.value ?? "{}").token).toBe("pgmcp_granted");
  });

  it.each([
    ["a zero interval", 0, 250],
    ["a non-numeric interval", "fast", 1_000],
    ["an hour-long interval", 3_600_000, 5_000],
  ])("clamps %s from the pairing ticket", async (_label, pollIntervalMs, expected) => {
    const pwrGit = approving({ ticket: { pairingId: "pair_1", pollIntervalMs } });
    const { instance, sleeps } = service({ fetchFn: pwrGit.fetchFn });

    await instance.connect();

    expect(sleeps[0]).toBe(expected);
  });

  it("waits out PwrGit's own five-minute window before giving up", async () => {
    // PwrGit mints the session the moment the operator approves, so giving up
    // earlier than PwrGit's pairing TTL would strand that session.
    const { instance, sleeps } = service({
      fetchFn: async (input) => {
        const url = String(input);
        if (url.endsWith("/health")) return json(HEALTHY);
        if (url.endsWith("/pair/request")) {
          return json({ pairingId: "pair_1", pollIntervalMs: 60_000 });
        }
        return json({ status: "pending" });
      },
    });

    const response = await instance.connect();

    expect(response.outcome).toBe("timed_out");
    expect(sleeps.reduce((total, ms) => total + ms, 0)).toBe(5 * 60_000);
    expect(Math.max(...sleeps)).toBe(5_000);
  });

  it("ends the pairing when PwrGit reports it expired", async () => {
    const { instance } = service({
      fetchFn: async (input) => {
        const url = String(input);
        if (url.endsWith("/health")) return json(HEALTHY);
        if (url.endsWith("/pair/request")) {
          return json({ pairingId: "pair_1", pollIntervalMs: 1 });
        }
        return json({ status: "expired" });
      },
    });

    const response = await instance.connect();

    expect(response.outcome).toBe("timed_out");
    expect(response.detail).toMatch(/expired/u);
  });

  it("tells the operator what to clean up when the approved token cannot be stored", async () => {
    // PwrGit hands the token out exactly once and has already recorded the
    // session, so a failed save is not silently retryable.
    const pwrGit = approving({});
    const { instance, settings } = service({ fetchFn: pwrGit.fetchFn });
    settings.savePwrGitMcpCredential.mockRejectedValueOnce(
      new Error("Keychain access denied"),
    );

    const response = await instance.connect();

    expect(response.outcome).toBe("unavailable");
    expect(response.detail).toMatch(/Keychain access denied/u);
    expect(response.detail).toMatch(/Revoke the PwrAgent session/u);
  });
});

describe("PwrGitConnectionService registration", () => {
  it("launches the bundled server under PwrAgent's own runtime", async () => {
    // Never PwrGit's binary: its runAsNode fuse is off, so ELECTRON_RUN_AS_NODE
    // against it would open the PwrGit window instead of a Node process.
    const { instance } = service({
      stored: credential({ token: "pgmcp_abc", policyFile: "/policy.json" }),
      fetchFn: async () => json(HEALTHY),
    });

    const registration = await instance.registerBridge("pwrgit");

    expect(registration?.server).toEqual({
      name: "pwrgit",
      command: process.execPath,
      args: [SCRIPT_PATH, "serve"],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        PWRGIT_MCP_SESSION_TOKEN: "pgmcp_abc",
        PWRGIT_MCP_POLICY_FILE: "/policy.json",
      },
    });
  });

  it("resolves the launch from the current install, not from the credential", async () => {
    // A credential written by an older build that stored paths is still
    // usable, and a PwrGit that moved since pairing is found where it is now.
    const { instance } = service({
      stored: credential({
        token: "pgmcp_abc",
        scriptPath: "/old/location/pwrgit-mcp.mjs",
        execPath: "/old/location/PwrGit",
      }),
      fetchFn: async () => json(HEALTHY),
    });

    const registration = await instance.registerBridge("pwrgit");

    expect(registration?.server.command).toBe(process.execPath);
    expect(registration?.server.args).toEqual([SCRIPT_PATH, "serve"]);
  });

  it("registers nothing before the operator has connected", async () => {
    // A thread that enabled PwrGit must keep starting turns without it,
    // as PwrSnap's registration does after a revoked session.
    const { instance } = service({
      fetchFn: async () => json(HEALTHY),
    });
    await expect(instance.registerBridge("pwrgit")).resolves.toBeUndefined();
  });

  it("registers nothing when PwrGit is no longer installed", async () => {
    const { instance } = service({
      stored: credential({ token: "pgmcp_abc" }),
      installed: false,
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(instance.registerBridge("pwrgit")).resolves.toBeUndefined();
  });
});
