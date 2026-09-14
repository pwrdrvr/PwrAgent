import path from "node:path";
import type { LinkedDirectorySummary } from "@pwragent/shared";
import { resolveWorktreeRepositoryDirectory as probe } from "./private/directory-probe";
import { GitReadCache } from "./read-cache";

const cache = new GitReadCache<LinkedDirectorySummary | undefined>({ ttlMs: 5_000 });

export function resolveWorktreeRepositoryDirectory(cwd: string): Promise<LinkedDirectorySummary | undefined> {
  const key = path.resolve(cwd);
  return cache.read(key, () => probe(key));
}
