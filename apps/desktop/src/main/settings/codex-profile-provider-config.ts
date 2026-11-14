import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  codexModelProviderApiKeyEnv,
  isLoopbackCodexBaseUrl,
  LOCAL_CODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS,
  type CodexModelProviderSettings,
} from "@pwragent/shared";
import { isCodexTomlTable, parseCodexConfigToml } from "./codex-config-toml";

/**
 * Writes PwrAgent's Codex model providers into a Codex home PwrAgent manages
 * (`~/.codex/profiles/<name>`, which onboarding and Settings → Profiles
 * create), so the Codex CLI run on that home (`CODEX_HOME=… codex`) offers
 * the same providers as PwrAgent.
 *
 * PwrAgent itself still hands Codex these providers as launch overrides, which
 * also covers the shared `~/.codex` home. That home is the operator's and is
 * never edited here.
 *
 * Each PwrAgent profile owns one marked block of the file and nothing else,
 * so profiles that run on the same Codex home keep their own providers.
 * Every byte outside the block is the operator's, or another profile's. A
 * provider defined there is left alone. No key is ever written: a provider
 * with a key names the environment variable PwrAgent passes it in, which a
 * CLI session must export itself.
 */

const BLOCK_START = "# >>> PwrAgent model providers";
const BLOCK_END = "# <<< PwrAgent model providers";

/** One profile's block: its start line names the profile. */
function blockPattern(owner: string): RegExp {
  const start = `${escapeRegExp(BLOCK_START)} \\(profile ${escapeRegExp(owner)};`;
  return new RegExp(`${start}[^\\n]*\\n[\\s\\S]*?${escapeRegExp(BLOCK_END)} \\(profile ${escapeRegExp(owner)}\\)[^\\n]*(?:\\n|$)`, "u");
}

/**
 * `model_providers = { … }` before the first table header. Codex cannot
 * extend an inline table with `[model_providers.<id>]`, and rejects the
 * whole file if anything tries.
 */
function definesInlineModelProviders(text: string): boolean {
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*\[/u.test(line)) return false;
    if (/^\s*(?:model_providers|"model_providers"|'model_providers')\s*=/u.test(line)) return true;
  }
  return false;
}

export type ManagedProviderBlockResult = {
  text: string;
  /** Provider ids the block defines. */
  written: string[];
  /** Providers it leaves out, and why. */
  skipped: Array<{ id: string; reason: string }>;
};

/** A Codex home PwrAgent created: one directory under the Codex profile root. */
export function isPwrAgentManagedCodexHome(codexHome: string, profileRoot: string): boolean {
  const relative = path.relative(path.resolve(profileRoot), path.resolve(codexHome));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
    && !relative.includes(path.sep);
}

/** Replace, add or remove PwrAgent's block in a `config.toml` text. */
export function applyManagedProviderBlock(
  source: string,
  providers: readonly CodexModelProviderSettings[],
  providerIdsWithKeys: ReadonlySet<string>,
  owner: string,
): ManagedProviderBlockResult {
  const pattern = blockPattern(owner);
  const operatorText = removeBlock(source, pattern);
  if (definesInlineModelProviders(operatorText)) {
    const reason = "config.toml defines model_providers as an inline table, which Codex cannot extend.";
    return { text: operatorText, written: [], skipped: providers.map((provider) => ({ id: provider.id, reason })) };
  }
  let operatorProviders: ReadonlySet<string>;
  try {
    const tables = parseCodexConfigToml(operatorText).model_providers;
    operatorProviders = new Set(isCodexTomlTable(tables) ? Object.keys(tables) : []);
  } catch (error) {
    // Never edit a file Codex itself could not read either.
    const reason = `config.toml could not be read: ${error instanceof Error ? error.message : String(error)}`;
    return { text: source, written: [], skipped: providers.map((provider) => ({ id: provider.id, reason })) };
  }
  const skipped: ManagedProviderBlockResult["skipped"] = [];
  const included = providers.filter((provider) => {
    if (provider.compatibility) {
      skipped.push({ id: provider.id, reason: "It runs through PwrAgent's local compatibility bridge." });
      return false;
    }
    if (operatorProviders.has(provider.id)) {
      skipped.push({ id: provider.id, reason: "config.toml already defines this provider." });
      return false;
    }
    return true;
  });
  const block = included.length ? renderBlock(included, providerIdsWithKeys, owner) : "";
  return {
    text: insertBlock(source, operatorText, block, pattern),
    written: included.map((provider) => provider.id),
    skipped,
  };
}

/**
 * Bring a managed home's `config.toml` in line with the registered
 * providers. Does nothing for a home PwrAgent does not manage. Writes only
 * when the text changes, through a temporary file and a rename.
 */
export async function syncCodexProfileProviderConfig(params: {
  codexHome: string;
  profileRoot: string;
  /** The PwrAgent profile whose block this is. */
  owner: string;
  providers: readonly CodexModelProviderSettings[];
  providerIdsWithKeys: ReadonlySet<string>;
}): Promise<ManagedProviderBlockResult & { changed: boolean; managed: boolean; configPath: string }> {
  const configPath = path.join(params.codexHome, "config.toml");
  if (!isPwrAgentManagedCodexHome(params.codexHome, params.profileRoot)) {
    return { text: "", written: [], skipped: [], changed: false, managed: false, configPath };
  }
  let source = "";
  // A new file is private to the operator; an existing one keeps its mode.
  let mode = 0o600;
  try {
    source = await readFile(configPath, "utf8");
    mode = (await stat(configPath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const result = applyManagedProviderBlock(source, params.providers, params.providerIdsWithKeys, params.owner);
  if (result.text === source) return { ...result, changed: false, managed: true, configPath };
  await mkdir(params.codexHome, { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.pwragent-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporary, result.text, { encoding: "utf8", mode });
    await rename(temporary, configPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { ...result, changed: true, managed: true, configPath };
}

function renderBlock(
  providers: readonly CodexModelProviderSettings[],
  providerIdsWithKeys: ReadonlySet<string>,
  owner: string,
): string {
  const lines = [
    `${BLOCK_START} (profile ${owner}; written by PwrAgent, edits inside this block are replaced)`,
    "# A provider with env_key reads its API key from that environment variable.",
    "# PwrAgent sets it for its own Codex. Export it to use the provider from the Codex CLI.",
  ];
  for (const provider of providers) {
    lines.push(
      "",
      `[model_providers.${provider.id}]`,
      `name = ${tomlString(provider.name)}`,
      `base_url = ${tomlString(provider.baseUrl)}`,
      "wire_api = \"responses\"",
      "requires_openai_auth = false",
      ...(providerIdsWithKeys.has(provider.id)
        ? [`env_key = ${tomlString(codexModelProviderApiKeyEnv(provider.id))}`]
        : []),
      ...(isLoopbackCodexBaseUrl(provider.baseUrl)
        ? [`stream_idle_timeout_ms = ${LOCAL_CODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS}`]
        : []),
    );
  }
  lines.push(`${BLOCK_END} (profile ${owner})`);
  return `${lines.join("\n")}\n`;
}

function removeBlock(source: string, pattern: RegExp): string {
  const match = pattern.exec(source);
  if (!match) return source;
  let start = match.index;
  // The blank line PwrAgent puts before the block goes with it.
  if (start >= 2 && source[start - 1] === "\n" && source[start - 2] === "\n") start -= 1;
  return source.slice(0, start) + source.slice(match.index + match[0].length);
}

/** Put the block where it was, or at the end after a blank line. */
function insertBlock(source: string, operatorText: string, block: string, pattern: RegExp): string {
  const match = pattern.exec(source);
  if (match) {
    if (block) return source.slice(0, match.index) + block + source.slice(match.index + match[0].length);
    return operatorText;
  }
  if (!block) return source;
  if (!source) return block;
  return `${source}${source.endsWith("\n") ? "" : "\n"}\n${block}`;
}

/** A TOML basic string. JSON escapes are a subset TOML accepts. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
