import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type GitHeadBranchProbe = { branch?: string };

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

function hasGitEnvironmentOverride(): boolean {
  const env = new Map(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]));
  if ([...env.keys()].some((key) =>
    /^(?:PWRAGENT_GIT_PATH|GIT_(?:DIR|WORK_TREE|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM))$/.test(key)
  )) return true;

  const configKeys = [...env.keys()].filter((key) => key.startsWith("GIT_CONFIG"));
  if (configKeys.length === 0) return false;
  const count = Number(env.get("GIT_CONFIG_COUNT"));
  if (!Number.isInteger(count) || count < 0 || count > 16) return true;
  const allowed = new Set(["GIT_CONFIG_COUNT"]);
  for (let index = 0; index < count; index++) {
    const key = "GIT_CONFIG_KEY_" + index;
    const value = "GIT_CONFIG_VALUE_" + index;
    // safe.directory changes trust checks, not the ref backend or HEAD.
    if (env.get(key)?.toLowerCase() !== "safe.directory" || !env.has(value)) return true;
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
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      if (/^(?:extensions|include|includeif)(?:\s|$)/.test(section)) return false;
      continue;
    }
    const entry = /^([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!entry) return false;
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
 * A result with no branch proves an unborn local HEAD, even when remote refs
 * exist in the common repository.
 */
export async function probeCurrentGitBranch(
  cwd: string,
  signal?: AbortSignal,
): Promise<GitHeadBranchProbe | undefined> {
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
      const parent = path.dirname(current);
      if (parent === current) return undefined;
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
  const headRef = /^ref: refs\/heads\/([^\r\n]+)\r?\n?$/.exec(head.text);
  // Detached HEAD and unusual symrefs retain Git's own validation of their
  // target object and abbreviation semantics.
  if (!headRef || !safeBranchName(headRef[1])) return undefined;
  const branch = headRef[1];
  const ref = "refs/heads/" + branch;
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
      if (lastRef === ref) found = true;
    }
  }
  const loose = await readSmallFile(path.join(commonDir, ...ref.split("/")), 4096, signal);
  if (!loose) return undefined;
  if (loose.kind === "text") {
    return /^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?\r?\n?$/.test(loose.text)
      ? { branch }
      : undefined;
  }
  return found ? { branch } : {};
}
