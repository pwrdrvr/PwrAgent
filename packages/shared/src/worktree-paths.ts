const TOOL_WORKTREE_ROOT = /[\\/]\.(codex|pwrag(?:ent|nt))(?:[\\/]profiles[\\/][^\\/]+)?[\\/]worktrees[\\/][^\\/]+[\\/][^\\/]+/;
const TOOL_WORKTREE_PATH = /[\\/]\.(?:codex|pwrag(?:ent|nt))(?:[\\/]profiles[\\/][^\\/]+)?[\\/]worktrees[\\/][^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/;

/** Where Codex threads' worktrees go inside the operator's worktree folder. */
export const WORKTREE_FOLDER_CODEX_SUBFOLDER = "codex";

type ConfiguredWorktreeRoot = { prefix: string; caseless: boolean; owner: "codex" | "pwragent" };

let configuredRoots: readonly ConfiguredWorktreeRoot[] = [];

/** Forward slashes, no `.`, `..`, repeated or trailing separators; Windows
 * paths (a drive letter or a UNC share) compare without case. */
function comparablePath(value: string): { path: string; caseless: boolean } {
  const caseless = /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value);
  const slashed = value.replace(/\\/g, "/");
  const lead = slashed.startsWith("//") ? "//" : slashed.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of slashed.slice(lead.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(part);
  }
  const normalized = lead + parts.join("/");
  return { path: caseless ? normalized.toLowerCase() : normalized, caseless };
}

/**
 * Tells path recognition where the operator's worktree folder is. Worktrees
 * there have no `.pwragent/worktrees` in their path: PwrAgent's are
 * `<directory>/<hash>/<project>` and Codex threads' are
 * `<directory>/codex/<hash>/<project>`. Each process that classifies paths
 * (main, every renderer window) calls this whenever the setting changes.
 */
export function setConfiguredWorktreeFolder(directory: string | undefined): void {
  const trimmed = directory?.trim();
  if (!trimmed) {
    configuredRoots = [];
    return;
  }
  const root = comparablePath(trimmed);
  if (!root.path) {
    configuredRoots = [];
    return;
  }
  configuredRoots = [
    // The longer root first: `<folder>/codex` decides before `<folder>` does.
    { prefix: `${root.path}/${WORKTREE_FOLDER_CODEX_SUBFOLDER}/`, caseless: root.caseless, owner: "codex" },
    { prefix: `${root.path}/`, caseless: root.caseless, owner: "pwragent" },
  ];
}

function configuredRootOwner(value: string): "codex" | "pwragent" | undefined {
  if (configuredRoots.length === 0) return undefined;
  const target = comparablePath(value);
  for (const root of configuredRoots) {
    const candidate = root.caseless && !target.caseless ? target.path.toLowerCase() : target.path;
    if (!candidate.startsWith(root.prefix)) continue;
    // The first root that contains the path decides: `<folder>/codex/<hash>`
    // is a Codex hash folder, not a PwrAgent worktree named `<hash>`.
    const [hash, project] = candidate.slice(root.prefix.length).split("/");
    return hash && project && !hash.startsWith(".") ? root.owner : undefined;
  }
  return undefined;
}

/** Whose worktree root a path is in. The first root in the path decides, so a
 * Codex worktree with a folder named `.pwragent` inside it is still Codex's,
 * and a worktree in the configured folder is that folder's even when its
 * checkout holds a `.codex/worktrees` of its own. */
export function toolWorktreeRootOwner(value: string | undefined): "codex" | "pwragent" | undefined {
  if (!value?.trim()) return undefined;
  const configured = configuredRootOwner(value);
  if (configured !== undefined) return configured;
  const owner = TOOL_WORKTREE_ROOT.exec(value)?.[1];
  return owner === undefined ? undefined : owner === "codex" ? "codex" : "pwragent";
}

export function isToolManagedWorktreePath(value: string | undefined): boolean {
  if (!value?.trim()) {
    return false;
  }

  return TOOL_WORKTREE_PATH.test(value) || configuredRootOwner(value) !== undefined;
}
