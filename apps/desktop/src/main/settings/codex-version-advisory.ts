import { realpath } from "node:fs/promises";
import {
  CODEX_MINIMUM_RECOMMENDED_VERSION,
  isCodexVersionBelowMinimum,
  parseCodexVersionCore,
} from "@pwragent/shared/codex-version";
import type {
  DesktopCodexCandidateSource,
  DesktopCodexInstaller,
  DesktopCodexVersionAdvisory,
} from "@pwragent/shared/contracts/settings";

export type CodexInstallerClassification = {
  installer: DesktopCodexInstaller;
  /** Shell command that updates this install, when the installer is one we can name. */
  upgradeCommand?: string;
  /**
   * The directory that owns the install, read from the same path that named
   * the installer: the Homebrew prefix, the npm prefix, `PNPM_HOME`, the bun
   * home (`~/.bun`), or the standalone `CODEX_HOME`. An update runs against
   * this root so it changes the Codex PwrAgent launches and not another one.
   * Absent when the path does not say.
   */
  installRoot?: string;
};

export const CODEX_STANDALONE_INSTALL_SH_URL = "https://chatgpt.com/codex/install.sh";
export const CODEX_STANDALONE_INSTALL_PS1_URL = "https://chatgpt.com/codex/install.ps1";

/** The command OpenAI documents for installing, and so updating, a standalone Codex. */
export function codexStandaloneUpgradeCommand(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `irm ${CODEX_STANDALONE_INSTALL_PS1_URL} | iex`
    : `curl -fsSL ${CODEX_STANDALONE_INSTALL_SH_URL} | sh`;
}

/**
 * The text before `marker` in `original`, in its own spelling. Matching runs
 * on a forward-slash copy, which has the same length, so the index carries
 * over and a Windows root keeps its backslashes.
 */
function rootBefore(
  original: string | undefined,
  marker: RegExp,
): string | undefined {
  if (!original) return undefined;
  const match = marker.exec(original.replaceAll("\\", "/"));
  if (!match || match.index === 0) return undefined;
  return original.slice(0, match.index);
}

/**
 * Who installed this Codex, from where its executable really lives. Homebrew and
 * the JavaScript package managers all leave a symlink or shim on PATH that
 * points somewhere recognizable, so the resolved path names the installer even
 * when the command the operator typed (`/opt/homebrew/bin/codex`, `~/.bun/bin/codex`)
 * does not. OpenAI's standalone installer keeps every release under
 * `$CODEX_HOME/packages/standalone/releases/` behind a `~/.local/bin/codex`
 * link, or on Windows behind `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`.
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
  /** Whether the command is OpenAI's Codex that PwrAgent installed and updates. */
  openAiInstalledByPwrAgent?: boolean;
  /** Picks the standalone installer's script. Defaults to this machine's. */
  platform?: NodeJS.Platform;
}): CodexInstallerClassification {
  if (params.openAiInstalledByPwrAgent) return { installer: "pwragent-openai" };
  if (params.managedByPwrAgent) return { installer: "pwragent" };
  const originals = [params.resolvedPath, params.command]
    .filter((entry): entry is string => Boolean(entry));
  const paths = originals.map((entry) => entry.replaceAll("\\", "/"));
  const has = (pattern: RegExp): boolean =>
    paths.some((entry) => pattern.test(entry));
  const root = (pattern: RegExp): string | undefined => {
    for (const original of originals) {
      const found = rootBefore(original, pattern);
      if (found) return found;
    }
    return undefined;
  };
  const withRoot = (
    classification: CodexInstallerClassification,
    installRoot: string | undefined,
  ): CodexInstallerClassification =>
    installRoot ? { ...classification, installRoot } : classification;
  if (has(/\/Caskroom\/codex\//u)) {
    return withRoot(
      { installer: "homebrew", upgradeCommand: "brew upgrade --cask codex" },
      root(/\/Caskroom\/codex\//u),
    );
  }
  if (has(/\/Cellar\/codex\//u)) {
    return withRoot(
      { installer: "homebrew", upgradeCommand: "brew upgrade codex" },
      root(/\/Cellar\/codex\//u),
    );
  }
  // Before the package managers: a standalone release can carry its own
  // `node_modules/@openai/codex` (the installer's legacy npm-tarball layout).
  const standaloneRoot = /\/packages\/standalone\//u;
  const standaloneBin = /\/Programs\/OpenAI\/Codex\/bin\//iu;
  if (has(standaloneRoot) || has(standaloneBin)) {
    return withRoot(
      {
        installer: "standalone",
        upgradeCommand: codexStandaloneUpgradeCommand(params.platform ?? process.platform),
      },
      root(standaloneRoot),
    );
  }
  // Order matters: bun and pnpm both keep an `@openai/codex` under a
  // `node_modules`, so their own roots have to be tested before the generic one.
  const bunRoot = /\/install\/global\/node_modules\/@openai\/codex\b/u;
  if (has(/\/\.bun\/install\/global\/node_modules\/@openai\/codex\b/u)) {
    return withRoot(
      { installer: "bun", upgradeCommand: "bun add -g @openai/codex@latest" },
      root(bunRoot),
    );
  }
  const pnpmRoot = /\/global\/[^/]+\/node_modules\/@openai\/codex\b/u;
  if (has(/\/pnpm\/global\/[^/]+\/node_modules\/@openai\/codex\b/u)) {
    return withRoot(
      { installer: "pnpm", upgradeCommand: "pnpm add -g @openai/codex@latest" },
      root(pnpmRoot),
    );
  }
  if (has(/\/node_modules\/@openai\/codex\b/u)) {
    // POSIX npm puts globals in `<prefix>/lib/node_modules`; Windows in
    // `<prefix>\node_modules`.
    return withRoot(
      { installer: "npm", upgradeCommand: "npm install -g @openai/codex@latest" },
      root(/\/lib\/node_modules\/@openai\/codex\b/u)
        ?? root(/\/node_modules\/@openai\/codex\b/u),
    );
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
  openAiInstalledByPwrAgent?: boolean;
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
    ...(params.managedByPwrAgent || params.openAiInstalledByPwrAgent
      ? {}
      : { resolvedPath: await resolvePath(command) }),
    ...(params.source ? { source: params.source } : {}),
    ...(params.managedByPwrAgent !== undefined
      ? { managedByPwrAgent: params.managedByPwrAgent }
      : {}),
    ...(params.openAiInstalledByPwrAgent !== undefined
      ? { openAiInstalledByPwrAgent: params.openAiInstalledByPwrAgent }
      : {}),
  });
  return {
    // The number, not `codex-cli 0.152.0`: it goes into a sentence.
    version: (parseCodexVersionCore(version) ?? []).join("."),
    minimumVersion: CODEX_MINIMUM_RECOMMENDED_VERSION,
    command,
    installer: classification.installer,
    ...(classification.upgradeCommand
      ? { upgradeCommand: classification.upgradeCommand }
      : {}),
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
