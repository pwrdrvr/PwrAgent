import { spawn } from "node:child_process";
import { query, type McpServerStatus, type ModelInfo, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackendModelOption } from "@pwragent/shared";
import { getMainLogger } from "../log";

const claudeModelLog = getMainLogger("pwragent:claude-models");

/** Keep discovery and turns on the same unmodified Claude Code harness. */
export function claudeHarnessOptions(executable: string, env: NodeJS.ProcessEnv): Options {
  return {
    pathToClaudeCodeExecutable: executable,
    env,
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    spawnClaudeCodeProcess: (options) => {
      const scriptRuntime = options.command === "node" || options.command === "bun";
      return spawn(scriptRuntime ? process.execPath : options.command, options.args, {
        cwd: options.cwd,
        env: scriptRuntime ? { ...options.env, ELECTRON_RUN_AS_NODE: "1" } : options.env,
        signal: options.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
      });
    },
  };
}

/** Read initialization metadata without submitting a prompt or persisting a session. */
export async function discoverClaudeModels(params: {
  executable: string;
  env: NodeJS.ProcessEnv;
  cliVersion?: string;
  query?: typeof query;
}): Promise<BackendModelOption[]> {
  const models = await readClaudeMetadata({
    ...params,
    // This catalog feeds every project. Project/local availableModels settings
    // belong to actual turns and must not restrict the global model picker.
    settingSources: ["user"],
    read: (session) => session.supportedModels(),
    timeoutMessage: "Claude model discovery timed out. Check the CLI and try again.",
  });
  if (models.length === 0) throw new Error("Claude returned no available models.");
  return claudeModelOptions(models, { source: "discovery", cliVersion: params.cliVersion });
}

/**
 * The MCP servers Claude Code loads from its own settings, `.mcp.json` and
 * plugins for a folder, read through a session that receives no prompt.
 * Servers still connecting are polled until they settle or the wait ends.
 */
export async function readClaudeMcpServerStatus(params: {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  query?: typeof query;
  settleMs?: number;
}): Promise<McpServerStatus[]> {
  const settleMs = params.settleMs ?? 10_000;
  return await readClaudeMetadata({
    ...params,
    loadMcpServers: true,
    read: async (session) => {
      const deadline = Date.now() + settleMs;
      let servers = await session.mcpServerStatus();
      while (servers.some((server) => server.status === "pending") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        servers = await session.mcpServerStatus();
      }
      return servers;
    },
    timeoutMessage: "Claude MCP discovery timed out.",
    timeoutMs: settleMs + 10_000,
  });
}

/**
 * Open a Claude session that never receives a prompt, read what its
 * initialize handshake reports, and close it. No turn runs and nothing is
 * persisted.
 */
export async function readClaudeMetadata<T>(params: {
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  settingSources?: Options["settingSources"];
  /** Connect the MCP servers Claude Code's own config names. */
  loadMcpServers?: boolean;
  query?: typeof query;
  read: (session: Query) => Promise<T>;
  timeoutMessage: string;
  timeoutMs?: number;
}): Promise<T> {
  const controller = new AbortController();
  let release!: () => void;
  const finished = new Promise<void>((resolve) => { release = resolve; });
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    await finished;
    yield* [];
  }
  let session: Query | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    session = (params.query ?? query)({
      prompt: prompt(),
      options: {
        ...claudeHarnessOptions(params.executable, params.env),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.settingSources ? { settingSources: params.settingSources } : {}),
        abortController: controller,
        persistSession: false,
        // Metadata reads need no tools, and MCP connections only when the
        // read is about them.
        tools: [],
        ...(params.loadMcpServers ? {} : { strictMcpConfig: true, mcpServers: {} }),
      },
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(params.timeoutMessage));
      }, params.timeoutMs ?? 15_000);
    });
    return await Promise.race([params.read(session), timeout]);
  } finally {
    clearTimeout(timer);
    release();
    session?.close();
  }
}

function familyVersion(model: ModelInfo): { family: string; version: number[] } | undefined {
  const match = /^(?:Claude\s+)?(.+?)\s+(\d+(?:\.\d+)*)(?:\s|$)/i.exec(model.displayName);
  return match ? { family: match[1].toLowerCase(), version: match[2].split(".").map(Number) } : undefined;
}

function withResolvedVersion(model: ModelInfo): ModelInfo {
  // Some initialize handshakes return only generic display names even though
  // they resolve each alias to a versioned model. Keep the selectable alias and
  // any explicit/custom label; enrich only a bare family name we can identify.
  const match = /^claude-([a-z]+)-(\d{1,3})(?:-(\d{1,3}))?(?:-\d{8})?(?:\[\d+[mk]\])?$/i
    .exec(model.resolvedModel ?? model.value);
  if (!match || model.displayName.replace(/^Claude\s+/i, "").toLowerCase() !== match[1].toLowerCase()) return model;
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  const context = /\[(\d+[mk])\]$/i.exec(model.value) ?? /\[(\d+[mk])\]$/i.exec(model.resolvedModel ?? "");
  return { ...model, displayName: `${model.displayName} ${version}${context ? ` (${context[1].toUpperCase()} context)` : ""}` };
}

/** Preserve the CLI's order and aliases; only older versions move to the submenu. */
export function claudeModelOptions(catalog: ModelInfo[], diagnostics?: {
  source: "discovery" | "session";
  cliVersion?: string;
}): BackendModelOption[] {
  if (diagnostics) {
    // Aggregate metadata only: no model IDs, custom labels, paths, or account data.
    claudeModelLog.info("Claude model catalog received", {
      source: diagnostics.source,
      cliVersion: diagnostics.cliVersion,
      modelCount: catalog.length,
      versionedNameCount: catalog.filter((model) => familyVersion(model)).length,
      resolvedGenericNameCount: catalog.filter((model) => withResolvedVersion(model) !== model).length,
    });
  }
  const defaultModel = catalog.find((model) => model.value === "default");
  const models = catalog.filter((model) => model !== defaultModel
    || !defaultModel.resolvedModel
    || !catalog.some((other) => other !== defaultModel && other.resolvedModel === defaultModel.resolvedModel))
    .map(withResolvedVersion);
  const newest = new Map<string, { model: ModelInfo; version: number[] }>();
  for (const model of models) {
    const parsed = familyVersion(model);
    if (!parsed) continue;
    const current = newest.get(parsed.family);
    const difference = current
      ? Array.from({ length: Math.max(parsed.version.length, current.version.length) }, (_, index) =>
          (parsed.version[index] ?? 0) - (current.version[index] ?? 0)).find((value) => value !== 0) ?? 0
      : 1;
    if (difference > 0) newest.set(parsed.family, { model, version: parsed.version });
  }
  return models.map((model) => {
    const parsed = familyVersion(model);
    return {
      id: model.value, label: model.displayName,
      current: model.value === "default" || Boolean(defaultModel?.resolvedModel && model.resolvedModel === defaultModel.resolvedModel),
      ...(parsed && newest.get(parsed.family)?.model !== model ? { other: true } : {}),
      supportsReasoning: model.supportsEffort === true,
      // An untouched picker must preserve the CLI's per-model effort setting.
      ...(model.supportsEffort ? { defaultReasoningEffort: "default" } : {}),
      reasoningEfforts: model.supportsEffort ? ["default", ...model.supportedEffortLevels ?? []] : [],
      supportsImage: true,
    };
  });
}
