import { realpath } from "node:fs/promises";
import type {
  DesktopCodexCandidateSource,
  DesktopCodexInstaller,
  DesktopCodexVersionAdvisory,
} from "@pwragent/shared";

/**
 * The oldest Codex that offers the GPT-6-Sol family (GPT-6-Sol, GPT-6.1-Sol and
 * later). An older Codex runs fine but never lists those models, so the
 * operator sees a picker that is quietly missing the newest ones.
 */
export const CODEX_MINIMUM_RECOMMENDED_VERSION = "0.155.0";

const VERSION_CORE = /(\d+)\.(\d+)\.(\d+)/u;

/**
 * The `major.minor.patch` inside a version string, ignoring any prerelease or
 * build suffix. `codex --version` prints `codex-cli 0.152.0`, and discovery
 * may hand back either that or the bare number.
 *
 * A prerelease of the minimum (`0.155.0-alpha.2`) compares equal to it. That is
 * deliberate: the alphas are cut from the same line the release ships from, and
 * warning a developer on one that their Codex is old would be wrong more often
 * than right.
 */
export function parseCodexVersionCore(
  version: string | undefined,
): [number, number, number] | undefined {
  const match = version ? VERSION_CORE.exec(version) : null;
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** False when the version does not parse: unknown is not old. */
export function isCodexVersionBelowMinimum(
  version: string | undefined,
  minimum: string = CODEX_MINIMUM_RECOMMENDED_VERSION,
): boolean {
  const actual = parseCodexVersionCore(version);
  const floor = parseCodexVersionCore(minimum);
  if (!actual || !floor) return false;
  for (let index = 0; index < 3; index += 1) {
    const delta = (actual[index] ?? 0) - (floor[index] ?? 0);
    if (delta !== 0) return delta < 0;
  }
  return false;
}

export type CodexInstallerClassification = {
  installer: DesktopCodexInstaller;
  /** Shell command that updates this install, when the installer is one we can name. */
  upgradeCommand?: string;
};

/**
 * Who installed this Codex, from where its executable really lives. Homebrew and
 * the JavaScript package managers all leave a symlink or shim on PATH that
 * points somewhere recognizable, so the resolved path names the installer even
 * when the command the operator typed (`/opt/homebrew/bin/codex`, `~/.bun/bin/codex`)
 * does not.
 *
 * Only an install this recognizes gets a command. Anything else gets none: a
 * wrong `brew upgrade` for a binary Homebrew never installed would fail
 * confusingly, and an operator who knows how they installed Codex knows how to
 * update it.
 */
export function classifyCodexInstaller(params: {
  command: string;
  resolvedPath?: string;
  source?: DesktopCodexCandidateSource;
  /** Whether the command is the build PwrAgent downloaded and manages itself. */
  managedByPwrAgent?: boolean;
}): CodexInstallerClassification {
  if (params.managedByPwrAgent) return { installer: "pwragent" };
  const paths = [params.resolvedPath, params.command]
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.replaceAll("\\", "/"));
  const has = (pattern: RegExp): boolean =>
    paths.some((entry) => pattern.test(entry));
  if (has(/\/Caskroom\/codex\//u)) {
    return { installer: "homebrew", upgradeCommand: "brew upgrade --cask codex" };
  }
  if (has(/\/Cellar\/codex\//u)) {
    return { installer: "homebrew", upgradeCommand: "brew upgrade codex" };
  }
  // Order matters: bun and pnpm both keep an `@openai/codex` under a
  // `node_modules`, so their own roots have to be tested before the generic one.
  if (has(/\/\.bun\/install\/global\/node_modules\/@openai\/codex\b/u)) {
    return { installer: "bun", upgradeCommand: "bun add -g @openai/codex@latest" };
  }
  if (has(/\/pnpm\/global\/[^/]+\/node_modules\/@openai\/codex\b/u)) {
    return { installer: "pnpm", upgradeCommand: "pnpm add -g @openai/codex@latest" };
  }
  if (has(/\/node_modules\/@openai\/codex\b/u)) {
    return { installer: "npm", upgradeCommand: "npm install -g @openai/codex@latest" };
  }
  if (params.source === "application") return { installer: "application" };
  return { installer: "unknown" };
}

/**
 * The advisory to show for the Codex PwrAgent will launch, or `undefined` when
 * it is new enough or its version is unknown.
 */
export async function buildCodexVersionAdvisory(params: {
  command: string | undefined;
  version: string | undefined;
  source?: DesktopCodexCandidateSource;
  managedByPwrAgent?: boolean;
  /** Injected so tests need no real filesystem. */
  resolvePath?: (command: string) => Promise<string | undefined>;
}): Promise<DesktopCodexVersionAdvisory | undefined> {
  const { command, version } = params;
  if (!command || !version || !isCodexVersionBelowMinimum(version)) {
    return undefined;
  }
  const resolvePath = params.resolvePath ?? defaultResolvePath;
  const classification = classifyCodexInstaller({
    command,
    ...(params.managedByPwrAgent
      ? {}
      : { resolvedPath: await resolvePath(command) }),
    ...(params.source ? { source: params.source } : {}),
    ...(params.managedByPwrAgent !== undefined
      ? { managedByPwrAgent: params.managedByPwrAgent }
      : {}),
  });
  return {
    // The number, not `codex-cli 0.152.0`: it goes into a sentence.
    version: (parseCodexVersionCore(version) ?? []).join("."),
    minimumVersion: CODEX_MINIMUM_RECOMMENDED_VERSION,
    command,
    ...classification,
  };
}

async function defaultResolvePath(command: string): Promise<string | undefined> {
  try {
    return await realpath(command);
  } catch {
    // A bare `codex` resolved through PATH, or a path that has since gone.
    return undefined;
  }
}
