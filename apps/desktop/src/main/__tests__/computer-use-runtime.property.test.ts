import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { ComputerUseRuntime, prepareComputerUseMcpServer } from "../codex-app-server/computer-use-runtime";

const bin = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin";
const vendor = {
  command: `${bin}/node_repl`,
  args: [],
  env: { NODE_REPL_NODE_PATH: `${bin}/node`, PRIVATE_SETTING: "preserved" },
  enabled_tools: ["js", "js_reset"],
};

function fixture(options: { enabled?: boolean; platform?: NodeJS.Platform; configured?: unknown } = {}) {
  let version = "26.1111.21308";
  const readManifest = vi.fn(async (_file: string) => JSON.stringify({ mcpServers: { cua_repl: vendor } }));
  const request = vi.fn(async (method: string) => method === "thread/read"
    ? { thread: { cwd: "/fixture/project" } } : method === "config/read"
    ? { config: { mcp_servers: options.configured ?? {} } }
    : { marketplaces: [{ plugins: [{
      id: "unified-computer-use@openai-bundled",
      installed: true,
      enabled: options.enabled ?? true,
      localVersion: version,
    }] }] });
  const warn = vi.fn();
  const runtime = new ComputerUseRuntime({
    platform: options.platform ?? "darwin",
    codexHome: () => "/fixture/codex-home",
    executorId: () => "ambient-executor",
    readManifest,
    warn,
  });
  return { runtime, request, readManifest, warn, setVersion: (value: string) => { version = value; } };
}

describe("Computer Use launcher parent", () => {
  // Sky authenticates the process that starts node_repl. Moving only the
  // executable, or losing the plugin environment, does not satisfy that rule.
  it("keeps vendor Node as the immediate parent and preserves every plugin setting", () => {
    fc.assert(fc.property(
      fc.dictionary(fc.stringMatching(/^[A-Z][A-Z0-9_]{0,12}$/), fc.string()),
      fc.constantFrom("direct", "shell"),
      fc.constantFrom("ChatGPT.app", "Chat GPT 📎.app"),
      (extraEnv, launcher, bundle) => {
        const bin = `/Applications/${bundle}/Contents/Resources/cua_node/bin`;
        const original = {
          command: launcher === "direct" ? `${bin}/node_repl` : "/bin/sh",
          args: launcher === "direct" ? [] : [
            "-c",
            'export BROWSER_USE_ACCESS_EXECUTOR_ID="${BROWSER_USE_ACCESS_EXECUTOR_ID-}"; exec "$@"',
            "cua-repl",
            `${bin}/node_repl`,
          ],
          env: { ...extraEnv, NODE_REPL_NODE_PATH: `${bin}/node` },
          enabled_tools: ["js", "js_reset", "turn_ended"],
          startup_timeout_sec: 40,
        };
        const before = structuredClone(original);
        const adapted = prepareComputerUseMcpServer(original);
        expect(adapted?.command).toBe(`${bin}/node`);
        expect(adapted?.args).toEqual(["-e", expect.any(String), `${bin}/node_repl`]);
        expect(adapted?.env).toEqual({ ...original.env, BROWSER_USE_ACCESS_EXECUTOR_ID: "" });
        expect(adapted?.enabled_tools).toEqual(original.enabled_tools);
        expect(adapted?.startup_timeout_sec).toBe(40);
        expect(original).toEqual(before);
      },
    ));
  });

  it("does not interpret a custom shell command as the vendor launcher", () => {
    expect(prepareComputerUseMcpServer({ ...vendor, command: "/bin/sh", args: ["-c", "custom"] })).toBeUndefined();
    expect(prepareComputerUseMcpServer({ ...vendor, env: { NODE_REPL_NODE_PATH: "node" } })).toBeUndefined();
  });

  it("preserves execution, MCP restrictions, and input across every thread entry point", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("thread/start", "thread/resume", "thread/fork"),
      fc.constantFrom("read-only", "workspace-write", "danger-full-access"),
      fc.dictionary(fc.stringMatching(/^[A-Z]{1,8}$/), fc.string()),
      async (method, sandbox, env) => {
        const f = fixture();
        const params = {
          cwd: "/fixture/project",
          sandbox,
          approvalPolicy: "on-request",
          config: { features: { hooks: false }, mcp_servers: {
            another: { enabled: false }, cua_repl: { disabled_tools: ["js_reset"], env },
          } },
        };
        const before = structuredClone(params);
        const result = await f.runtime.prepare({ method, params, request: f.request }) as typeof params;
        expect(result.sandbox).toBe(sandbox);
        expect(result.approvalPolicy).toBe("on-request");
        expect(result.config.features).toEqual(params.config.features);
        expect(result.config.mcp_servers.another).toEqual({ enabled: false });
        expect(result.config.mcp_servers.cua_repl).toMatchObject({
          command: `${bin}/node`,
          disabled_tools: ["js_reset"],
          enabled_tools: vendor.enabled_tools,
          env: { ...vendor.env, ...env, BROWSER_USE_ACCESS_EXECUTOR_ID: "ambient-executor" },
        });
        expect(params).toEqual(before);
        expect(f.request).toHaveBeenCalledWith("config/read", { includeLayers: false, cwd: params.cwd });
        expect(f.request).toHaveBeenCalledWith("plugin/list", {
          cwds: [params.cwd], forceRefetch: false, marketplaceKinds: ["local"],
        });
      },
    ));
  });

  it.each([
    { platform: "win32" as const },
    { platform: "linux" as const },
    { config: { features: { plugins: false } } },
    { config: { "features.plugins": false } },
    { config: { plugins: { "unified-computer-use@openai-bundled": { enabled: false } } } },
    { config: { 'plugins."unified-computer-use@openai-bundled".enabled': false } },
    { config: { "mcp_servers.cua_repl.enabled": false } },
    { config: { "mcp_servers.cua_repl.command": "custom" } },
    { config: { mcp_servers: { cua_repl: { enabled: false } } } },
    { config: { mcp_servers: { cua_repl: { command: "custom" } } } },
    { config: { mcp_servers: { cua_repl: { args: [] } } } },
  ])("leaves disabled, unsupported, and custom runtimes alone: %j", async ({ platform, config }) => {
    const f = fixture({ platform });
    const params = { config };
    expect(await f.runtime.prepare({ method: "thread/start", params, request: f.request })).toBe(params);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does not enable an inactive plugin or replace a global custom registration", async () => {
    for (const options of [{ enabled: false }, { configured: { cua_repl: { command: "custom" } } }]) {
      const f = fixture(options);
      const params = { cwd: "/fixture/project" };
      expect(await f.runtime.prepare({ method: "thread/resume", params, request: f.request })).toBe(params);
      expect(f.readManifest).not.toHaveBeenCalled();
    }
  });

  it("uses Codex's active version as the cache oracle, including after plugin updates", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 3, maxLength: 8 }),
      async (versions) => {
        const f = fixture();
        for (const version of versions) {
          f.setVersion(`26.${version}`);
          const result = await f.runtime.prepare({ method: "thread/fork", params: { threadId: "fixture" }, request: f.request });
          expect(result).toMatchObject({ config: { mcp_servers: { cua_repl: { command: `${bin}/node` } } } });
        }
        expect(f.readManifest).toHaveBeenCalledTimes(new Set(versions).size);
        for (const version of new Set(versions)) {
          expect(f.readManifest).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`[/\\\\]26\\.${version}[/\\\\]\\.mcp\\.json$`)));
        }
      },
    ), { numRuns: 25 });
  });

  it("uses the protocol's saved project context for resumes and forks without cwd", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("thread/resume", "thread/fork"),
      fc.constantFrom("disabled", "custom", "enabled"),
      fc.constantFrom("/fixture/project", "/fixture/project with spaces", "/fixture/📎"),
      async (method, policy, savedCwd) => {
        const f = fixture();
        const request = vi.fn(async (name: string, value: unknown) => {
          const args = value as { cwd?: string; cwds?: string[] };
          if (name === "thread/read") return { thread: { cwd: savedCwd } };
          if (name === "config/read") return { config: { mcp_servers:
            args.cwd === savedCwd && policy === "custom" ? { cua_repl: { command: "project-custom" } } : {},
          } };
          // The default context enables Computer Use. The saved project's
          // configuration is authoritative even when the caller omits cwd.
          return { marketplaces: [{ plugins: [{
            id: "unified-computer-use@openai-bundled", installed: true,
            enabled: args.cwds?.[0] === savedCwd ? policy !== "disabled" : true,
            localVersion: "26.1111.21308",
          }] }] };
        });
        const params = { threadId: "saved-thread", config: { features: { hooks: false } } };
        const result = await f.runtime.prepare({ method, params, request });
        expect(request.mock.calls[0]).toEqual(["thread/read", { threadId: "saved-thread", includeTurns: false }]);
        expect(request).toHaveBeenCalledWith("config/read", { includeLayers: false, cwd: savedCwd });
        if (policy === "enabled") {
          expect(result).toMatchObject({ config: { mcp_servers: { cua_repl: { command: `${bin}/node` } } } });
          expect(result).not.toHaveProperty("cwd");
        } else {
          expect(result).toBe(params);
          expect(f.readManifest).not.toHaveBeenCalled();
        }
        if (policy !== "custom") expect(request).toHaveBeenCalledWith("plugin/list", {
          cwds: [savedCwd], forceRefetch: false, marketplaceKinds: ["local"],
        });
      },
    ));
  });

  it("does not use the default project when saved cwd cannot be resolved", async () => {
    for (const saved of [{ thread: {} }, { thread: { cwd: "" } }, { thread: { cwd: "  " } }]) {
      const f = fixture();
      const request = vi.fn(async () => saved);
      const params = { threadId: "saved-thread" };
      expect(await f.runtime.prepare({ method: "thread/resume", params, request })).toBe(params);
      expect(request).toHaveBeenCalledExactlyOnceWith("thread/read", { threadId: "saved-thread", includeTurns: false });
      expect(f.readManifest).not.toHaveBeenCalled();
    }
    const f = fixture();
    const params = { threadId: "saved-thread" };
    const request = vi.fn(async () => { throw new Error("thread unavailable"); });
    expect(await f.runtime.prepare({ method: "thread/resume", params, request })).toBe(params);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retains the original request and logs no config values when preparation fails", async () => {
    const f = fixture();
    f.readManifest.mockRejectedValue(new Error("private diagnostic that must not be logged"));
    const params = { cwd: "/fixture/project" };
    for (let index = 0; index < 2; index += 1) {
      expect(await f.runtime.prepare({ method: "thread/start", params, request: f.request })).toBe(params);
    }
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.warn.mock.calls)).not.toContain("private diagnostic");
    expect(f.readManifest).toHaveBeenCalledTimes(2);
  });
});
