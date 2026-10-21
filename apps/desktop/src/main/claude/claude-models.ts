import { spawn } from "node:child_process";
import { query, type ModelInfo, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackendModelOption } from "@pwragent/shared";

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
  query?: typeof query;
}): Promise<BackendModelOption[]> {
  const models = await readClaudeMetadata({
    ...params,
    read: (session) => session.supportedModels(),
    timeoutMessage: "Claude model discovery timed out. Check the CLI and try again.",
  });
  if (models.length === 0) throw new Error("Claude returned no available models.");
  return claudeModelOptions(models);
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
        abortController: controller,
        persistSession: false,
        // Metadata reads need no tools or MCP connections.
        tools: [], strictMcpConfig: true, mcpServers: {},
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

/** Preserve the CLI's order and aliases; only older versions move to the submenu. */
export function claudeModelOptions(catalog: ModelInfo[]): BackendModelOption[] {
  const defaultModel = catalog.find((model) => model.value === "default");
  const models = catalog.filter((model) => model !== defaultModel
    || !defaultModel.resolvedModel
    || !catalog.some((other) => other !== defaultModel && other.resolvedModel === defaultModel.resolvedModel));
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
