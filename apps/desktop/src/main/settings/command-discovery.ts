import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type CommandDiscoveryCandidate<Source extends string> = {
  command: string;
  source: Source;
  executable: boolean;
  selected: boolean;
  version?: string;
  versionFailureReason?: string;
  failureReason?: string;
};

export type CommandDiscoverySnapshot<Source extends string> = {
  selectedCommand?: string;
  selectedSource?: Source;
  candidates: Array<CommandDiscoveryCandidate<Source>>;
  error?: string;
};

export type CommandDiscoveryInput<Source extends string> = {
  command: string | undefined;
  source: Source;
};

export type DiscoverCommandOptions<Source extends string> = {
  fixedCandidates: Array<CommandDiscoveryInput<Source>>;
  autoCandidates: Array<CommandDiscoveryInput<Source>>;
  env: NodeJS.ProcessEnv;
  versionArgs?: string[];
  parseVersion: (output: string) => string | undefined;
  compareVersions?: (left?: string, right?: string) => number;
  includeFailedAutoCandidates?: boolean | "if-none-executable";
};

export type ResolvedCommandCandidate<Source extends string> = {
  command: string;
  source: Source;
  version?: string;
};

function isNotFoundError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function pathExists(candidate: string): Promise<"exists" | "not_found" | "unknown"> {
  try {
    await access(candidate, fsConstants.F_OK);
    return "exists";
  } catch (error) {
    return isNotFoundError(error) ? "not_found" : "unknown";
  }
}

export async function pathIsExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
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
    return command;
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

async function readCommandVersion(params: {
  command: string;
  env: NodeJS.ProcessEnv;
  parseVersion: (output: string) => string | undefined;
  versionArgs: string[];
}): Promise<{
  ran: boolean;
  version?: string;
  failureReason?: string;
}> {
  try {
    const result = await execFile(params.command, params.versionArgs, {
      env: params.env,
      timeout: 2_000,
    });
    const output = `${result.stdout}\n${result.stderr ?? ""}`;
    const version = params.parseVersion(output);
    return {
      ran: true,
      version,
      failureReason: version ? undefined : "version_not_reported",
    };
  } catch (error) {
    return {
      ran: false,
      failureReason: isNotFoundError(error)
        ? "not_found"
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

export async function buildCommandDiscoveryCandidate<Source extends string>(
  candidate: CommandDiscoveryInput<Source>,
  options: {
    env: NodeJS.ProcessEnv;
    versionArgs?: string[];
    parseVersion: (output: string) => string | undefined;
  },
): Promise<CommandDiscoveryCandidate<Source> | undefined> {
  const trimmedCommand = candidate.command?.trim();
  if (!trimmedCommand) {
    return undefined;
  }

  const resolvedCommand =
    candidate.source === "path" || !trimmedCommand.includes(path.sep)
      ? await resolvePathCommand(trimmedCommand, options.env)
      : trimmedCommand;
  const existence = resolvedCommand ? await pathExists(resolvedCommand) : "not_found";
  const accessExecutable =
    resolvedCommand && existence !== "not_found"
      ? await pathIsExecutable(resolvedCommand)
      : false;
  const versionResult = resolvedCommand && existence !== "not_found"
    ? await readCommandVersion({
        command: resolvedCommand,
        env: options.env,
        parseVersion: options.parseVersion,
        versionArgs: options.versionArgs ?? ["--version"],
      })
    : { ran: false, failureReason: "not_found" };
  const executable = accessExecutable || versionResult.ran;

  return {
    command: resolvedCommand || trimmedCommand,
    source: candidate.source,
    executable,
    selected: false,
    version: versionResult.version,
    versionFailureReason: executable ? versionResult.failureReason : undefined,
    failureReason: executable
      ? undefined
      : existence === "not_found" || versionResult.failureReason === "not_found"
        ? "not_found"
        : "not_executable",
  };
}

export async function discoverCommands<Source extends string>(
  options: DiscoverCommandOptions<Source>,
): Promise<CommandDiscoverySnapshot<Source>> {
  const fixedCandidates = (
    await Promise.all(
      options.fixedCandidates.map((candidate) =>
        buildCommandDiscoveryCandidate(candidate, options),
      ),
    )
  ).filter((candidate): candidate is CommandDiscoveryCandidate<Source> =>
    Boolean(candidate),
  );

  const autoCandidates = dedupeCommandDiscoveryCandidates(
    await Promise.all(
      options.autoCandidates.map((candidate) =>
        buildCommandDiscoveryCandidate(candidate, options),
      ),
    )
  );

  const executableAutoCandidates = autoCandidates.filter((candidate) => candidate.executable);
  const includeFailedAutoCandidates =
    options.includeFailedAutoCandidates === "if-none-executable"
      ? executableAutoCandidates.length === 0
      : options.includeFailedAutoCandidates === true;
  const visibleAutoCandidates = autoCandidates
    .filter((candidate) => includeFailedAutoCandidates || candidate.executable)
    .sort((left, right) =>
      options.compareVersions
        ? options.compareVersions(right.version, left.version)
        : 0,
    );

  const candidates = [...fixedCandidates, ...visibleAutoCandidates];
  const selected =
    fixedCandidates.find((candidate) => candidate.source === "env" && candidate.executable)
    ?? fixedCandidates.find((candidate) => candidate.source === "config" && candidate.executable)
    ?? visibleAutoCandidates.find((candidate) => candidate.executable);

  if (selected) {
    selected.selected = true;
  }

  return {
    selectedCommand: selected?.command,
    selectedSource: selected?.source,
    candidates,
  };
}

function dedupeCommandDiscoveryCandidates<Source extends string>(
  candidates: Array<CommandDiscoveryCandidate<Source> | undefined>,
): Array<CommandDiscoveryCandidate<Source>> {
  const deduped: Array<CommandDiscoveryCandidate<Source>> = [];
  const indexByCommand = new Map<string, number>();

  for (const candidate of candidates) {
    if (!candidate) continue;

    const key = candidate.command;
    const existingIndex = indexByCommand.get(key);
    if (existingIndex === undefined) {
      indexByCommand.set(key, deduped.length);
      deduped.push(candidate);
      continue;
    }

    const existing = deduped[existingIndex];
    deduped[existingIndex] = mergeCommandDiscoveryCandidates(existing, candidate);
  }

  return deduped;
}

function mergeCommandDiscoveryCandidates<Source extends string>(
  existing: CommandDiscoveryCandidate<Source>,
  candidate: CommandDiscoveryCandidate<Source>,
): CommandDiscoveryCandidate<Source> {
  const preferred = choosePreferredCommandDiscoveryCandidate(existing, candidate);
  const fallback = preferred === existing ? candidate : existing;
  const executable = existing.executable || candidate.executable;

  return {
    command: preferred.command,
    source: preferred.source,
    executable,
    selected: existing.selected || candidate.selected,
    version: preferred.version ?? fallback.version,
    versionFailureReason:
      preferred.versionFailureReason ?? fallback.versionFailureReason,
    failureReason: executable
      ? undefined
      : (preferred.failureReason ?? fallback.failureReason),
  };
}

function choosePreferredCommandDiscoveryCandidate<Source extends string>(
  left: CommandDiscoveryCandidate<Source>,
  right: CommandDiscoveryCandidate<Source>,
): CommandDiscoveryCandidate<Source> {
  if (right.executable !== left.executable) {
    return right.executable ? right : left;
  }
  if (right.version && !left.version) {
    return right;
  }
  if (left.version && !right.version) {
    return left;
  }
  if (left.source === "path" && right.source !== "path") {
    return right;
  }
  return left;
}

export async function resolveDiscoveredCommand<Source extends string>(params: {
  command: string;
  fallbackSource: Source;
  discover: (configuredCommand?: string) => Promise<CommandDiscoverySnapshot<Source>>;
}): Promise<ResolvedCommandCandidate<Source>> {
  const configuredCommand =
    params.command.trim() && params.command.trim() !== path.basename(params.command.trim())
      ? params.command.trim()
      : params.command.trim() || undefined;
  const discovery = await params.discover(configuredCommand);
  const selected = discovery.candidates.find((candidate) => candidate.selected);

  return selected
    ? {
        command: selected.command,
        source: selected.source,
        version: selected.version,
      }
    : {
        command: params.command.trim() || path.basename(params.command),
        source: params.fallbackSource,
      };
}
