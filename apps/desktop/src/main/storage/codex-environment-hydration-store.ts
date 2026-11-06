import { createHash } from "node:crypto";
import type { StateDb } from "../state/state-db";

const CACHE_META_KEY = "codex_environment_hydration_cache_v1";
const MAX_CACHE_ENTRIES = 100;

export type CodexEnvironmentHydrationCacheEntry = {
  key: string;
  environmentId: string;
  sourcePath?: string;
  cwd?: string;
  setupScriptHash: string;
  shellEnvironment: Record<string, string>;
  updatedAt: number;
};

export type CodexEnvironmentHydrationCacheLookup = {
  environmentId: string;
  sourcePath?: string;
  cwd?: string;
  setupScript?: string;
};

type CachePayload = {
  version: 1;
  entries: CodexEnvironmentHydrationCacheEntry[];
};

export interface CodexEnvironmentHydrationStoreLike {
  get(
    params: CodexEnvironmentHydrationCacheLookup,
  ): CodexEnvironmentHydrationCacheEntry | undefined;
  set(params: {
    environmentId: string;
    sourcePath?: string;
    cwd?: string;
    setupScript?: string;
    shellEnvironment: Record<string, string>;
    updatedAt?: number;
  }): CodexEnvironmentHydrationCacheEntry;
}

export class CodexEnvironmentHydrationStore
  implements CodexEnvironmentHydrationStoreLike
{
  constructor(private readonly stateDb: StateDb) {}

  get(
    params: CodexEnvironmentHydrationCacheLookup,
  ): CodexEnvironmentHydrationCacheEntry | undefined {
    const key = buildCodexEnvironmentHydrationCacheKey(params);
    return this.readPayload().entries.find((entry) => entry.key === key);
  }

  set(params: {
    environmentId: string;
    sourcePath?: string;
    cwd?: string;
    setupScript?: string;
    shellEnvironment: Record<string, string>;
    updatedAt?: number;
  }): CodexEnvironmentHydrationCacheEntry {
    const payload = this.readPayload();
    const key = buildCodexEnvironmentHydrationCacheKey(params);
    const entry: CodexEnvironmentHydrationCacheEntry = {
      key,
      environmentId: params.environmentId,
      sourcePath: params.sourcePath,
      cwd: params.cwd,
      setupScriptHash: hashText(params.setupScript ?? ""),
      shellEnvironment: params.shellEnvironment,
      updatedAt: params.updatedAt ?? Date.now(),
    };
    const entries = [
      entry,
      ...payload.entries.filter((candidate) => candidate.key !== key),
    ].slice(0, MAX_CACHE_ENTRIES);
    this.stateDb.setMeta(
      CACHE_META_KEY,
      JSON.stringify({
        version: 1,
        entries,
      } satisfies CachePayload),
    );
    return entry;
  }

  private readPayload(): CachePayload {
    const raw = this.stateDb.getMeta(CACHE_META_KEY);
    if (!raw) {
      return { version: 1, entries: [] };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CachePayload>;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        return { version: 1, entries: [] };
      }
      return {
        version: 1,
        entries: parsed.entries.filter(isValidCacheEntry),
      };
    } catch {
      return { version: 1, entries: [] };
    }
  }
}

export function buildCodexEnvironmentHydrationCacheKey(
  params: CodexEnvironmentHydrationCacheLookup,
): string {
  return hashText(
    [
      params.environmentId,
      params.sourcePath ?? "",
      params.cwd ?? "",
      hashText(params.setupScript ?? ""),
    ].join("\0"),
  );
}

function isValidCacheEntry(
  value: unknown,
): value is CodexEnvironmentHydrationCacheEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CodexEnvironmentHydrationCacheEntry>;
  return (
    typeof candidate.key === "string" &&
    typeof candidate.environmentId === "string" &&
    typeof candidate.setupScriptHash === "string" &&
    typeof candidate.updatedAt === "number" &&
    Boolean(candidate.shellEnvironment) &&
    typeof candidate.shellEnvironment === "object"
  );
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
