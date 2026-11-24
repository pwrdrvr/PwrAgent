import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getConfiguredGitCommand, getSelectedManagedGit } from "../git-command";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { gitCommandPreference } from "../git-runtime";
import { runPrMetadataFileProbe, runPrMetadataGit, SharedPrMetadataRead, type PrMetadataDemand } from "./pr-metadata-process";

const REF_FILE_BYTES = 4096;
const PACKED_REFS_BYTES = 256 * 1024;
const MAX_REMOTES = 16;
const MAX_SYMREF_DEPTH = 4;

type QueuedRemoteHead = {
  env: NodeJS.ProcessEnv;
  preference: string | undefined;
  managedGit: string | undefined;
  pending: SharedPrMetadataRead<string | undefined>;
};
const queuedRemoteHeads = new Map<string, Set<QueuedRemoteHead>>();

/** Share a fallback probe only until admission, before it can observe Git state. */
export async function readGitRemoteHead(cwd: string, remote: string, demand?: PrMetadataDemand): Promise<string | undefined> {
  demand?.signal?.throwIfAborted();
  const env = buildPwrAgentChildProcessEnv(process.env);
  const probe = async (currentDemand?: PrMetadataDemand, onAdmitted?: () => void) => {
    try {
      const { stdout } = await runPrMetadataGit(cwd, [
        "symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`,
      ], { purpose: "pr-discovery", env, maxBuffer: 64 * 1024, timeout: 2_000 }, currentDemand, onAdmitted);
      return stdout.trim();
    } catch {
      currentDemand?.signal?.throwIfAborted();
      return undefined;
    }
  };
  if (!path.isAbsolute(cwd)) return await probe(demand);

  // Use the exact path passed to Git. Worktrees can share refs and still
  // resolve the same short name differently. Both readers must also have
  // requested the same Git environment.
  const key = JSON.stringify([cwd, remote]);
  const preference = gitCommandPreference(env);
  const managedGit = preference ? undefined : getSelectedManagedGit();
  const queued = queuedRemoteHeads.get(key) ?? new Set<QueuedRemoteHead>();
  for (const existing of queued) {
    if (!existing.pending.signal.aborted && existing.preference === preference
      && existing.managedGit === managedGit && isDeepStrictEqual(existing.env, env)) {
      return await existing.pending.read(demand);
    }
  }
  const remove = () => {
    if (queued.delete(entry) && queued.size === 0) queuedRemoteHeads.delete(key);
  };
  const pending = new SharedPrMetadataRead(async (sharedDemand) => {
    try {
      return await probe(sharedDemand, remove);
    } finally {
      remove();
    }
  });
  const entry = { env, preference, managedGit, pending };
  queued.add(entry);
  queuedRemoteHeads.set(key, queued);
  return await pending.read(demand);
}

async function fileStatus(file: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(file, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameFile(a?: BigIntStats, b?: BigIntStats): boolean {
  if (!a || !b) return a === b;
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
    && a.uid === b.uid && a.gid === b.gid && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs && a.size === b.size;
}

/** A single observation of the loose and packed files used in a ref answer. */
class RefFiles {
  private readonly observed = new Map<string, Promise<BigIntStats | undefined>>();
  private readonly directories = new Map<string, { resolved: string; info: BigIntStats }>();

  constructor(private readonly signal: AbortSignal) {}

  status(file: string): Promise<BigIntStats | undefined> {
    this.signal.throwIfAborted();
    let found = this.observed.get(file);
    if (!found) {
      found = fileStatus(file);
      this.observed.set(file, found);
    }
    return found;
  }

  async directory(target: string): Promise<string> {
    this.signal.throwIfAborted();
    const resolved = await realpath(target);
    const info = await fileStatus(resolved);
    if (!info?.isDirectory()) throw new Error("Unrecognized Git checkout directory");
    this.directories.set(target, { resolved, info });
    return resolved;
  }

  async text(file: string, info: BigIntStats, limit = REF_FILE_BYTES): Promise<string> {
    this.signal.throwIfAborted();
    if (!info.isFile() || info.size > limit) throw new Error("Unrecognized Git ref file");
    // A racing replacement must not turn a bounded regular-file read into a
    // symlink traversal or a blocking read of a pipe or device.
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameFile(info, await handle.stat({ bigint: true }))) throw new Error("Git ref file changed");
      const buffer = Buffer.alloc(Number(info.size) + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== Number(info.size)) throw new Error("Git ref file changed");
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async refStatus(root: string, ref: string): Promise<BigIntStats | undefined> {
    let current = root;
    const parts = ref.split("/");
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const info = await this.status(current);
      if (!info || info.isFile()) return undefined;
      if (!info.isDirectory()) throw new Error("Unrecognized Git ref parent");
    }
    return await this.status(path.join(current, parts.at(-1)!));
  }

  async unchanged(signal: AbortSignal): Promise<boolean> {
    for (const [target, { resolved, info }] of this.directories) {
      signal.throwIfAborted();
      if (await realpath(target) !== resolved) return false;
      const current = await fileStatus(resolved);
      // Git checks worktree ownership. Directory timestamps also change when
      // unrelated files are created, so compare identity and access metadata.
      if (!current?.isDirectory() || current.dev !== info.dev || current.ino !== info.ino
        || current.uid !== info.uid || current.gid !== info.gid || current.mode !== info.mode) return false;
    }
    for (const [file, info] of this.observed) {
      signal.throwIfAborted();
      if (!sameFile(await info, await fileStatus(file))) return false;
    }
    return true;
  }
}

function safeRef(ref: string): boolean {
  return !ref.includes("..") && ref.split("/").every((part) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && !part.endsWith(".") && !part.endsWith(".lock"));
}

type CheckoutLocation = { directory: string; gitDir: string; commonDir: string; gitDirLink?: string };

async function locateRefs(cwd: string, files: RefFiles): Promise<CheckoutLocation | undefined> {
  const directory = await files.directory(cwd);
  const dotGit = path.join(directory, ".git");
  const dotGitInfo = await files.status(dotGit);
  if (!dotGitInfo) return undefined;
  if (dotGitInfo.isDirectory()) return { directory, gitDir: dotGit, commonDir: dotGit };
  if (!dotGitInfo.isFile()) return undefined;
  const gitDirLink = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await files.text(dotGit, dotGitInfo))?.[1];
  if (!gitDirLink) return undefined;
  const gitDir = await files.directory(path.resolve(directory, gitDirLink));
  const commonDir = path.resolve(gitDir, "../..");
  const worktrees = path.dirname(gitDir);
  if (worktrees !== path.join(commonDir, "worktrees")) return undefined;
  if (!(await files.status(commonDir))?.isDirectory() || !(await files.status(worktrees))?.isDirectory()
    || !(await files.status(gitDir))?.isDirectory()) return undefined;
  const commonLink = path.join(gitDir, "commondir");
  const commonLinkInfo = await files.status(commonLink);
  if (!commonLinkInfo || !/^\.\.\/\.\.\r?\n?$/.test(await files.text(commonLink, commonLinkInfo))) return undefined;
  return { directory, gitDir, commonDir, gitDirLink };
}

/** Observe the inputs to Git's checkout discovery and config hierarchy. */
export async function observePrCheckoutConfigFiles(cwd: string, configPaths: string[]) {
  return await runPrMetadataFileProbe(async (signal) => {
    const files = new RefFiles(signal);
    const location = await locateRefs(cwd, files);
    if (!location) return undefined;
    const { commonDir, gitDir, gitDirLink } = location;
    // An ordinary checkout must keep resolving its own metadata directory.
    // A gitdir link crossing parent components can follow intermediate symlinks.
    if (gitDirLink?.split("/").includes("..")
      || gitDir === commonDir && await files.status(path.join(gitDir, "commondir"))) return undefined;
    if (!(await files.status(path.join(gitDir, "HEAD")))?.isFile()
      || !(await files.status(path.join(commonDir, "objects")))?.isDirectory()
      || !(await files.status(path.join(commonDir, "refs")))?.isDirectory()) return undefined;
    // Native URL resolution can also read these legacy remote definitions.
    if (await files.status(path.join(commonDir, "remotes")) || await files.status(path.join(commonDir, "branches"))) return undefined;
    const paths = new Set([...configPaths, path.join(commonDir, "config"), path.join(gitDir, "config.worktree")]);
    for (const file of paths) {
      const info = await files.status(file);
      if (info && !info.isFile()) return undefined;
    }
    return { ...location, paths, unchanged: () => runPrMetadataFileProbe((currentSignal) => files.unchanged(currentSignal)) };
  });
}

async function readPackedNames(commonDir: string, files: RefFiles): Promise<Set<string> | undefined> {
  const file = path.join(commonDir, "packed-refs");
  const info = await files.status(file);
  if (!info) return new Set();
  const lines = (await files.text(file, info, PACKED_REFS_BYTES)).split("\n");
  if (lines.pop() !== "" || lines.shift() !== "# pack-refs with: peeled fully-peeled sorted ") return undefined;
  const refs = new Set<string>();
  let canPeel = false;
  let previous = "";
  for (const line of lines) {
    if (canPeel && /^\^[0-9a-f]{40}$/.test(line)) {
      canPeel = false;
      continue;
    }
    const ref = /^[0-9a-f]{40} (refs\/[!-~]+)$/.exec(line)?.[1];
    if (!ref || !safeRef(ref) || ref <= previous) return undefined;
    previous = ref;
    refs.add(ref);
    canPeel = true;
  }
  return refs;
}

async function readRemoteHead(
  location: { gitDir: string; commonDir: string },
  remote: string,
  files: RefFiles,
  packed: Set<string>,
): Promise<string | undefined> {
  if (!safeRef(remote) || remote.includes("/")
    || ["refs", "worktrees", "main-worktree", "bisect", "worktree", "rewritten"].includes(remote)) return undefined;
  const { gitDir, commonDir } = location;
  const prefix = `refs/remotes/${remote}/`;
  let ref = prefix + "HEAD";
  for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth++) {
    const info = await files.refStatus(commonDir, ref);
    if (info && !info.isFile()) return undefined;
    const text = info && await files.text(path.join(commonDir, ref), info);
    const target = text && /^ref: ([^\r\n]+)\r?\n?$/.exec(text)?.[1];
    if (target?.startsWith(prefix) && safeRef(target)) {
      ref = target;
      continue;
    }
    // Once a symref has been followed, a missing terminal ref is a valid
    // answer too. Packed refs can only contain direct targets.
    if (!depth || (text !== undefined && !/^[0-9a-f]{40}\r?\n?$/.test(text)) || ref.endsWith("/HEAD")) return undefined;

    const short = ref.slice("refs/remotes/".length);
    // Git tries multiple abbreviation rules. Defer to it if any other rule
    // could claim this name, including a packed tag or local branch.
    if (gitDir !== commonDir && await files.refStatus(gitDir, short)) return undefined;
    const competing = [short, "refs/" + short, "refs/tags/" + short, "refs/heads/" + short];
    for (const name of competing) {
      if (packed.has(name) || await files.refStatus(commonDir, name)) return undefined;
    }
    return short;
  }
  return undefined;
}

type RefObservation = CheckoutLocation & {
  heads: Map<string, string>;
  files: RefFiles;
};

async function observeRefs(cwd: string, remotes: string[], signal: AbortSignal): Promise<RefObservation | undefined> {
  const files = new RefFiles(signal);
  const location = await locateRefs(cwd, files);
  if (!location) return undefined;
  const { commonDir } = location;
  const packed = await readPackedNames(commonDir, files);
  if (!packed) return undefined;
  const heads = new Map<string, string>();
  for (const remote of remotes) {
    const head = await readRemoteHead(location, remote, files, packed);
    if (head) heads.set(remote, head);
  }
  return heads.size >= 2 ? { ...location, heads, files } : undefined;
}

/**
 * Replace two or more subprocesses only when Git confirms the exact checkout
 * and SHA-1 files backend observed by the filesystem reader. One observation
 * is scoped to its checkout and refresh, including the abbreviation checks.
 */
export async function observeProvenRemoteHeads(
  cwd: string, remotes: string[], demand?: PrMetadataDemand,
) {
  const env = buildPwrAgentChildProcessEnv(process.env);
  if (process.platform === "win32" || remotes.length < 2 || remotes.length > MAX_REMOTES || !path.isAbsolute(cwd)
    || !constants.O_NOFOLLOW || !constants.O_NONBLOCK || getConfiguredGitCommand()
    || Object.keys(env).some((key) =>
      /^(PWRAGENT_GIT_PATH|GIT_(DIR|WORK_TREE|COMMON_DIR|NAMESPACE|TEST_.*))$/i.test(key))) return undefined;

  const observation = await runPrMetadataFileProbe((signal) => observeRefs(cwd, remotes, signal), demand);
  if (!observation) return undefined;
  if (!await confirmPrFilesCheckout(cwd, observation, env, demand)) return undefined;
  const unchanged = () => runPrMetadataFileProbe((signal) => observation.files.unchanged(signal), demand);
  if (!await unchanged()) return undefined;
  return { gitDir: observation.gitDir, commonDir: observation.commonDir, heads: observation.heads, unchanged };
}

export async function confirmPrFilesCheckout(
  cwd: string, location: Pick<CheckoutLocation, "gitDir" | "commonDir">, env: NodeJS.ProcessEnv, demand?: PrMetadataDemand,
): Promise<boolean> {
  try {
    const { stdout } = await runPrMetadataGit(cwd, [
      "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-ref-format", "--show-object-format",
    ], { purpose: "pr-discovery", env, maxBuffer: 64 * 1024, timeout: 2_000 }, demand);
    return stdout === [location.gitDir, location.commonDir, "files", "sha1", ""].join("\n");
  } catch {
    demand?.signal?.throwIfAborted();
    return false;
  }
}

export async function readProvenRemoteHeads(
  cwd: string, remotes: string[], demand?: PrMetadataDemand,
): Promise<ReadonlyMap<string, string> | undefined> {
  return (await observeProvenRemoteHeads(cwd, remotes, demand))?.heads;
}
