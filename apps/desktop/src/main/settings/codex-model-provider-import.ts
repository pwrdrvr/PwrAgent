/**
 * Find model providers that Codex config files already define, so Settings
 * → Codex → Model providers can offer to import them.
 *
 * Only `config.toml` is read, in the active Codex home and in each Codex auth
 * profile home Settings lists. The main process picks those paths itself; the
 * renderer cannot name a file. Key material stays in the file: an `env_key`
 * is reported by name only, and a bearer token or header value is never
 * copied into a candidate.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  CODEX_MODEL_PROVIDER_MODEL_LIMIT,
  isLoopbackCodexBaseUrl,
  validateCodexBaseUrl,
  type CodexModelProviderImportCandidate,
  type CodexModelProviderImportScan,
  type CodexModelProviderImportSkip,
  type CodexModelProviderImportSource,
  type DesktopCodexAuthProfileDiscoverySnapshot,
} from "@pwragent/shared";
import {
  CodexConfigTomlError,
  isCodexTomlTable,
  parseCodexConfigToml,
  type CodexTomlTable,
} from "./codex-config-toml";

/** A Codex home whose `config.toml` may define providers. */
export type CodexConfigHome = {
  codexHome: string;
  /** The auth profile's display name, or `Codex home`. */
  label: string;
};

const MAX_CONFIG_BYTES = 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/** The active Codex home first, then every profile home, each once. */
export function codexConfigHomesFromProfiles(
  snapshot: DesktopCodexAuthProfileDiscoverySnapshot,
): CodexConfigHome[] {
  const homes: CodexConfigHome[] = [];
  const add = (codexHome: string, label: string) => {
    if (codexHome && !homes.some((home) => home.codexHome === codexHome)) {
      homes.push({ codexHome, label });
    }
  };
  const active = snapshot.profiles.find((profile) => profile.codexHome === snapshot.effectiveCodexHome);
  add(snapshot.effectiveCodexHome, active?.displayName || "Codex home");
  for (const profile of snapshot.profiles) {
    if (profile.exists) add(profile.codexHome, profile.displayName || profile.name);
  }
  return homes;
}

export async function scanCodexModelProviderImports(
  homes: readonly CodexConfigHome[],
): Promise<CodexModelProviderImportScan> {
  // One endpoint found in several files is one candidate.
  const candidates = new Map<string, CodexModelProviderImportCandidate>();
  const skipped = new Map<string, CodexModelProviderImportSkip>();
  const addSkip = (skip: CodexModelProviderImportSkip) => {
    const key = `${skip.sourceId ?? ""}\n${skip.reason}`;
    const existing = skipped.get(key);
    if (existing) {
      existing.sources.push(...skip.sources);
    } else {
      skipped.set(key, skip);
    }
  };
  for (const home of homes) {
    const source = { label: home.label, configPath: path.join(home.codexHome, "config.toml") };
    const read = await readConfig(source.configPath);
    if (read.kind === "missing") continue;
    if (read.kind === "error") {
      addSkip({ reason: read.reason, sources: [source] });
      continue;
    }
    for (const entry of codexModelProviderImportsFromConfig(read.config, source)) {
      if ("reason" in entry) {
        addSkip(entry);
        continue;
      }
      const existing = candidates.get(entry.baseUrl);
      if (!existing) {
        candidates.set(entry.baseUrl, entry);
        continue;
      }
      existing.sources.push(...entry.sources);
      existing.models = [...new Set([...existing.models, ...entry.models])]
        .slice(0, CODEX_MODEL_PROVIDER_MODEL_LIMIT);
      existing.needsApiKey ||= entry.needsApiKey;
      existing.apiKeyEnv ??= entry.apiKeyEnv;
      existing.notes = [...new Set([...existing.notes, ...entry.notes])];
    }
  }
  return { candidates: [...candidates.values()], skipped: [...skipped.values()] };
}

async function readConfig(configPath: string): Promise<
  | { kind: "missing" }
  | { kind: "error"; reason: string }
  | { kind: "config"; config: CodexTomlTable }
> {
  let text: string;
  try {
    const info = await stat(configPath);
    if (!info.isFile()) return { kind: "missing" };
    if (info.size > MAX_CONFIG_BYTES) {
      return { kind: "error", reason: "Its config.toml is larger than 1 MiB, so it was not read." };
    }
    text = await readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "error", reason: `Its config.toml could not be read (${code ?? "unknown error"}).` };
  }
  try {
    return { kind: "config", config: parseCodexConfigToml(text) };
  } catch (error) {
    const detail = error instanceof CodexConfigTomlError ? error.message : "it is not valid TOML";
    return { kind: "error", reason: `Its config.toml could not be parsed: ${detail}.` };
  }
}

/** The import candidates and skips one parsed Codex config defines. */
export function codexModelProviderImportsFromConfig(
  config: CodexTomlTable,
  source: CodexModelProviderImportSource,
): Array<CodexModelProviderImportCandidate | CodexModelProviderImportSkip> {
  const providers = config.model_providers;
  if (providers === undefined) return [];
  if (!isCodexTomlTable(providers)) {
    return [{ reason: "Its model_providers setting is not a table.", sources: [source] }];
  }
  const modelsByProvider = profileModelsByProvider(config);
  return Object.entries(providers).map(([sourceId, entry]) => {
    const skip = (reason: string, name?: string): CodexModelProviderImportSkip => ({
      sourceId,
      ...(name ? { name } : {}),
      reason,
      sources: [source],
    });
    if (!isCodexTomlTable(entry)) return skip("Its entry is not a table.");
    const name = (typeof entry.name === "string" ? entry.name.trim().slice(0, 60) : "") || sourceId;
    const wireApi = entry.wire_api;
    // Codex 0.164 dropped `chat`. An absent wire_api means responses.
    if (wireApi !== undefined && wireApi !== "responses") {
      return skip(
        `It uses wire_api = ${JSON.stringify(String(wireApi))}. Codex 0.164 and later speak only the Responses API.`,
        name,
      );
    }
    if (typeof entry.base_url !== "string" || !entry.base_url.trim()) {
      return skip("It has no base_url.", name);
    }
    if (hasUrlCredentials(entry.base_url)) {
      return skip("Its base_url holds credentials, which are not copied.", name);
    }
    let baseUrl: string;
    try {
      baseUrl = validateCodexBaseUrl(entry.base_url);
    } catch (error) {
      return skip(`Its base_url cannot be used. ${error instanceof Error ? error.message : ""}`.trim(), name);
    }
    if (isCodexTomlTable(entry.query_params) && Object.keys(entry.query_params).length > 0) {
      return skip("It sends query_params, which a PwrAgent provider cannot send.", name);
    }
    if (entry.aws !== undefined) {
      return skip("It signs requests with AWS credentials, which a PwrAgent provider cannot do.", name);
    }
    if (entry.gateway_oauth !== undefined) {
      return skip("It signs in with gateway OAuth, which a PwrAgent provider cannot do.", name);
    }
    const envKey = typeof entry.env_key === "string" && ENV_NAME.test(entry.env_key.trim())
      ? entry.env_key.trim()
      : undefined;
    const hasBearerToken = entry.experimental_bearer_token !== undefined;
    const usesOpenAiAuth = entry.requires_openai_auth === true;
    const usesAuthCommand = entry.auth !== undefined;
    const notes: string[] = [];
    if (hasBearerToken) notes.push("The file's bearer token is not copied.");
    if (usesAuthCommand) notes.push("Its auth command is not run.");
    if (usesOpenAiAuth) notes.push("It signed in with the OpenAI account. Here it needs an API key.");
    if (entry.http_headers !== undefined || entry.env_http_headers !== undefined) {
      notes.push("Its HTTP headers are not imported.");
    }
    return {
      sourceId,
      name,
      baseUrl,
      models: modelsByProvider.get(sourceId) ?? [],
      local: isLoopbackCodexBaseUrl(baseUrl),
      needsApiKey: Boolean(envKey) || hasBearerToken || usesOpenAiAuth || usesAuthCommand,
      ...(envKey ? { apiKeyEnv: envKey } : {}),
      notes,
      sources: [source],
    };
  });
}

function hasUrlCredentials(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

/**
 * The models a config runs on each provider: the top-level `model`, and
 * each `[profiles.<name>]` model. A profile without `model_provider` uses
 * the top-level one, as Codex does.
 */
function profileModelsByProvider(config: CodexTomlTable): Map<string, string[]> {
  const models = new Map<string, string[]>();
  const topProvider = typeof config.model_provider === "string" ? config.model_provider : undefined;
  const add = (provider: unknown, model: unknown) => {
    if (typeof provider !== "string" || typeof model !== "string") return;
    const id = model.trim();
    if (!id || id.length > 256 || /[\0\r\n]/u.test(id) || id.startsWith("@")) return;
    const list = models.get(provider) ?? [];
    if (!list.includes(id) && list.length < CODEX_MODEL_PROVIDER_MODEL_LIMIT) list.push(id);
    models.set(provider, list);
  };
  add(topProvider, config.model);
  if (isCodexTomlTable(config.profiles)) {
    for (const profile of Object.values(config.profiles)) {
      if (isCodexTomlTable(profile)) add(profile.model_provider ?? topProvider, profile.model);
    }
  }
  return models;
}
