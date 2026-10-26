import { spawn, type SpawnOptions } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { createCommandInvocation } from "@pwrdrvr/agent-transport";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_STDIO_ENV_NAME_PATTERN,
  MCP_STDIO_LIMITS,
  type McpStdioLaunch,
  type McpStdioLaunchInput,
  type McpStdioTestProblem,
} from "@pwragent/shared";
import { pathIsExecutable, resolveCommandOnPath } from "../settings/command-discovery";
import { terminateOwnedProcessTree, type OwnedChildProcess } from "../process-tree";

/** How long a server gets to exit after its stdin closes, then per signal. */
const STDIN_CLOSE_GRACE_MS = 1_000;
const TERMINATE_GRACE_MS = 2_000;
const FORCE_TERMINATE_MS = 2_000;
/** The end of a server's stderr kept for an actionable startup error. */
const OUTPUT_TAIL_BYTES = 4_096;
/** Shown in place of a stored secret wherever server output is displayed. */
const SECRET_MASK = "••••";

/**
 * Variables a local command inherits from PwrAgent's own environment.
 *
 * Everything else in PwrAgent's environment -- tokens for other tools, cloud
 * credentials, the operator's shell exports -- stays out unless the operator
 * lists it on the connection. PATH comes from the login shell rather than the
 * app process, so `npx`, `uvx` and `#!/usr/bin/env node` resolve the way they
 * do in a terminal.
 */
const INHERITED_POSIX = ["HOME", "LOGNAME", "USER", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"];
const INHERITED_WINDOWS = [
  "APPDATA", "COMSPEC", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATHEXT",
  "PROCESSOR_ARCHITECTURE", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERNAME", "USERPROFILE", "WINDIR",
];

/** A launch failure the operator can act on. `output` is masked server stderr. */
export class McpStdioLaunchError extends Error {
  constructor(
    readonly problem: McpStdioTestProblem,
    message: string,
    readonly output?: string,
  ) {
    super(message);
    this.name = "McpStdioLaunchError";
  }
}

export type NormalizedStdioInput = {
  command: string;
  args: string[];
  cwd?: string;
  env: Array<{ name: string; secret: boolean; value?: string }>;
};

/**
 * Validate a launch as submitted by Settings or a broker peer.
 *
 * Values are kept byte-for-byte apart from trimming the command, folder and
 * variable names: an argument with leading spaces is the operator's choice,
 * and nothing downstream reparses it.
 */
export function normalizeStdioLaunchInput(input: unknown): NormalizedStdioInput {
  const value = input && typeof input === "object" ? input as Partial<McpStdioLaunchInput> : {};
  const invalid = (message: string): never => {
    throw new McpStdioLaunchError("invalid", message);
  };
  const command = typeof value.command === "string" ? value.command.trim() : "";
  if (!command) invalid("Enter the command that starts the server.");
  if (command.length > MCP_STDIO_LIMITS.commandLength || command.includes("\0")) {
    invalid("That command is not a program name or path.");
  }
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
    invalid("Arguments must be a list of text values.");
  }
  const args = value.args as string[];
  if (args.length > MCP_STDIO_LIMITS.args) invalid(`A server can take at most ${MCP_STDIO_LIMITS.args} arguments.`);
  if (args.some((arg) => arg.length > MCP_STDIO_LIMITS.argLength || arg.includes("\0"))) {
    invalid("An argument is too long or contains a null character.");
  }
  let cwd: string | undefined;
  if (value.cwd !== undefined && value.cwd !== null) {
    if (typeof value.cwd !== "string") invalid("The working folder must be a path.");
    const trimmed = (value.cwd as string).trim();
    if (trimmed) {
      if (!path.isAbsolute(trimmed)) invalid("The working folder must be a full path.");
      cwd = trimmed;
    }
  }
  const rawEnv = value.env ?? [];
  if (!Array.isArray(rawEnv)) invalid("Environment variables must be a list.");
  if (rawEnv.length > MCP_STDIO_LIMITS.env) invalid(`A server can take at most ${MCP_STDIO_LIMITS.env} variables.`);
  const seen = new Set<string>();
  const env = rawEnv.map((entry) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!MCP_STDIO_ENV_NAME_PATTERN.test(name)) {
      invalid(`"${name || "(blank)"}" is not a valid variable name. Use letters, digits and underscores, not starting with a digit.`);
    }
    const key = process.platform === "win32" ? name.toUpperCase() : name;
    if (seen.has(key)) invalid(`${name} is listed twice.`);
    seen.add(key);
    const secret = record.secret === true;
    if (record.value !== undefined && typeof record.value !== "string") invalid(`${name} needs a text value.`);
    const text = record.value as string | undefined;
    if (text !== undefined && (text.length > MCP_STDIO_LIMITS.envValueLength || text.includes("\0"))) {
      invalid(`The value of ${name} is too long or contains a null character.`);
    }
    if (!secret && text === undefined) invalid(`${name} needs a value.`);
    return { name, secret, ...(text === undefined ? {} : { value: text }) };
  });
  return { command, args: [...args], ...(cwd ? { cwd } : {}), env };
}

/**
 * Turn what the operator typed into the absolute executable PwrAgent stores.
 *
 * A bare name is looked up on the login-shell PATH once, here; the stored
 * record holds the result, so a PATH change later cannot quietly substitute a
 * different program with the same name.
 */
export async function resolveStdioExecutable(
  command: string,
  searchEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const hasSeparator = command.includes("/") || command.includes("\\");
  if (hasSeparator && !path.isAbsolute(command)) {
    throw new McpStdioLaunchError(
      "invalid",
      `Enter a program name such as npx, or a full path. "${command}" is relative to no folder PwrAgent can know.`,
    );
  }
  const candidate = hasSeparator ? command : await resolveCommandOnPath(command, searchEnv, platform);
  const shown = path.basename(command);
  if (!candidate) {
    throw new McpStdioLaunchError(
      "not_found",
      `PwrAgent can't find ${shown} on this computer. Enter its full path instead.`,
    );
  }
  let info;
  try {
    info = await stat(candidate);
  } catch {
    throw new McpStdioLaunchError("not_found", `Nothing is at ${candidate}. Check the path, or enter a program name.`);
  }
  if (!info.isFile()) {
    throw new McpStdioLaunchError("not_executable", `${candidate} is a folder, not a program.`);
  }
  if (platform !== "win32" && !(await pathIsExecutable(candidate))) {
    throw new McpStdioLaunchError("not_executable", `${candidate} is not executable by your account.`);
  }
  return candidate;
}

/** Look a variable up the way the platform does: case-insensitively on Windows. */
function readEnv(source: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return source[name];
  const key = Object.keys(source).find((candidate) => candidate.toUpperCase() === name);
  return key ? source[key] : undefined;
}

/**
 * The complete environment a local command starts with: the allowlist above
 * read from PwrAgent's process, PATH from the login shell with the command's
 * own folder first, then the connection's variables, which win.
 */
export function buildStdioServerEnvironment(params: {
  processEnv: NodeJS.ProcessEnv;
  loginShellPath?: string;
  command: string;
  variables: Record<string, string>;
  platform?: NodeJS.Platform;
}): Record<string, string> {
  const platform = params.platform ?? process.platform;
  const env: Record<string, string> = {};
  for (const name of platform === "win32" ? INHERITED_WINDOWS : INHERITED_POSIX) {
    const value = readEnv(params.processEnv, name, platform);
    // A shell function exported into the environment is code, not data.
    if (value !== undefined && !value.startsWith("()")) env[name] = value;
  }
  const pathValue = params.loginShellPath ?? readEnv(params.processEnv, "PATH", platform);
  if (pathValue) env.PATH = pathValue;
  // The command's own folder first, so a `#!/usr/bin/env node` script finds
  // the runtime installed beside it. Uses `platform`'s path rules, not the
  // host's, like everything else here.
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (paths.isAbsolute(params.command)) {
    const directory = paths.dirname(params.command);
    const entries = env.PATH ? env.PATH.split(paths.delimiter) : [];
    const present = entries.some((entry) => platform === "win32"
      ? entry.toLowerCase() === directory.toLowerCase()
      : entry === directory);
    if (!present) env.PATH = [directory, ...entries].join(paths.delimiter);
  }
  for (const [name, value] of Object.entries(params.variables)) {
    if (platform === "win32") {
      for (const key of Object.keys(env)) {
        if (key.toUpperCase() === name.toUpperCase()) delete env[key];
      }
    }
    env[name] = value;
  }
  return env;
}

/** Replace every stored secret value in server output with a mask. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let masked = text;
  // Longest first, so a secret that contains another is masked whole.
  for (const secret of [...secrets].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length)) {
    masked = masked.split(secret).join(SECRET_MASK);
  }
  return masked;
}

function stripControlSequences(value: string): string {
  // ANSI CSI sequences and other C0 controls except tab and newline.
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** What PwrAgent launches, with its secrets already resolved. */
export type ResolvedStdioLaunch = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Values to mask wherever this server's output is shown. */
  secrets: string[];
};

type StdioChildProcess = OwnedChildProcess & {
  pid?: number;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
};

export type StdioSpawn = (command: string, args: string[], options: SpawnOptions) => StdioChildProcess;

/**
 * MCP over stdio, with PwrAgent owning the whole process tree.
 *
 * The SDK's `StdioClientTransport` signals only its direct child. `npx`,
 * `uvx` and `docker run` each start the real server as a grandchild, and on
 * macOS and Linux that grandchild outlives a SIGTERM sent to the wrapper. This
 * transport starts the server as the leader of its own process group and
 * stops the group, the same ownership the ACP and Codex transports use.
 */
export class OwnedStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private child?: StdioChildProcess;
  private readonly readBuffer = new ReadBuffer();
  private outputTail = "";
  private exit?: { code: number | null; signal: NodeJS.Signals | null };
  private closing?: Promise<void>;
  /** The group reap started when the server exited on its own. */
  private reaping?: Promise<void>;
  private closed = false;

  constructor(
    private readonly launch: ResolvedStdioLaunch,
    private readonly spawnProcess: StdioSpawn = spawn as unknown as StdioSpawn,
    private readonly hooks: { onSpawn?: () => void; onExit?: () => void } = {},
  ) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** The process's exit, once it has exited. */
  get exitStatus(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
    return this.exit;
  }

  /** The end of stderr, ANSI-stripped and with stored secrets masked. */
  output(): string {
    return maskSecrets(stripControlSequences(this.outputTail), this.launch.secrets).trim();
  }

  async start(): Promise<void> {
    if (this.child || this.closed) throw new Error("This MCP server transport was already started.");
    const invocation = createCommandInvocation({
      command: this.launch.command,
      args: this.launch.args,
      env: this.launch.env,
    });
    await new Promise<void>((resolve, reject) => {
      let child: StdioChildProcess;
      try {
        child = this.spawnProcess(invocation.command, invocation.args, {
          cwd: this.launch.cwd,
          env: this.launch.env,
          stdio: ["pipe", "pipe", "pipe"],
          // Leader of its own process group, so stopping it reaches every
          // descendant. Windows uses taskkill /T on the tree instead.
          detached: process.platform !== "win32",
          shell: false,
          windowsHide: true,
          ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });
      } catch (error) {
        reject(error);
        return;
      }
      this.child = child;
      let spawned = false;
      child.on("error", (error: Error) => {
        if (!spawned) {
          this.child = undefined;
          reject(error);
          return;
        }
        this.onerror?.(error);
      });
      (child as unknown as NodeJS.EventEmitter).once("spawn", () => {
        spawned = true;
        this.hooks.onSpawn?.();
        resolve();
      });
      child.on("close", () => {
        this.exit = { code: child.exitCode, signal: child.signalCode };
        if (spawned) this.hooks.onExit?.();
        if (this.child === child) this.child = undefined;
        // The leader is gone; anything it started may not be. Reap the group
        // before anyone treats this server as stopped.
        this.reaping = terminateOwnedProcessTree(child, {
          gracefulTimeoutMs: TERMINATE_GRACE_MS,
          forceTimeoutMs: FORCE_TERMINATE_MS,
        }).catch(() => undefined);
        this.onclose?.();
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        for (;;) {
          let message: JSONRPCMessage | null;
          try {
            message = this.readBuffer.readMessage();
          } catch (error) {
            this.onerror?.(error as Error);
            continue;
          }
          if (!message) break;
          this.onmessage?.(message);
        }
      });
      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on("data", (chunk: string | Buffer) => {
        const combined = this.outputTail + String(chunk);
        this.outputTail = combined.length > OUTPUT_TAIL_BYTES
          ? combined.slice(combined.length - OUTPUT_TAIL_BYTES)
          : combined;
      });
      child.stdin?.on("error", (error: Error) => this.onerror?.(error));
      child.stdout?.on("error", (error: Error) => this.onerror?.(error));
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || this.closed) throw new Error("The MCP server is not running.");
    await new Promise<void>((resolve, reject) => {
      const ok = stdin.write(serializeMessage(message), (error) => {
        if (error) reject(error);
      });
      if (ok) {
        resolve();
        return;
      }
      // A server that exits with this write still buffered never drains, so
      // the close has to settle the wait too.
      const settle = (error?: Error): void => {
        stdin.removeListener("drain", onDrain);
        stdin.removeListener("close", onClose);
        stdin.removeListener("error", settle);
        if (error) reject(error);
        else resolve();
      };
      const onDrain = (): void => settle();
      const onClose = (): void => settle(new Error("The MCP server stopped reading its input."));
      stdin.once("drain", onDrain);
      stdin.once("close", onClose);
      stdin.once("error", settle);
    });
  }

  /**
   * Stop the server: close stdin and give it a moment to exit on its own, as
   * the MCP stdio transport describes, then terminate the whole group.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.closing) return await this.closing;
    const child = this.child;
    this.closing = (async () => {
      // Already exited and being reaped: signalling its process group again
      // later could reach an unrelated group that reused the id.
      if (!child) {
        await this.reaping;
        return;
      }
      try {
        child.stdin?.end();
      } catch {
        // Already closed.
      }
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, STDIN_CLOSE_GRACE_MS);
          timer.unref?.();
          child.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      await terminateOwnedProcessTree(child, {
        gracefulTimeoutMs: TERMINATE_GRACE_MS,
        forceTimeoutMs: FORCE_TERMINATE_MS,
      });
    })();
    try {
      await this.closing;
    } finally {
      this.readBuffer.clear();
    }
  }
}

/** Describe why a server stopped before or during the MCP handshake. */
export function describeStdioStartFailure(params: {
  error: unknown;
  transport?: OwnedStdioClientTransport;
  displayName: string;
  command: string;
  timedOut: boolean;
}): McpStdioLaunchError {
  if (params.error instanceof McpStdioLaunchError) return params.error;
  const code = (params.error as NodeJS.ErrnoException | undefined)?.code;
  const output = params.transport?.output() || undefined;
  if (code === "ENOENT") {
    return new McpStdioLaunchError(
      "not_found",
      `${params.command} is no longer there. Edit ${params.displayName} and choose the program again.`,
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return new McpStdioLaunchError("not_executable", `${params.command} is not executable by your account.`);
  }
  if (code === "ENOTDIR" || code === "ENOEXEC") {
    return new McpStdioLaunchError("spawn_failed", `${params.command} could not be started (${code}).`);
  }
  const exit = params.transport?.exitStatus;
  if (exit) {
    const how = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? "unknown"}`;
    return new McpStdioLaunchError(
      "exited",
      `${params.displayName} exited before it answered (${how}).`,
      output,
    );
  }
  if (params.timedOut) {
    return new McpStdioLaunchError(
      "no_handshake",
      `${params.displayName} started but did not answer as an MCP server. Check that it speaks MCP over stdio; some servers need a flag such as --stdio.`,
      output,
    );
  }
  return new McpStdioLaunchError(
    "spawn_failed",
    `${params.displayName} could not be started.`,
    output,
  );
}

/** The stored launch with its folder defaulted and secrets substituted. */
export function resolveStdioLaunch(params: {
  launch: McpStdioLaunch;
  secretValues: Record<string, string>;
  processEnv: NodeJS.ProcessEnv;
  loginShellPath?: string;
  platform?: NodeJS.Platform;
}): ResolvedStdioLaunch {
  const variables = Object.create(null) as Record<string, string>;
  const secrets: string[] = [];
  for (const entry of params.launch.env) {
    if (entry.secret) {
      const value = Object.hasOwn(params.secretValues, entry.name)
        ? params.secretValues[entry.name]
        : undefined;
      if (value === undefined) {
        throw new McpStdioLaunchError(
          "secret_unavailable",
          `PwrAgent could not read the stored value of ${entry.name}. Edit this connection and enter it again.`,
        );
      }
      variables[entry.name] = value;
      secrets.push(value);
    } else {
      variables[entry.name] = entry.value ?? "";
    }
  }
  return {
    command: params.launch.command,
    args: [...params.launch.args],
    cwd: params.launch.cwd ?? homedir(),
    env: buildStdioServerEnvironment({
      processEnv: params.processEnv,
      ...(params.loginShellPath ? { loginShellPath: params.loginShellPath } : {}),
      command: params.launch.command,
      variables,
      ...(params.platform ? { platform: params.platform } : {}),
    }),
    secrets,
  };
}
