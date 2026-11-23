import { randomUUID } from "node:crypto";
import { constants, renameSync, rmSync, writeFileSync } from "node:fs";
import { access, lstat, readdir, readFile, readlink, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import { getMainLogger } from "../log.js";
import { isProcessIdAlive, type OwnedChildProcess } from "../process-tree.js";
import { isValidProfileName, resolveBootstrapProfileDir, resolvePwragentRoot } from "../profile.js";
import { ACP_AGENTS_ANTIGRAVITY_CLI_PATH_ENV } from "../settings/desktop-settings-env.js";
import { parseTomlTables } from "../settings/toml-editor.js";

const log = getMainLogger("pwragent:antigravity-managed-runtime");
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_PATTERN = /^([\d.]+)-[a-f0-9]{128}$/;
const STAGING_PATTERN = /^\.install-([1-9]\d*)-[a-zA-Z0-9]{6}$/;
const USE_MARKER_PATTERN = /^\.pwragent-use-(owner|child)-([1-9]\d*)-[a-f0-9-]{36}$/;

export const ANTIGRAVITY_ACTIVE_LINK = "active";
export const MANAGED_ANTIGRAVITY_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } as const;

export type ManagedAntigravityRuntime = {
  command: string;
  version: string;
};

export function managedAntigravityRoot(): string {
  return path.join(resolvePwragentRoot(), "agents", "antigravity");
}

export function isAntigravityVersion(value: string): boolean {
  return value.length <= 32 && value === value.trim() && VERSION_PATTERN.test(value);
}

function antigravityReleaseVersion(name: string): string | undefined {
  const version = RELEASE_PATTERN.exec(name)?.[1];
  return name === name.trim() && version && isAntigravityVersion(version) ? version : undefined;
}

function managedReleaseName(root: string, command: string): string | undefined {
  const [versions, name, executable, extra] = path.relative(root, command).split(path.sep);
  return versions === "versions" && name && executable === "agy" && extra === undefined
    && antigravityReleaseVersion(name) ? name : undefined;
}

export async function readActiveAntigravityRuntime(root: string): Promise<ManagedAntigravityRuntime | undefined> {
  try {
    const target = await readlink(path.join(root, ANTIGRAVITY_ACTIVE_LINK));
    const [versions, release, binary, extra] = target.split("/");
    const version = release && antigravityReleaseVersion(release);
    if (versions !== "versions" || binary !== "agy" || extra !== undefined || !version) {
      return undefined;
    }
    const command = path.join(root, target);
    const [rootInfo, versionsInfo, releaseInfo, binaryInfo] = await Promise.all([
      lstat(root),
      lstat(path.join(root, "versions")),
      lstat(path.dirname(command)),
      lstat(command),
    ]);
    if (rootInfo.isDirectory() && versionsInfo.isDirectory() && releaseInfo.isDirectory()
      && binaryInfo.isFile() && (binaryInfo.mode & 0o100) !== 0) {
      return { command, version };
    }
  } catch (error) {
    if (!["ENOENT", "EINVAL", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
  return undefined;
}

type CommandEnvironment = { env?: NodeJS.ProcessEnv; cwd?: string };

/** Resolve the executable as a POSIX probe or launch would. A relative PATH
 * entry can surface as a bare command, for example when the entry is ".". */
export async function resolveAntigravityCommandPath(
  command: string,
  environment?: CommandEnvironment,
): Promise<string | undefined> {
  return await resolveCommandPath(command, environment).catch(() => undefined);
}

async function resolveCommandPath(
  command: string,
  { env = process.env, cwd = process.cwd() }: CommandEnvironment = {},
): Promise<string | undefined> {
  // Keep ".." for the filesystem to resolve after following any symlinks.
  const fromCwd = (entry: string) => path.isAbsolute(entry) ? entry : `${cwd}${path.sep}${entry}`;
  if (path.basename(command) !== command) {
    return await realpath(fromCwd(command)).catch(missingPath);
  }
  for (const directory of (env.PATH ?? "/usr/bin:/bin").split(path.delimiter)) {
    const candidate = fromCwd(directory ? `${directory}${path.sep}${command}` : command);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "ELOOP", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
    }
  }
  return undefined;
}

function missingPath(error: NodeJS.ErrnoException): undefined {
  if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code ?? "")) throw error;
  return undefined;
}

export async function isManagedAntigravityCommand(command: string, environment?: CommandEnvironment): Promise<boolean> {
  const root = await realpath(managedAntigravityRoot()).catch(() => undefined);
  const target = root && await resolveAntigravityCommandPath(command, environment);
  return Boolean(root && target && managedReleaseName(root, target));
}

/** Recognize a saved alias even if its target was just pruned. */
async function resolveSelectedPath(command: string): Promise<string | undefined> {
  const target = await resolveCommandPath(command);
  if (target || path.basename(command) === command) return target;
  const absolute = path.isAbsolute(command) ? command : `${process.cwd()}${path.sep}${command}`;
  async function followMissing(file: string, remaining: number): Promise<string | undefined> {
    const resolved = await realpath(file).catch(missingPath);
    if (resolved || remaining === 0) return resolved;
    const parent = path.dirname(file);
    if (parent === file) return undefined;
    const link = await readlink(file).catch((error: NodeJS.ErrnoException) =>
      error.code === "EINVAL" ? undefined : missingPath(error),
    );
    if (link !== undefined) {
      return await followMissing(path.isAbsolute(link) ? link : `${parent}${path.sep}${link}`, remaining - 1);
    }
    const directory = await followMissing(parent, remaining - 1);
    return directory && path.join(directory, path.basename(file));
  }
  return await followMissing(absolute, 40);
}

/** Publication, selecting a managed path, spawning it, and pruning all use
 * the same lock. Downloads and ACP verification run in PID-owned staging. */
export async function withAntigravityRuntimeLock<T>(
  root: string,
  operation: (assertLocked: () => void) => Promise<T>,
): Promise<T> {
  let compromise: Error | undefined;
  const unlock = await lock(path.join(await realpath(root), "activate"), {
    realpath: false,
    stale: 60_000,
    retries: { retries: 20, minTimeout: 25, maxTimeout: 25 },
    onCompromised: (error) => { compromise = error; },
  });
  try {
    return await operation(() => {
      if (compromise) throw compromise;
    });
  } finally {
    await unlock().catch(() => log.warn("Could not release the Antigravity runtime lock"));
  }
}

export async function writeAntigravitySelection<T>(command: string, write: () => T): Promise<T> {
  const root = managedAntigravityRoot();
  const canonicalRoot = await realpath(root).catch(missingPath);
  if (!canonicalRoot) return write();
  return await withAntigravityRuntimeLock(root, async (assertLocked) => {
    const selected = command.trim();
    const target = selected && await resolveSelectedPath(selected).catch(() => undefined);
    if (target && managedReleaseName(canonicalRoot, target) && !await realpath(target).catch(missingPath)) {
      throw new Error("The selected managed Antigravity release is no longer installed.");
    }
    assertLocked();
    return write();
  });
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Resolve an alias to the executable we actually spawn. Publish the hold
 * before unlocking so another installer cannot prune between lookup and exec. */
export async function spawnWithAntigravityRuntimeHold<T extends OwnedChildProcess>(
  command: string,
  environment: CommandEnvironment,
  start: (command: string, managed: boolean) => T,
  assertOpen: () => void,
  useActiveIfMissing?: boolean,
): Promise<T> {
  const root = managedAntigravityRoot();
  const rootInfo = await lstat(root).catch(missingPath);
  if (!rootInfo?.isDirectory()) {
    assertOpen();
    return start(command, false);
  }
  return await withAntigravityRuntimeLock(root, async (assertLocked) => {
    const canonicalRoot = await realpath(root);
    const resolved = await resolveAntigravityCommandPath(command, environment);
    const active = !resolved && useActiveIfMissing ? await readActiveAntigravityRuntime(root) : undefined;
    const commandPath = resolved ?? (active && await realpath(active.command));
    const name = commandPath && managedReleaseName(canonicalRoot, commandPath);
    const staged = commandPath && path.basename(commandPath) === "agy"
      && path.dirname(path.dirname(commandPath)) === canonicalRoot
      && STAGING_PATTERN.test(path.basename(path.dirname(commandPath)));
    assertOpen();
    assertLocked();
    if (!commandPath || (!name && !staged)) return start(command, false);

    const directory = path.dirname(commandPath);
    const token = randomUUID();
    let marker = path.join(directory, `.pwragent-use-owner-${process.pid}-${token}`);
    writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
    const removeMarker = () => {
      try {
        rmSync(marker, { force: true });
      } catch {
        // The next prune can collect a marker after its process exits.
      }
    };
    let child: T;
    try {
      child = start(commandPath, Boolean(name));
    } catch (error) {
      removeMarker();
      throw error;
    }
    if (child.pid) {
      const childMarker = path.join(directory, `.pwragent-use-child-${child.pid}-${token}`);
      try {
        renameSync(marker, childMarker);
        marker = childMarker;
      } catch {
        log.warn("Could not transfer the Antigravity runtime hold to the ACP process");
      }
    }
    child.once("close", () => {
      // The ACP parent may exit while a process-per-session child is alive.
      if (!child.pid || !processGroupAlive(child.pid)) removeMarker();
    });
    return child;
  });
}

async function directoryEntries(directory: string) {
  return await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

async function selectedReleases(root: string): Promise<Set<string>> {
  const canonicalRoot = await realpath(root);
  const profiles = path.join(resolvePwragentRoot(), "profiles");
  const configDirs = (await directoryEntries(profiles))
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && isValidProfileName(entry.name))
    .map(({ name }) => path.join(profiles, name));
  configDirs.push(resolveBootstrapProfileDir());
  const selections = new Set<string>();
  const protect = async (command: string | undefined) => {
    if (!command?.trim()) return;
    const target = await resolveSelectedPath(command.trim());
    const name = target && managedReleaseName(canonicalRoot, target);
    if (name) selections.add(name);
  };
  await protect(process.env[ACP_AGENTS_ANTIGRAVITY_CLI_PATH_ENV]);
  for (const directory of configDirs) {
    const file = path.join(directory, "config.toml");
    const source = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (source === undefined) continue;
    const tables = parseTomlTables(source, file, { requiredValuePaths: ["acp_agents.antigravity.cli_path"] });
    const command = tables["acp_agents.antigravity"]?.cli_path;
    if (typeof command === "string") await protect(command);
  }
  return selections;
}

async function hasLiveHold(directory: string): Promise<boolean> {
  let live = false;
  for (const entry of await directoryEntries(directory)) {
    const marker = entry.isFile() && USE_MARKER_PATTERN.exec(entry.name);
    if (!marker) continue;
    const pid = Number(marker[2]);
    if (isProcessIdAlive(pid) || (marker[1] === "child" && processGroupAlive(pid))) {
      live = true;
    } else {
      await rm(path.join(directory, entry.name), { force: true });
    }
  }
  return live;
}

/** Called under the publication lock after a verified release is active. */
export async function pruneAntigravityRuntime(
  root: string,
  activeCommand: string,
  previousCommand: string | undefined,
  assertLocked: () => void,
): Promise<void> {
  for (const entry of await directoryEntries(root)) {
    const owner = entry.isDirectory() && STAGING_PATTERN.exec(entry.name);
    // Older installers used unowned staging names. Age cannot prove that
    // their download or verifier stopped, so leave those directories alone.
    if (!owner || isProcessIdAlive(Number(owner[1])) || await hasLiveHold(path.join(root, entry.name))) continue;
    assertLocked();
    await rm(path.join(root, entry.name), { recursive: true, force: true });
  }

  const versions = path.join(root, "versions");
  if (!(await lstat(versions).catch(missingPath))?.isDirectory()) return;
  const keep = await selectedReleases(root);
  const activeName = path.basename(path.dirname(activeCommand));
  const previousName = previousCommand && path.basename(path.dirname(previousCommand));
  assertLocked();
  await hasLiveHold(path.join(versions, activeName));
  const inactive: Array<{ name: string; publishedAt: number }> = [];
  for (const entry of await directoryEntries(versions)) {
    if (!entry.isDirectory() || !antigravityReleaseVersion(entry.name)
      || entry.name === activeName) continue;
    const binary = await lstat(path.join(versions, entry.name, "agy")).catch(missingPath);
    inactive.push({ name: entry.name, publishedAt: binary?.isFile() ? binary.ctimeMs : -1 });
  }
  // Keep one recently published inactive release for clients on builds that
  // predate process holds and for discovery snapshots crossing publication.
  if (previousName && previousName !== activeName) {
    keep.add(previousName);
  } else {
    inactive.sort((left, right) => right.publishedAt - left.publishedAt || right.name.localeCompare(left.name));
    if (inactive[0] && inactive[0].publishedAt >= 0) keep.add(inactive[0].name);
  }
  for (const { name } of inactive) {
    const directory = path.join(versions, name);
    if (await hasLiveHold(directory) || keep.has(name)) continue;
    assertLocked();
    await rm(directory, { recursive: true, force: true });
  }
}
