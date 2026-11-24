import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  isClaudeGatewaySignInFinished,
  type ClaudeGatewaySignInProgress,
  type ClaudeGatewaySignInQuestion,
  type ClaudeGatewaySignInStep,
} from "@pwragent/shared/contracts/claude-gateway";

/**
 * Claude Code reads a developer-named gateway for sign-in only from its user
 * settings: `forceLoginMethod: "gateway"` with `forceLoginGatewayUrl`. The
 * saved gateway sign-in then serves every session, whatever these keys say.
 */
export const CLAUDE_GATEWAY_METHOD_KEY = "forceLoginMethod";
export const CLAUDE_GATEWAY_URL_KEY = "forceLoginGatewayUrl";

/** The first bundled Claude Code verified to drive `auth login --gateway-json`. */
const GATEWAY_SIGN_IN_MIN_VERSION = "2.1.330";

export function supportsClaudeGatewaySignIn(version: string | undefined): boolean {
  if (!version) return false;
  const have = version.split(".").map(Number);
  const need = GATEWAY_SIGN_IN_MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

export function claudeUserSettingsPath(env: NodeJS.ProcessEnv, homeDir = os.homedir()): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDir, ".claude");
  return path.join(configDir, "settings.json");
}

/**
 * The form Claude Code compares answers against: origin plus path, no
 * trailing slash. Only http(s), and nothing a token could hide in.
 */
export function normalizeClaudeGatewayUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter the gateway's full URL, starting with https://.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The gateway URL must start with https:// or http://.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Enter the gateway URL without a user name, query, or fragment.");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export class ClaudeSettingsFileError extends Error {}

function parseSettingsObject(text: string | undefined, file: string): Record<string, unknown> {
  if (text === undefined || !text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ClaudeSettingsFileError(`${file} is not valid JSON. Fix it, then try again.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ClaudeSettingsFileError(`${file} does not hold a JSON object. Fix it, then try again.`);
  }
  return parsed as Record<string, unknown>;
}

/** The gateway Claude Code signs in to, when its user settings name one. */
export function claudeGatewayUrlFromSettings(text: string | undefined): string | undefined {
  let settings: Record<string, unknown>;
  try {
    settings = parseSettingsObject(text, "settings.json");
  } catch {
    return undefined;
  }
  const url = settings[CLAUDE_GATEWAY_URL_KEY];
  return settings[CLAUDE_GATEWAY_METHOD_KEY] === "gateway" && typeof url === "string" && url.trim()
    ? url.trim()
    : undefined;
}

/**
 * Sets (a URL) or clears (`undefined`) the gateway in Claude Code's settings
 * text. Every other key keeps its value. Clearing removes the keys only while
 * they still name a gateway sign-in, so a method someone changed since stays.
 */
export function applyClaudeGatewaySetting(text: string | undefined, url: string | undefined, file = "settings.json"): string {
  const settings = parseSettingsObject(text, file);
  if (url !== undefined) {
    settings[CLAUDE_GATEWAY_METHOD_KEY] = "gateway";
    settings[CLAUDE_GATEWAY_URL_KEY] = url;
  } else if (settings[CLAUDE_GATEWAY_METHOD_KEY] === "gateway") {
    delete settings[CLAUDE_GATEWAY_METHOD_KEY];
    delete settings[CLAUDE_GATEWAY_URL_KEY];
  }
  return `${JSON.stringify(settings, null, 2)}\n`;
}

async function readOptionalFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readClaudeGatewayUrl(file: string): Promise<string | undefined> {
  return claudeGatewayUrlFromSettings(await readOptionalFile(file).catch(() => undefined));
}

/** Rewrites Claude Code's settings file atomically, keeping its mode. */
export async function writeClaudeGatewaySetting(file: string, url: string | undefined): Promise<void> {
  const before = await readOptionalFile(file);
  if (before === undefined && url === undefined) return;
  const after = applyClaudeGatewaySetting(before, url, file);
  if (after === before) return;
  await mkdir(path.dirname(file), { recursive: true });
  const mode = await stat(file).then((info) => info.mode & 0o777, () => undefined);
  const temporary = `${file}.pwragent-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, after, { encoding: "utf8", mode: mode ?? 0o600 });
  if (mode !== undefined) await chmod(temporary, mode);
  await rename(temporary, file);
}

const MAX_TEXT = 2_000;

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : undefined;
}

function webUrl(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One line of `--gateway-json` output, as a step PwrAgent can show. Anything
 * unrecognised is `undefined`; strings are capped and links must be web URLs.
 */
export function parseClaudeGatewayLine(line: string): ClaudeGatewaySignInStep | undefined {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const fields = message as Record<string, unknown>;
  switch (fields.state) {
    case "connecting":
    case "saving":
    case "done":
    case "cancelled":
      return { state: fields.state };
    case "url_input":
    case "trust_prompt":
    case "confirm_account": {
      // Claude Code checks an answer's `shown` against its own exactly.
      if (typeof fields.shown !== "string" || !fields.shown || fields.shown.length > MAX_TEXT) return undefined;
      const question: ClaudeGatewaySignInQuestion = { state: fields.state, shown: fields.shown };
      for (const key of ["title", "detail", "shownLabel", "confirmLabel", "cancelLabel"] as const) {
        const value = text(fields[key]);
        if (value) question[key] = value;
      }
      return question;
    }
    case "polling": {
      const step: Extract<ClaudeGatewaySignInStep, { state: "polling" }> = { state: "polling" };
      const detail = text(fields.detail);
      const userCode = text(fields.userCode);
      const verificationUri = webUrl(fields.verificationUri);
      const browserUrl = webUrl(fields.browserUrl);
      if (detail) step.detail = detail;
      if (userCode) step.userCode = userCode.slice(0, 64);
      if (verificationUri) step.verificationUri = verificationUri;
      if (browserUrl) step.browserUrl = browserUrl;
      return step;
    }
    case "error": {
      const detail = text(fields.detail);
      return {
        state: "error",
        message: text(fields.message) ?? "Gateway sign-in failed.",
        ...(detail ? { detail } : {}),
      };
    }
    default:
      return undefined;
  }
}

export type ClaudeGatewaySpawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string },
) => ChildProcessWithoutNullStreams;

const defaultSpawn: ClaudeGatewaySpawn = (command, args, options) => {
  // A script fixture or an npm install runs under Electron's own Node.
  const isScript = /\.(c?js|mjs)$/i.test(command);
  return spawnProcess(isScript ? process.execPath : command, [...(isScript ? [command] : []), ...args], {
    env: isScript ? { ...options.env, ELECTRON_RUN_AS_NODE: "1" } : options.env,
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
};

/**
 * Claude Code refuses this sign-in inside one of its own sessions. PwrAgent
 * launched from a Claude Code terminal must not pass that marker on.
 */
export function claudeGatewaySignInEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    const upper = key.toUpperCase();
    if (upper === "CLAUDECODE" || upper === "CLAUDE_CODE_CHILD_SESSION") delete result[key];
  }
  return result;
}

const SIGN_IN_LIMIT_MS = 15 * 60_000;
const WAIT_LIMIT_MS = 25_000;

/**
 * One run of `claude auth login --gateway-json`. Claude Code writes a JSON
 * line per step and reads `{state, shown, accept}` answers on stdin. The URL
 * question is answered here: the operator just asked to sign in to that URL.
 * The trust and account questions wait for the operator.
 */
export class ClaudeGatewaySignInSession {
  readonly id = randomUUID();
  private revision = 0;
  private step: ClaudeGatewaySignInStep = { state: "connecting" };
  private waiters: Array<() => void> = [];
  private child: ChildProcessWithoutNullStreams | undefined;
  private stderrTail = "";
  private openedBrowserUrl: string | undefined;
  private readonly limit: ReturnType<typeof setTimeout>;
  readonly finished: Promise<ClaudeGatewaySignInStep>;
  private finish!: (step: ClaudeGatewaySignInStep) => void;

  constructor(private readonly options: {
    executable: string;
    env: NodeJS.ProcessEnv;
    /** Normalised with `normalizeClaudeGatewayUrl`. */
    url: string;
    openExternal: (url: string) => Promise<void> | void;
    spawn?: ClaudeGatewaySpawn;
    homeDir?: string;
    limitMs?: number;
  }) {
    this.finished = new Promise((resolve) => { this.finish = resolve; });
    this.limit = setTimeout(() => {
      this.fail("Gateway sign-in took too long. Try again.");
    }, options.limitMs ?? SIGN_IN_LIMIT_MS);
    this.limit.unref?.();
  }

  start(): void {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.options.spawn ?? defaultSpawn)(this.options.executable, ["auth", "login", "--gateway-json"], {
        env: claudeGatewaySignInEnvironment(this.options.env),
        cwd: this.options.homeDir ?? os.homedir(),
      });
    } catch {
      this.fail("Claude Code could not start the gateway sign-in.");
      return;
    }
    this.child = child;
    child.stdin.on("error", () => {});
    child.on("error", () => this.fail("Claude Code could not start the gateway sign-in."));
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-MAX_TEXT);
    });
    child.on("close", () => {
      if (isClaudeGatewaySignInFinished(this.step)) return;
      // Claude Code explains a refused start on stderr, such as a machine
      // whose managed settings forbid a gateway named in user settings.
      const reason = this.stderrTail.trim().split(/\r?\n/).filter(Boolean).at(-1);
      this.fail("Claude Code stopped before the gateway sign-in finished.", reason);
    });
  }

  progress(): ClaudeGatewaySignInProgress {
    return { id: this.id, revision: this.revision, step: this.step };
  }

  async wait(after: number, limitMs = WAIT_LIMIT_MS): Promise<ClaudeGatewaySignInProgress> {
    if (this.revision > after || isClaudeGatewaySignInFinished(this.step)) return this.progress();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, limitMs);
      timer.unref?.();
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.waiters.push(done);
    });
    return this.progress();
  }

  /** Accepts the question shown at `revision`; anything else is ignored. */
  answer(revision: number): boolean {
    const step = this.step;
    if (revision !== this.revision) return false;
    if (step.state !== "url_input" && step.state !== "trust_prompt" && step.state !== "confirm_account") return false;
    return this.write(step);
  }

  async openBrowser(): Promise<void> {
    if (this.step.state !== "polling") return;
    const url = this.step.browserUrl ?? this.step.verificationUri;
    if (url) await this.options.openExternal(url);
  }

  cancel(): void {
    if (isClaudeGatewaySignInFinished(this.step)) return;
    this.settle({ state: "cancelled" });
    this.stop();
  }

  private receive(line: string): void {
    if (isClaudeGatewaySignInFinished(this.step)) return;
    const step = parseClaudeGatewayLine(line);
    if (!step) return;
    if (step.state === "url_input" && step.shown === this.options.url) {
      // Answered for the operator, who pressed Sign in with this URL shown.
      this.write(step);
      return;
    }
    if (step.state === "cancelled" || step.state === "done" || step.state === "error") {
      this.settle(step);
      return;
    }
    this.publish(step);
    if (step.state === "polling") {
      // In JSON mode Claude Code leaves opening the page to the host.
      const url = step.browserUrl ?? step.verificationUri;
      if (url && url !== this.openedBrowserUrl) {
        this.openedBrowserUrl = url;
        void Promise.resolve(this.options.openExternal(url)).catch(() => {});
      }
    }
  }

  private write(question: ClaudeGatewaySignInQuestion): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    stdin.write(`${JSON.stringify({ state: question.state, shown: question.shown, accept: true })}\n`);
    return true;
  }

  private publish(step: ClaudeGatewaySignInStep): void {
    this.step = step;
    this.revision += 1;
    for (const wake of this.waiters.splice(0)) wake();
  }

  private settle(step: ClaudeGatewaySignInStep): void {
    clearTimeout(this.limit);
    this.publish(step);
    this.finish(step);
    if (step.state !== "done") this.stop();
    else this.child?.stdin.end();
  }

  private fail(message: string, detail?: string): void {
    if (isClaudeGatewaySignInFinished(this.step)) return;
    this.settle({ state: "error", message, ...(detail ? { detail: detail.slice(0, MAX_TEXT) } : {}) });
  }

  private stop(): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // Closing stdin cancels the sign-in in Claude Code; the signal is a backstop.
    child.stdin.end();
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }, 2_000);
    timer.unref?.();
  }
}
