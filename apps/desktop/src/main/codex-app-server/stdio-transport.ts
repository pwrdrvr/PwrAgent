import {
  execFile as execFileCallback,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import type { JsonRpcTransport } from "./json-rpc";
import { getMainLogger } from "../log";

const execFile = promisify(execFileCallback);
const codexTransportLog = getMainLogger("pwragnt:codex-transport");
const CODEX_COMMAND_OVERRIDE_ENV = "PWRAGNT_CODEX_COMMAND";

export type StdioJsonRpcTransportOptions = {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
};

type CodexCommandCandidate = {
  command: string;
  source: "override" | "path" | "codex-app" | "explicit";
  version?: string;
};

async function pathIsExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, 0o111);
    return true;
  } catch {
    return false;
  }
}

async function resolvePathCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (command.includes(path.sep)) {
    return (await pathIsExecutable(command)) ? command : undefined;
  }

  try {
    const result = await execFile("/usr/bin/which", [command], {
      env,
      timeout: 2_000,
    });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readCodexVersion(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const result = await execFile(command, ["--version"], {
      env,
      timeout: 2_000,
    });
    const match = result.stdout.trim().match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function parseVersion(value?: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
} | undefined {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    return undefined;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      if (leftNumber !== rightNumber) {
        return Math.sign(leftNumber - rightNumber);
      }
      continue;
    }
    if (leftNumber !== undefined) {
      return -1;
    }
    if (rightNumber !== undefined) {
      return 1;
    }
    if (leftPart !== rightPart) {
      return leftPart.localeCompare(rightPart);
    }
  }

  return 0;
}

export function compareCodexCliVersions(left?: string, right?: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion && !rightVersion) {
    return 0;
  }
  if (!leftVersion) {
    return -1;
  }
  if (!rightVersion) {
    return 1;
  }

  for (const key of ["major", "minor", "patch"] as const) {
    if (leftVersion[key] !== rightVersion[key]) {
      return Math.sign(leftVersion[key] - rightVersion[key]);
    }
  }

  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function getCodexAppCandidatePaths(): string[] {
  return [
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(os.homedir(), "Applications/Codex.app/Contents/Resources/codex"),
  ];
}

async function buildCandidate(
  command: string | undefined,
  source: CodexCommandCandidate["source"],
  env: NodeJS.ProcessEnv,
): Promise<CodexCommandCandidate | undefined> {
  if (!command?.trim()) {
    return undefined;
  }

  const resolvedCommand =
    source === "path" ? await resolvePathCommand(command.trim(), env) : command.trim();
  if (!resolvedCommand || !(await pathIsExecutable(resolvedCommand))) {
    return undefined;
  }

  return {
    command: resolvedCommand,
    source,
    version: await readCodexVersion(resolvedCommand, env),
  };
}

async function resolveCodexCommand(params: {
  command: string;
  env: NodeJS.ProcessEnv;
}): Promise<CodexCommandCandidate> {
  const override = params.env[CODEX_COMMAND_OVERRIDE_ENV]?.trim();
  if (override) {
    const candidate = await buildCandidate(override, "override", params.env);
    if (candidate) {
      return candidate;
    }
  }

  const command = params.command.trim() || "codex";
  if (command !== "codex") {
    return (
      (await buildCandidate(command, "explicit", params.env)) ?? {
        command,
        source: "explicit",
      }
    );
  }

  const candidates = (
    await Promise.all([
      buildCandidate(command, "path", params.env),
      ...getCodexAppCandidatePaths().map((candidatePath) =>
        buildCandidate(candidatePath, "codex-app", params.env),
      ),
    ])
  ).filter((candidate): candidate is CodexCommandCandidate => Boolean(candidate));

  return (
    candidates.sort(
      (left, right) => compareCodexCliVersions(right.version, left.version),
    )[0] ?? { command, source: "path" }
  );
}

export class StdioJsonRpcTransport implements JsonRpcTransport {
  private childProcess: ChildProcessWithoutNullStreams | null = null;
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;

  constructor(private readonly options: StdioJsonRpcTransportOptions) {}

  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.childProcess) {
      return;
    }

    const env = this.options.env ?? process.env;
    const command = await resolveCodexCommand({
      command: this.options.command,
      env,
    });
    codexTransportLog.info("launch app-server", {
      command: command.command,
      source: command.source,
      version: command.version ?? null,
    });

    const child = spawn(command.command, ["app-server", ...(this.options.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("codex app server stdio pipes unavailable");
    }

    this.childProcess = child;

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line: string) => {
      this.messageHandler(line);
    });

    child.stderr.on("data", () => undefined);
    child.on("error", (error: Error) => {
      this.closeHandler(error);
    });
    child.on("close", () => {
      this.childProcess = null;
      this.closeHandler();
    });
  }

  async close(): Promise<void> {
    const child = this.childProcess;
    this.childProcess = null;
    if (!child) {
      return;
    }
    child.kill();
  }

  send(message: string): void {
    const child = this.childProcess;
    if (!child?.stdin) {
      throw new Error("codex app server stdio not connected");
    }
    child.stdin.write(`${message}\n`);
  }
}
