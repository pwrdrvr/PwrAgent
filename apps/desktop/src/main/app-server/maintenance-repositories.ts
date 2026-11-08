import Database from "better-sqlite3";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { runGitCommand } from "./git-executable";
import type { MaintenanceDiscoveryProgress } from "./unreferenced-worktrees";

/** Repository hints only, never authorization to remove a checkout. Read
 * PwrAgent's own metadata across profiles; never open provider storage. */
export async function maintenanceRepositoryHints(
  pwragentHome: string,
  onProgress?: (progress: MaintenanceDiscoveryProgress) => void,
): Promise<{ paths: string[]; incomplete: boolean }> {
  const paths = new Set<string>();
  let incomplete = false;
  const add = (value: unknown) => { if (typeof value === "string" && path.isAbsolute(value)) paths.add(path.normalize(value)); };
  const directories = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) if (entry && typeof entry === "object") { add(entry.path); add(entry.worktreePath); }
  };
  const profilesRoot = path.join(pwragentHome, "profiles");
  let profiles;
  try { profiles = await readdir(profilesRoot, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { paths: [], incomplete: false }; throw error; }
  for (const profile of profiles) {
    if (!profile.isDirectory() || profile.isSymbolicLink()) continue;
    const state = path.join(profilesRoot, profile.name, "state");
    onProgress?.({ detail: "Reading repository hints from PwrAgent profiles", root: state, found: paths.size });
    const databasePath = path.join(state, "state.db");
    let database: Database.Database | undefined;
    try {
      if (!(await lstat(databasePath)).isFile()) continue;
      database = new Database(databasePath, { readonly: true, fileMustExist: true });
      const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
      if (tables.has("directory_overlay")) for (const row of database.prepare("SELECT directory_key FROM directory_overlay").all() as { directory_key: string }[]) add(row.directory_key);
      if (tables.has("threads")) for (const row of database.prepare("SELECT json_extract(payload, '$.extraLinkedDirectories') AS directories FROM threads").all() as { directories: string | null }[]) {
        if (row.directories) directories(JSON.parse(row.directories));
      }
      if (tables.has("acp_sessions")) for (const row of database.prepare("SELECT json_extract(payload, '$.cwd') AS cwd FROM acp_sessions").all() as { cwd: string | null }[]) add(row.cwd);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true; }
    finally { database?.close(); }
    try {
      for (const file of await readdir(path.join(state, "claude"), { withFileTypes: true })) {
        if (!file.isFile() || !/^[0-9a-f-]{36}\.json$/i.test(file.name)) continue;
        const value = JSON.parse(await readFile(path.join(state, "claude", file.name), "utf8"));
        add(value.cwd); directories(value.thread?.linkedDirectories);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true; }
  }
  return { paths: [...paths], incomplete };
}

/** One registration read per repository, independently of how many current
 * or historical thread directories name it. Missing historical paths do not
 * prevent finding a repository through another surviving checkout. */
export async function resolveMaintenanceRepositories(
  hints: readonly string[],
  onProgress?: (progress: MaintenanceDiscoveryProgress) => void,
): Promise<string[]> {
  const repositories = new Set<string>();
  const paths = [...new Set(hints)];
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < paths.length) {
      const cwd = paths[next++]!;
      onProgress?.({ detail: "Resolving repository registrations", root: cwd, found: repositories.size });
      try {
        if (!(await lstat(cwd)).isDirectory()) continue;
        const { stdout } = await runGitCommand(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 10_000 });
        const common = stdout.trim();
        if (path.isAbsolute(common)) repositories.add(path.normalize(path.basename(common) === ".git" ? path.dirname(common) : common));
      } catch { /* Historical paths and non-Git directories are only hints. */ }
    }
  }));
  // A workspace often contains repositories that have no surviving thread
  // record. Their Git registrations and build caches still occupy disk.
  for (const parent of new Set([...repositories].map((repo) => path.dirname(repo)))) {
    let entries;
    try { entries = await readdir(parent, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const repo = path.join(parent, entry.name);
      if (repositories.has(repo)) continue;
      try {
        const marker = await lstat(path.join(repo, ".git"));
        if (!marker.isFile() && !marker.isDirectory()) continue;
        const { stdout } = await runGitCommand(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 10_000 });
        const common = stdout.trim();
        if (path.isAbsolute(common)) repositories.add(path.normalize(path.basename(common) === ".git" ? path.dirname(common) : common));
      } catch { /* A sibling is an optional repository hint. */ }
    }
  }
  return [...repositories];
}
