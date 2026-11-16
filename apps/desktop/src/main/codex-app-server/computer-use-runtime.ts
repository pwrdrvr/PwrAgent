import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginListResponse } from "@pwrdrvr/codex-app-server-protocol/v2";

const PLUGIN_ID = "unified-computer-use@openai-bundled";
const SHELL_LAUNCHER = 'export BROWSER_USE_ACCESS_EXECUTOR_ID="${BROWSER_USE_ACCESS_EXECUTOR_ID-}"; exec "$@"';

// Keep the vendor Node alive as node_repl's immediate parent. Sky authenticates
// that parent, so exec(), a shell, and PwrAgent's signed Codex are insufficient.
// This is a process-local argv value, never an installed helper or plugin edit.
const NODE_PARENT = [
  'const {spawn}=require("node:child_process");',
  'const child=spawn(process.argv[1],process.argv.slice(2),{stdio:"inherit",env:process.env});',
  'const signals=["SIGINT","SIGHUP","SIGTERM"];',
  'const handlers=signals.map(signal=>{const handler=()=>child.kill(signal);process.on(signal,handler);return handler;});',
  'child.on("error",error=>{console.error("Computer Use launch failed:",error.message);process.exitCode=1;});',
  'child.on("exit",(code,signal)=>{signals.forEach((name,index)=>process.off(name,handlers[index]));',
  'if(signal)process.kill(process.pid,signal);else process.exitCode=code??1;});',
].join("");

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Adapt only the stock macOS launcher; custom commands are operator-owned. */
export function prepareComputerUseMcpServer(
  server: Record<string, unknown>,
  executorId = "",
): Record<string, unknown> | undefined {
  const env = record(server.env);
  const node = env?.NODE_REPL_NODE_PATH;
  const args = server.args ?? [];
  if (typeof node !== "string" || !path.posix.isAbsolute(node)
    || path.posix.basename(node) !== "node" || !Array.isArray(args)
    || !args.every((arg): arg is string => typeof arg === "string")) return undefined;
  const nodeRepl = path.posix.join(path.posix.dirname(node), "node_repl");
  let forwarded: string[];
  if (server.command === nodeRepl) {
    forwarded = args;
  } else if (server.command === "/bin/sh" && args.length === 4
    && args[0] === "-c" && args[1] === SHELL_LAUNCHER
    && args[2] === "cua-repl" && args[3] === nodeRepl) {
    forwarded = [];
  } else {
    return undefined;
  }
  return {
    ...server,
    command: node,
    args: ["-e", NODE_PARENT, nodeRepl, ...forwarded],
    env: {
      ...env,
      BROWSER_USE_ACCESS_EXECUTOR_ID: env?.BROWSER_USE_ACCESS_EXECUTOR_ID ?? executorId,
    },
  };
}

export type ComputerUseThreadRequest = {
  method: string;
  params: unknown;
  request: (method: string, params: unknown) => Promise<unknown>;
};

export class ComputerUseRuntime {
  private readonly manifests = new Map<string, Promise<Record<string, unknown> | undefined>>();
  private warned = false;

  constructor(private readonly options: {
    codexHome: () => string;
    executorId?: () => string | undefined;
    platform?: NodeJS.Platform;
    readManifest?: (file: string) => Promise<string>;
    warn: (message: string) => void;
  }) {}

  async prepare(input: ComputerUseThreadRequest): Promise<unknown> {
    const params = record(input.params);
    const config = record(params?.config);
    const servers = record(config?.mcp_servers);
    const explicit = record(servers?.cua_repl);
    // Codex also accepts dotted per-request keys. Leave a dotted MCP override
    // entirely operator-owned instead of mixing two representations of it.
    const dottedOverride = Object.keys(config ?? {}).some((key) =>
      key === "mcp_servers.cua_repl" || key.startsWith("mcp_servers.cua_repl."),
    );
    if ((this.options.platform ?? process.platform) !== "darwin"
      || !["thread/start", "thread/resume", "thread/fork"].includes(input.method)
      || !params || record(config?.features)?.plugins === false
      || config?.["features.plugins"] === false || dottedOverride
      || record(record(config?.plugins)?.[PLUGIN_ID])?.enabled === false
      || config?.[`plugins.${PLUGIN_ID}.enabled`] === false
      || config?.[`plugins."${PLUGIN_ID}".enabled`] === false
      || explicit?.enabled === false || explicit?.command !== undefined
      || explicit?.args !== undefined) return input.params;

    try {
      let cwd = typeof params.cwd === "string" && params.cwd.trim() ? params.cwd : undefined;
      if (!cwd && input.method !== "thread/start") {
        // Resume callers can omit cwd. Discover plugins in the saved project
        // rather than inheriting the App Server's default project context.
        const threadId = typeof params.threadId === "string" && params.threadId.trim()
          ? params.threadId : undefined;
        if (!threadId) return input.params;
        const thread = record(record(await input.request("thread/read", {
          threadId,
          includeTurns: false,
        }))?.thread);
        if (typeof thread?.cwd !== "string" || !thread.cwd.trim()) return input.params;
        cwd = thread.cwd;
      }
      // Codex owns config precedence and plugin activation, including project
      // config. Never infer activation from cache directories or read its DB.
      const effective = record(record(await input.request("config/read", {
        includeLayers: false,
        ...(cwd ? { cwd } : {}),
      }))?.config);
      if (!effective || record(effective.features)?.plugins === false
        || record(effective.mcp_servers)?.cua_repl !== undefined) return input.params;
      const inventory = await input.request("plugin/list", {
        ...(cwd ? { cwds: [cwd] } : {}),
        forceRefetch: false,
        marketplaceKinds: ["local"],
      }) as PluginListResponse;
      const plugin = inventory.marketplaces?.flatMap((marketplace) => marketplace.plugins)
        .find((candidate) => candidate.id === PLUGIN_ID && candidate.enabled && candidate.installed);
      const version = plugin?.localVersion;
      if (!version || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) return input.params;
      const manifestPath = path.join(this.options.codexHome(), "plugins", "cache",
        "openai-bundled", "unified-computer-use", version, ".mcp.json");
      let pending = this.manifests.get(manifestPath);
      if (!pending) {
        pending = this.readManifest(manifestPath);
        this.manifests.set(manifestPath, pending);
      }
      const vendor = await pending;
      if (!vendor) return input.params;
      const adapted = prepareComputerUseMcpServer({
        ...vendor,
        ...explicit,
        env: { ...record(vendor.env), ...record(explicit?.env) },
      }, this.options.executorId?.());
      if (!adapted) return input.params;
      return {
        ...params,
        config: {
          ...config,
          mcp_servers: { ...servers, cua_repl: adapted },
        },
      };
    } catch {
      // An optional plugin must never prevent an unrelated thread from opening.
      // Do not log config, plugin environment, or tool arguments.
      if (!this.warned) {
        this.warned = true;
        this.options.warn("Computer Use parent launcher could not be prepared; retaining the configured launcher.");
      }
      return input.params;
    }
  }

  private async readManifest(file: string): Promise<Record<string, unknown> | undefined> {
    try {
      const text = await (this.options.readManifest ?? ((name) => readFile(name, "utf8")))(file);
      if (text.length > 1_048_576) return undefined;
      return record(record(record(JSON.parse(text))?.mcpServers)?.cua_repl);
    } catch (error) {
      this.manifests.delete(file);
      throw error;
    }
  }
}
