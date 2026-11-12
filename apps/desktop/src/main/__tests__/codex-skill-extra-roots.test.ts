import { describe, expect, it, vi } from "vitest";
import { StdioJsonRpcTransport } from "@pwrdrvr/agent-transport";
import { CodexAppServerClient, type CodexClientOptions } from "@pwragent/owner-core/codex-app-server/client";

// A real stdio peer. `FAIL_EXTRA_ROOTS` makes it answer the way a Codex
// without `skills/extraRoots/set` does.
const server = `
  const failExtraRoots = process.env.FAIL_EXTRA_ROOTS === "1";
  require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
    const { id, method } = JSON.parse(line);
    if (id === undefined) return;
    if (method === "skills/extraRoots/set" && failExtraRoots) {
      process.stdout.write(JSON.stringify({ id, error: { code: -32601, message: "method not found" } }) + "\\n");
      return;
    }
    const result = method === "initialize" ? { userAgent: "fixture/0.164.0", codexHome: "/fixture", platformFamily: "unix", platformOs: "linux" }
      : method === "skills/extraRoots/set" ? {}
      : { data: [], nextCursor: null };
    process.stdout.write(JSON.stringify({ id, result }) + "\\n");
  });
`;

function connect(options: CodexClientOptions, env: NodeJS.ProcessEnv = {}) {
  const sent: { method: string; params: unknown }[] = [];
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const client = new CodexAppServerClient({
    ...options,
    connectionObserver: { onMessage: (event) => {
      if (event.direction === "outbound" && event.envelope.method) {
        sent.push({ method: event.envelope.method, params: event.envelope.params });
      }
    } },
  }, {
    createTransport: () => new StdioJsonRpcTransport({
      command: process.execPath, args: ["-e", server], env: { ...process.env, ...env }, logger: log,
    }),
    clientInfo: { name: "fixture", title: "Fixture" }, logger: log, rpcLogger: log,
    listingDiagnostics: { trace: async (_stage, _fields, operation) => await operation(), link: () => {} },
    authState: { isBlocked: () => false, assertAvailable: () => {} },
    signInRequiredMessage: "fixture", buildShellEnvironment: (shellEnv) => shellEnv,
    enrichThreadDirectory: async () => ({ linkedDirectories: [] }),
    sampleAppServerProcessTree: async () => ({}),
  });
  return { client, sent, log };
}

describe("Codex skill extra roots", () => {
  it("registers the host's skill roots right after the handshake, before any other request", async () => {
    const { client, sent } = connect({ resolveSkillExtraRoots: async () => ["/fixture/skills/bundled"] });
    try {
      await client.listThreads({ enrichDirectories: false });
      expect(sent.map((entry) => entry.method).slice(0, 4)).toEqual([
        "initialize", "initialized", "skills/extraRoots/set", "thread/list",
      ]);
      expect(sent[2].params).toEqual({ extraRoots: ["/fixture/skills/bundled"] });
    } finally {
      await client.close();
    }
  });

  it("starts a Codex that lacks the method, and one whose roots could not be prepared", async () => {
    for (const [options, env] of [
      [{ resolveSkillExtraRoots: () => ["/fixture/skills/bundled"] }, { FAIL_EXTRA_ROOTS: "1" }],
      [{ resolveSkillExtraRoots: async () => { throw new Error("disk full"); } }, {}],
    ] as const) {
      const { client, sent, log } = connect(options, env);
      try {
        await expect(client.listThreads({ enrichDirectories: false })).resolves.toEqual([]);
        expect(sent.map((entry) => entry.method)).toContain("thread/list");
        expect(log.warn).toHaveBeenCalledWith("codex skill roots not registered", expect.any(Object));
      } finally {
        await client.close();
      }
    }
  });

  it("sends nothing when the host ships no skill roots", async () => {
    for (const options of [{}, { resolveSkillExtraRoots: () => [] }]) {
      const { client, sent } = connect(options);
      try {
        await client.listThreads({ enrichDirectories: false });
        expect(sent.map((entry) => entry.method)).not.toContain("skills/extraRoots/set");
      } finally {
        await client.close();
      }
    }
  });
});
