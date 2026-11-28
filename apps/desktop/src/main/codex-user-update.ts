import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { parseCodexVersionCore } from "@pwragent/shared/codex-version";
import {
  CODEX_USER_UPDATE_ACTIVE_PHASES,
  deriveCodexUserUpdateOffer,
  type CodexUserUpdateOffer,
  type CodexUserUpdatePhase,
  type CodexUserUpdateRun,
  type CodexUserUpdateState,
  type CodexUpdateTarget,
} from "../shared/codex-user-update";
import { buildPwrAgentChildProcessEnv } from "./child-process-env.js";
import { fetchGitHubReleaseMetadata, ReleaseCheckDeferredError } from "./github-release-cache.js";
import {
  CODEX_STANDALONE_INSTALL_PS1_URL,
  CODEX_STANDALONE_INSTALL_SH_URL,
  classifyCodexInstaller,
  type CodexInstallerClassification,
} from "./settings/codex-version-advisory";

/** npm's `latest` dist-tag is the newest stock Codex release. */
export const CODEX_NPM_LATEST_URL = "https://registry.npmjs.org/@openai/codex/latest";
/** One registry request per PwrAgent root per day, through the persisted release-check budget. */
export const CODEX_LATEST_CHECK_TTL_MS = 24 * 60 * 60_000;
/**
 * How often this process asks again. The persisted cache answers from disk
 * until its day is up, so this only bounds how stale a long-running window's
 * answer can be.
 */
export const CODEX_LATEST_RECHECK_INTERVAL_MS = 6 * 60 * 60_000;
/** Homebrew can spend minutes updating its own taps before it upgrades. */
export const CODEX_UPDATE_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_TAIL_BYTES = 4 * 1024;

/**
 * Fetch the newest stock Codex version, or `undefined` when the shared
 * release-check budget says not now and has nothing cached.
 */
export async function fetchLatestCodexVersion(options: {
  fetch?: typeof fetch;
  directory?: string;
  now?: () => number;
} = {}): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetchGitHubReleaseMetadata(
      CODEX_NPM_LATEST_URL,
      { headers: { Accept: "application/json" } },
      {
        ttlMs: CODEX_LATEST_CHECK_TTL_MS,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.directory ? { directory: options.directory } : {}),
        ...(options.now ? { now: options.now } : {}),
      },
    );
  } catch (error) {
    if (error instanceof ReleaseCheckDeferredError) return undefined;
    throw error;
  }
  if (!response.ok) {
    throw new Error(`The npm registry answered ${response.status} for @openai/codex.`);
  }
  const body = JSON.parse(await response.text()) as { version?: unknown };
  if (typeof body.version !== "string") {
    throw new Error("The npm registry's @openai/codex entry has no version.");
  }
  const core = parseCodexVersionCore(body.version);
  // `latest` is a stable release; a prerelease there would not be one to offer.
  if (!core || body.version.trim() !== core.join(".")) {
    throw new Error(`The npm registry named an unexpected Codex version: ${body.version}`);
  }
  return body.version.trim();
}

/** A process to run, already resolved to an absolute tool. */
export type CodexUpdateInvocation = {
  file: string;
  args: string[];
  /** Variables to set (a string) or remove (`undefined`) on top of the spawn environment. */
  env: Record<string, string | undefined>;
  windowsVerbatimArguments?: boolean;
};

type ToolLookup = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isExecutable: (candidate: string) => Promise<boolean>;
  resolveOnPath: (
    command: string,
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ) => Promise<string | undefined>;
};

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === "win32" ? path.win32.join(...parts) : path.posix.join(...parts);
}

function dirnameFor(platform: NodeJS.Platform, entry: string): string {
  return platform === "win32" ? path.win32.dirname(entry) : path.posix.dirname(entry);
}

/** The first candidate that is an executable file, then the name on PATH. */
async function findTool(
  lookup: ToolLookup,
  candidates: string[],
  name: string,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await lookup.isExecutable(candidate)) return candidate;
  }
  const onPath = await lookup.resolveOnPath(name, lookup.env, lookup.platform);
  if (onPath && await lookup.isExecutable(onPath)) return onPath;
  return undefined;
}

/**
 * Windows will not spawn a `.cmd` shim without a shell. The arguments here
 * are fixed words and a tool path, which cannot contain a quote, so quoting
 * the path is the only escaping it needs.
 */
function wrapWindowsShim(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Pick<CodexUpdateInvocation, "file" | "args" | "windowsVerbatimArguments"> {
  if (!/\.(?:cmd|bat)$/iu.test(file)) return { file, args };
  const comSpec = Object.entries(env)
    .find(([key]) => key.toLowerCase() === "comspec")?.[1] || "cmd.exe";
  const line = [`"${file}"`, ...args].join(" ");
  return { file: comSpec, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

/**
 * How to run this installer's update, or `undefined` when PwrAgent cannot run
 * it here. Every argument comes from the classification's own command; the
 * only thing looked up is where that command's tool lives, starting beside
 * the install so the update lands on the Codex PwrAgent launches.
 */
export async function resolveCodexUpdateInvocation(
  params: ToolLookup & {
    classification: CodexInstallerClassification;
    /** The Codex command PwrAgent launches. */
    command: string;
  },
): Promise<CodexUpdateInvocation | undefined> {
  const { classification, platform } = params;
  const { upgradeCommand, installRoot } = classification;
  if (!upgradeCommand) return undefined;
  const words = upgradeCommand.split(" ");
  const win = platform === "win32";
  const exe = (name: string): string[] => (win ? [`${name}.exe`, `${name}.cmd`] : [name]);
  const at = (...parts: string[]): string[] =>
    exe(joinFor(platform, ...parts));
  const packageManager = async (
    candidates: string[],
    name: string,
    env: Record<string, string | undefined>,
  ): Promise<CodexUpdateInvocation | undefined> => {
    const tool = await findTool(params, candidates, name);
    if (!tool) return undefined;
    return { ...wrapWindowsShim(tool, words.slice(1), params.env), env };
  };
  switch (classification.installer) {
    case "homebrew":
      return await packageManager(
        installRoot ? at(installRoot, "bin", "brew") : [],
        "brew",
        { HOMEBREW_NO_ENV_HINTS: "1", HOMEBREW_NO_COLOR: "1", NONINTERACTIVE: "1" },
      );
    case "npm":
      // An npm from another Node would install into its own prefix and leave
      // this Codex where it is; the prefix pins the one PwrAgent launches.
      return await packageManager(
        installRoot ? (win ? at(installRoot, "npm") : at(installRoot, "bin", "npm")) : [],
        "npm",
        installRoot ? { npm_config_prefix: installRoot } : {},
      );
    case "pnpm":
      return await packageManager(
        installRoot ? at(installRoot, "pnpm") : [],
        "pnpm",
        installRoot ? { PNPM_HOME: installRoot } : {},
      );
    case "bun":
      return await packageManager(
        installRoot ? at(installRoot, "bin", "bun") : [],
        "bun",
        installRoot ? { BUN_INSTALL: installRoot } : {},
      );
    case "standalone":
      return await standaloneInvocation(params);
    default:
      return undefined;
  }
}

async function standaloneInvocation(
  params: ToolLookup & { classification: CodexInstallerClassification; command: string },
): Promise<CodexUpdateInvocation | undefined> {
  const { platform, classification } = params;
  // The installer finds the install through CODEX_HOME. PwrAgent's spawn
  // environment can carry an auth profile's home instead, so name the one
  // this Codex lives in, or clear it for the installer's default.
  const env: Record<string, string | undefined> = {
    CODEX_NON_INTERACTIVE: "1",
    CODEX_HOME: classification.installRoot,
  };
  const commandDirectory = /[\\/]/u.test(params.command)
    ? dirnameFor(platform, params.command)
    : undefined;
  const commandIsLink = commandDirectory !== undefined
    && !/[\\/]packages[\\/]standalone[\\/]/u.test(params.command);
  if (platform === "win32") {
    if (commandIsLink) env.CODEX_INSTALL_DIR = commandDirectory;
    const systemRoot = Object.entries(params.env)
      .find(([key]) => key.toLowerCase() === "systemroot")?.[1];
    const powershell = await findTool(
      params,
      systemRoot
        ? [path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]
        : [],
      "powershell.exe",
    );
    if (!powershell) return undefined;
    return {
      file: powershell,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `irm ${CODEX_STANDALONE_INSTALL_PS1_URL} | iex`,
      ],
      env,
    };
  }
  // The visible `codex` link is where the installer keeps it.
  if (commandIsLink) env.CODEX_INSTALL_DIR = commandDirectory;
  const shell = await findTool(params, ["/bin/sh"], "sh");
  const curl = await findTool(params, ["/usr/bin/curl"], "curl");
  if (!shell || !curl) return undefined;
  // Downloaded first so a failed download fails the run. Piped straight into
  // `sh`, it would hand the shell an empty script that exits 0.
  return {
    file: shell,
    args: [
      "-c",
      'script="$("$0" -fsSL "$1")" || exit $?; printf \'%s\\n\' "$script" | /bin/sh',
      curl,
      CODEX_STANDALONE_INSTALL_SH_URL,
    ],
    env,
  };
}

export type CodexUpdateProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  outputTail: string;
  timedOut: boolean;
};

export type SpawnCodexUpdate = (
  file: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

/** Keep the last `limit` bytes of everything the installer printed. */
export function appendOutputTail(tail: string, chunk: string, limit = OUTPUT_TAIL_BYTES): string {
  const next = tail + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export async function runCodexUpdateProcess(
  invocation: CodexUpdateInvocation,
  options: {
    env: NodeJS.ProcessEnv;
    spawn?: SpawnCodexUpdate;
    timeoutMs?: number;
  },
): Promise<CodexUpdateProcessResult> {
  const env = buildPwrAgentChildProcessEnv(options.env, { NO_COLOR: "1" });
  for (const [key, value] of Object.entries(invocation.env)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const spawn = options.spawn ?? spawnProcess;
  return await new Promise((resolve) => {
    let outputTail = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: Omit<CodexUpdateProcessResult, "outputTail" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, outputTail, timedOut });
    };
    let child: ChildProcess;
    try {
      child = spawn(invocation.file, invocation.args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (error) {
      outputTail = error instanceof Error ? error.message : String(error);
      resolve({ exitCode: null, signal: null, outputTail, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? CODEX_UPDATE_TIMEOUT_MS);
    const collect = (chunk: Buffer | string): void => {
      outputTail = appendOutputTail(outputTail, chunk.toString());
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => {
      outputTail = appendOutputTail(outputTail, `${error.message}\n`);
      finish({ exitCode: null, signal: null });
    });
    child.once("close", (exitCode, signal) => finish({ exitCode, signal }));
  });
}

export type CodexUserUpdateServiceOptions = {
  readTarget: () => Promise<CodexUpdateTarget | undefined>;
  resolvePath: (command: string) => Promise<string | undefined>;
  resolveEnv: () => Promise<NodeJS.ProcessEnv>;
  fetchLatestVersion: () => Promise<string | undefined>;
  /** Re-read the selected Codex's version after an update. */
  rediscover: () => Promise<void>;
  /** Start a new Codex app server; running turns finish on the old one. */
  restartCodex: () => Promise<void>;
  isExecutable: ToolLookup["isExecutable"];
  resolveOnPath: ToolLookup["resolveOnPath"];
  /** E2E and screenshot runs must not depend on what is published. */
  checksDisabled?: boolean;
  platform?: NodeJS.Platform;
  now?: () => number;
  spawn?: SpawnCodexUpdate;
  timeoutMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

/**
 * Keeps a stock Codex current: finds out whether a newer release exists,
 * and runs the installer's own update when PwrAgent recognizes it. One update
 * runs at a time per process. Its state lives in memory; a restart forgets a
 * finished run and asks the budgeted cache again.
 */
export class CodexUserUpdateService {
  private latestVersion?: string;
  private lastLatestAttemptAt?: number;
  private latestCheck?: Promise<void>;
  private offer?: CodexUserUpdateOffer;
  private run?: CodexUserUpdateRun;
  private runCount = 0;
  private starting?: Promise<CodexUserUpdateState>;
  private recheckTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly listeners = new Set<(state: CodexUserUpdateState) => void>();

  constructor(private readonly options: CodexUserUpdateServiceOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  snapshot(): CodexUserUpdateState {
    return {
      ...(this.offer ? { offer: this.offer } : {}),
      ...(this.run ? { run: this.run } : {}),
    };
  }

  subscribe(listener: (state: CodexUserUpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // A broken window must not stop an update.
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = undefined;
    this.listeners.clear();
  }

  /**
   * The current offer, recomputed from what PwrAgent launches now. Asks the
   * budgeted cache for the latest release when this process has not asked
   * for a while; the answer arrives as a published state.
   */
  async readState(): Promise<CodexUserUpdateState> {
    if (this.options.checksDisabled || this.disposed) return {};
    this.ensureLatestCheck();
    await this.recomputeOffer();
    return this.snapshot();
  }

  private ensureLatestCheck(): void {
    const now = this.now();
    if (this.latestCheck) return;
    if (
      this.lastLatestAttemptAt !== undefined
      && now - this.lastLatestAttemptAt < CODEX_LATEST_RECHECK_INTERVAL_MS
    ) {
      return;
    }
    this.lastLatestAttemptAt = now;
    this.latestCheck = (async () => {
      try {
        const latest = await this.options.fetchLatestVersion();
        if (latest) this.latestVersion = latest;
        else this.lastLatestAttemptAt = undefined;
      } catch (error) {
        this.options.log?.("Codex latest release check failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.latestCheck = undefined;
      }
      if (await this.recomputeOffer()) this.publish();
      this.scheduleRecheck();
    })();
  }

  private scheduleRecheck(): void {
    if (this.disposed || this.recheckTimer) return;
    // A deferred check (no cached answer yet) asks again sooner.
    const delay = this.lastLatestAttemptAt === undefined
      ? 15 * 60_000
      : CODEX_LATEST_RECHECK_INTERVAL_MS;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = undefined;
      if (this.disposed) return;
      this.ensureLatestCheck();
    }, delay);
    this.recheckTimer.unref?.();
  }

  private async classifyTarget(target: CodexUpdateTarget): Promise<CodexInstallerClassification> {
    return classifyCodexInstaller({
      command: target.command,
      managedByPwrAgent: target.managedByPwrAgent,
      ...(target.openAiInstalledByPwrAgent ? { openAiInstalledByPwrAgent: true } : {}),
      platform: this.platform,
      ...(target.managedByPwrAgent ? {} : { resolvedPath: await this.options.resolvePath(target.command) }),
      ...(target.source ? { source: target.source } : {}),
    });
  }

  private async resolveInvocation(
    target: CodexUpdateTarget,
    classification: CodexInstallerClassification,
  ): Promise<CodexUpdateInvocation | undefined> {
    if (!classification.upgradeCommand) return undefined;
    return await resolveCodexUpdateInvocation({
      classification,
      command: target.command,
      platform: this.platform,
      env: await this.options.resolveEnv(),
      isExecutable: this.options.isExecutable,
      resolveOnPath: this.options.resolveOnPath,
    });
  }

  /** Returns whether the offer changed. */
  private async recomputeOffer(): Promise<boolean> {
    const previous = JSON.stringify(this.offer ?? null);
    const target = await this.options.readTarget().catch(() => undefined);
    let next: CodexUserUpdateOffer | undefined;
    if (target && this.latestVersion) {
      const classification = await this.classifyTarget(target);
      // Only look for the tool when there is something to offer.
      const quick = deriveCodexUserUpdateOffer({
        installedVersion: target.version,
        latestVersion: this.latestVersion,
        installer: classification.installer,
        ...(classification.upgradeCommand ? { upgradeCommand: classification.upgradeCommand } : {}),
        runnable: false,
      });
      next = quick && classification.upgradeCommand
        ? deriveCodexUserUpdateOffer({
          installedVersion: target.version,
          latestVersion: this.latestVersion,
          installer: classification.installer,
          upgradeCommand: classification.upgradeCommand,
          runnable: (await this.resolveInvocation(target, classification).catch(() => undefined)) !== undefined,
        })
        : quick;
    }
    this.offer = next;
    return JSON.stringify(next ?? null) !== previous;
  }

  private setRun(phase: CodexUserUpdatePhase, patch: Partial<CodexUserUpdateRun> = {}): void {
    if (!this.run) return;
    this.run = { ...this.run, ...patch, phase, updatedAt: this.now() };
    this.publish();
  }

  /**
   * Run the update for the Codex PwrAgent launches. Resolves once the run has
   * started; progress and the outcome arrive as published states. Refuses
   * when nothing runnable is offered, rather than run anything else.
   */
  async startUpdate(): Promise<CodexUserUpdateState> {
    if (this.options.checksDisabled || this.disposed) {
      throw new Error("Codex updates are not available in this window.");
    }
    if (this.run && CODEX_USER_UPDATE_ACTIVE_PHASES.has(this.run.phase)) {
      return this.snapshot();
    }
    // Two windows can press Update together; the second joins the first
    // rather than starting another installer while this one resolves its tool.
    this.starting ??= this.beginUpdate().finally(() => {
      this.starting = undefined;
    });
    return await this.starting;
  }

  private async beginUpdate(): Promise<CodexUserUpdateState> {
    await this.recomputeOffer();
    const offer = this.offer;
    const target = await this.options.readTarget();
    if (!offer?.canRunUpdate || !target) {
      throw new Error("PwrAgent cannot run an update for this Codex. Update it the way it was installed.");
    }
    const classification = await this.classifyTarget(target);
    const invocation = await this.resolveInvocation(target, classification);
    if (!invocation) {
      throw new Error("PwrAgent could not find the tool that installed this Codex.");
    }
    const startedAt = this.now();
    this.runCount += 1;
    this.run = {
      id: this.runCount,
      phase: "updating",
      installer: offer.installer,
      fromVersion: offer.installedVersion,
      targetVersion: offer.latestVersion,
      ...(offer.upgradeCommand ? { upgradeCommand: offer.upgradeCommand } : {}),
      startedAt,
      updatedAt: startedAt,
    };
    this.publish();
    void this.executeRun(invocation, offer).catch((error) => {
      this.setRun("failed", { error: error instanceof Error ? error.message : String(error) });
    });
    return this.snapshot();
  }

  private async executeRun(
    invocation: CodexUpdateInvocation,
    offer: CodexUserUpdateOffer,
  ): Promise<void> {
    const result = await runCodexUpdateProcess(invocation, {
      env: await this.options.resolveEnv(),
      ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
    });
    if (result.exitCode !== 0) {
      this.options.log?.("Codex update failed", {
        installer: offer.installer,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
      });
      this.setRun("failed", {
        error: result.timedOut
          ? "The update took too long and was stopped."
          : result.exitCode === null
            ? `The update could not run${result.signal ? ` (${result.signal})` : ""}.`
            : `The update exited with code ${result.exitCode}.`,
        outputTail: result.outputTail,
      });
      return;
    }
    this.setRun("verifying");
    await this.options.rediscover();
    const after = await this.options.readTarget();
    const toVersion = parseCodexVersionCore(after?.version)?.join(".");
    const moved = toVersion !== undefined
      && toVersion !== offer.installedVersion
      && deriveCodexUserUpdateOffer({
        installedVersion: offer.installedVersion,
        latestVersion: toVersion,
        installer: offer.installer,
        runnable: false,
      }) !== undefined;
    if (!moved) {
      this.setRun("unchanged", {
        ...(toVersion ? { toVersion } : {}),
        outputTail: result.outputTail,
      });
      await this.recomputeOffer();
      this.publish();
      return;
    }
    this.setRun("restarting", { toVersion });
    await this.options.restartCodex();
    await this.recomputeOffer();
    this.setRun("succeeded", { toVersion });
  }
}
