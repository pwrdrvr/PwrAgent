import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type GitHeadBranchProbe = { branch?: string };

/**
 * Discovery reached the filesystem root and found no repository. Git's own
 * discovery would fail too, so the caller need not launch it.
 */
export const NOT_A_GIT_REPOSITORY = "not-a-repository";

type SmallFile = { kind: "missing" } | { kind: "text"; text: string };

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readSmallFile(
  filePath: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SmallFile | undefined> {
  signal?.throwIfAborted();
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(filePath);
  } catch (error) {
    signal?.throwIfAborted();
    return isMissing(error) ? { kind: "missing" } : undefined;
  }
  signal?.throwIfAborted();
  if (!info.isFile() || info.size > limit) return undefined;
  try {
    const text = await readFile(filePath, "utf8");
    signal?.throwIfAborted();
    return { kind: "text", text };
  } catch (error) {
    signal?.throwIfAborted();
    return isMissing(error) ? { kind: "missing" } : undefined;
  }
}

async function hasGitAdministrativeBoundary(directory: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  let head: Awaited<ReturnType<typeof lstat>>;
  try {
    head = await lstat(path.join(directory, "HEAD"));
  } catch (error) {
    signal?.throwIfAborted();
    return !isMissing(error);
  }
  signal?.throwIfAborted();
  // Git accepts a symbolic-link HEAD by its link text, so even a dangling
  // link can mark a bare repository. stat would report it missing.
  if (!head.isFile()) return true;
  // Bare repositories own objects here; linked-worktree administrative
  // directories point at their common repository. Neither may be skipped
  // while discovering an enclosing checkout.
  for (const marker of ["objects", "commondir"]) {
    try {
      await stat(path.join(directory, marker));
      signal?.throwIfAborted();
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      if (!isMissing(error)) return true;
    }
  }
  return false;
}

const NEUTRAL_ENVIRONMENT_CONFIG_KEYS = new Set(["safe.directory", "core.autocrlf"]);

function hasGitEnvironmentOverride(): boolean {
  const env = new Map(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]));
  if ([...env.keys()].some((key) =>
    /^(?:PWRAGENT_GIT_PATH|GIT_(?:DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM))$/.test(key)
  )) return true;

  const configKeys = [...env.keys()].filter((key) => key.startsWith("GIT_CONFIG"));
  if (configKeys.length === 0) return false;
  const count = Number(env.get("GIT_CONFIG_COUNT"));
  if (!Number.isInteger(count) || count < 0 || count > 16) return true;
  const allowed = new Set(["GIT_CONFIG_COUNT"]);
  for (let index = 0; index < count; index++) {
    const key = "GIT_CONFIG_KEY_" + index;
    const value = "GIT_CONFIG_VALUE_" + index;
    // safe.directory changes trust checks and core.autocrlf changes content
    // line endings. Neither changes discovery, the ref backend or HEAD.
    // Playwright sets core.autocrlf for every E2E launch.
    if (!NEUTRAL_ENVIRONMENT_CONFIG_KEYS.has(env.get(key)?.toLowerCase() ?? "") || !env.has(value)) return true;
    allowed.add(key);
    allowed.add(value);
  }
  return configKeys.some((key) => !allowed.has(key));
}

function safeBranchName(branch: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
    && !branch.includes("..")
    && !branch.includes("//")
    && branch.split("/").every((part) =>
      part.length > 0
      && !part.startsWith(".")
      && !part.endsWith(".")
      && !part.endsWith(".lock")
    );
}

function hasOrdinaryFilesConfig(text: string): boolean {
  let section = "";
  let formatVersion: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      // Complex section and subsection syntax belongs to Git's config parser.
      const header = /^\[([A-Za-z][A-Za-z0-9-]*)(?: "[^"\\]+")?\]$/.exec(line);
      if (!header) return false;
      section = header[1].toLowerCase();
      if (/^(?:extensions|include|includeif)(?:\s|$)/.test(section)) return false;
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!section || !entry) return false;
    // Accept plain values and Git's simple escapes. Quoting, comments inside
    // values, and continuations require Git's own parser.
    if (/["#;]/.test(entry[2])) return false;
    for (let index = 0; index < entry[2].length; index++) {
      if (entry[2][index] !== "\\") continue;
      const escaped = entry[2][index + 1];
      if (!escaped || !"\\ntb".includes(escaped)) return false;
      index++;
    }
    const key = entry[1].toLowerCase();
    if (section === "core") {
      if (key === "repositoryformatversion") formatVersion = entry[2];
      if (key === "bare" && entry[2].toLowerCase() !== "false") return false;
      if (key === "worktree") return false;
    }
  }
  return formatVersion === "0";
}

/**
 * Read only ordinary files-backend branch metadata. An undefined result means
 * the layout is unproven and the caller must use its owned Git subprocess.
 * A branch is what `git rev-parse --abbrev-ref HEAD` prints, so a detached
 * HEAD reports `HEAD`. A result with no branch proves an unborn local HEAD,
 * even when remote refs exist in the common repository. NOT_A_GIT_REPOSITORY
 * proves that Git's discovery finds no repository from this directory.
 */
export async function probeCurrentGitBranch(
  cwd: string,
  signal?: AbortSignal,
): Promise<GitHeadBranchProbe | typeof NOT_A_GIT_REPOSITORY | undefined> {
  signal?.throwIfAborted();
  if (hasGitEnvironmentOverride()) return undefined;
  let current: string;
  try {
    current = await realpath(cwd);
    const currentInfo = await stat(current);
    signal?.throwIfAborted();
    if (!currentInfo.isDirectory()) return undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }

  let dotGit: string;
  let dotGitInfo: Awaited<ReturnType<typeof stat>>;
  while (true) {
    signal?.throwIfAborted();
    dotGit = path.join(current, ".git");
    try {
      dotGitInfo = await stat(dotGit);
      signal?.throwIfAborted();
      break;
    } catch (error) {
      signal?.throwIfAborted();
      if (!isMissing(error)) return undefined;
      if (await hasGitAdministrativeBoundary(current, signal)) return undefined;
      const parent = path.dirname(current);
      // Git checks the same two places at each level: a .git entry, then the
      // directory itself as a bare repository. With no environment override
      // this walk is a superset of Git's: a ceiling or a filesystem boundary
      // only stops Git earlier. safe.directory and safe.bareRepository only
      // reject a repository that discovery already found.
      if (parent === current) return NOT_A_GIT_REPOSITORY;
      current = parent;
    }
  }

  let gitDir = dotGit;
  if (!dotGitInfo.isDirectory()) {
    const link = await readSmallFile(dotGit, 4096, signal);
    if (link?.kind !== "text") return undefined;
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(link.text);
    if (!match) return undefined;
    gitDir = path.resolve(current, match[1]);
  }
  signal?.throwIfAborted();
  const adminInfo = await stat(gitDir).catch(() => undefined);
  signal?.throwIfAborted();
  if (!adminInfo?.isDirectory()) return undefined;

  const commonLink = await readSmallFile(path.join(gitDir, "commondir"), 4096, signal);
  if (!commonLink) return undefined;
  if (commonLink.kind === "text" && !/^[^\r\n]+\r?\n?$/.test(commonLink.text)) {
    return undefined;
  }
  const commonDir = commonLink.kind === "text"
    ? path.resolve(gitDir, commonLink.text.trim())
    : gitDir;
  signal?.throwIfAborted();
  const commonInfo = await stat(commonDir).catch(() => undefined);
  signal?.throwIfAborted();
  if (!commonInfo?.isDirectory()) return undefined;

  const config = await readSmallFile(path.join(commonDir, "config"), 64 * 1024, signal);
  if (config?.kind !== "text" || !hasOrdinaryFilesConfig(config.text)) {
    return undefined;
  }
  const worktreeConfig = await readSmallFile(path.join(gitDir, "config.worktree"), 4096, signal);
  if (worktreeConfig?.kind !== "missing") return undefined;
  const adminTables = await readSmallFile(path.join(gitDir, "reftable", "tables.list"), 4096, signal);
  if (adminTables?.kind !== "missing") return undefined;
  if (commonDir !== gitDir) {
    const commonTables = await readSmallFile(path.join(commonDir, "reftable", "tables.list"), 4096, signal);
    if (commonTables?.kind !== "missing") return undefined;
  }

  const head = await readSmallFile(path.join(gitDir, "HEAD"), 4096, signal);
  if (head?.kind !== "text") return undefined;
  // Format version 0 with no extensions is SHA-1. Git abbreviates a detached
  // HEAD to `HEAD` without reading its object, unless another `HEAD` ref makes
  // the name ambiguous, which the scan below defers to Git.
  const detached = /^[0-9a-fA-F]{40}\r?\n?$/.test(head.text);
  const headRef = /^ref: refs\/heads\/([^\r\n]+)\r?\n?$/.exec(head.text);
  // Unusual symrefs retain Git's own abbreviation semantics.
  if (!detached && (!headRef || !safeBranchName(headRef[1]))) return undefined;
  const branch = headRef ? headRef[1] : "HEAD";
  const ref = detached ? undefined : "refs/heads/" + branch;
  const ambiguousRefs = [
    "refs/" + branch,
    ...(detached ? ["refs/heads/HEAD"] : []),
    "refs/remotes/" + branch,
    "refs/remotes/" + branch + "/HEAD",
  ];
  for (const ambiguousRef of ambiguousRefs) {
    const candidate = await readSmallFile(path.join(commonDir, ...ambiguousRef.split("/")), 4096, signal);
    if (candidate?.kind !== "missing") return undefined;
  }
  signal?.throwIfAborted();
  let looseTags: string[];
  try {
    looseTags = await readdir(path.join(commonDir, "refs", "tags"));
  } catch (error) {
    signal?.throwIfAborted();
    if (!isMissing(error)) return undefined;
    looseTags = [];
  }
  signal?.throwIfAborted();
  if (looseTags.length > 0) return undefined;

  // Packing publishes packed-refs before pruning loose refs. Read the loose
  // ref first so concurrent packing cannot make a committed HEAD look unborn.
  // A detached HEAD has no branch ref, only names packed-refs could make
  // ambiguous.
  const loose: SmallFile | undefined = ref
    ? await readSmallFile(path.join(commonDir, ...ref.split("/")), 4096, signal)
    : { kind: "missing" };
  if (!loose) return undefined;
  const packed = await readSmallFile(path.join(commonDir, "packed-refs"), 1024 * 1024, signal);
  if (!packed) return undefined;
  let found = false;
  if (packed.kind === "text") {
    const seen = new Set<string>();
    let lastRef: string | undefined;
    for (const line of packed.text.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("^")) {
        if (!/^\^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/.test(line)
          || !lastRef?.startsWith("refs/tags/")) return undefined;
        lastRef = undefined;
        continue;
      }
      const entry = /^([0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?) (refs\/[^\s]+)$/.exec(line);
      if (!entry || seen.has(entry[2])) return undefined;
      lastRef = entry[2];
      seen.add(lastRef);
      if (lastRef.startsWith("refs/tags/")) return undefined;
      if (ambiguousRefs.includes(lastRef)) return undefined;
      if (lastRef === ref) found = true;
    }
  }
  if (loose.kind === "text") {
    return /^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?\r?\n?$/.test(loose.text)
      ? { branch }
      : undefined;
  }
  return found || detached ? { branch } : {};
}
