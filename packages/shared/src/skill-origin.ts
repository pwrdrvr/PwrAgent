import type {
  AppServerSkillOrigin,
  AppServerSkillSummary,
  LinkedDirectorySummary,
} from "./contracts/normalized-app-server";

/**
 * A directory a skill can be attributed to: a thread's linked directory, or
 * the one directory a launchpad draft points at.
 */
export type SkillOriginDirectory = Pick<LinkedDirectorySummary, "label" | "path"> & {
  worktreePath?: string;
};

export type SkillOriginOptions = {
  /**
   * The folder this machine's PwrAgent writes its bundled skills to
   * (`<PwrAgent root>/skills/bundled`), as configured and with symlinks
   * resolved: Codex may report either form. Main knows it; this package
   * cannot import it. Leave it unset for skills a peer instance listed:
   * their paths are on the peer's machine.
   */
  bundledSkillRoots?: readonly string[];
};

/**
 * Says where a skill came from, in the thread's own vocabulary.
 *
 * A thread with several linked projects gets every project's in-repo skills,
 * and three `$release` rows are indistinguishable without this. Codex already
 * reports `scope` (`repo`, `user`, `system`, `admin`), `pluginId`, and the
 * `path`; the linked directories supply the project names the operator
 * already sees on the thread row.
 *
 * `scope` is trusted before the path. A worktree checkout lives under
 * `~/.codex/worktrees`, so a path rule for Codex home would claim a project
 * skill, and a linked home directory would claim `~/.agents/skills`.
 * Only a `repo` skill, or one with no scope at all, is matched against the
 * linked directories.
 *
 * Returns `undefined` for a skill without a path. It has no location to
 * name, and the picker cannot insert it anyway.
 */
export function classifySkillOrigin(
  skill: Pick<AppServerSkillSummary, "path" | "pluginId" | "scope">,
  directories: readonly SkillOriginDirectory[],
  options: SkillOriginOptions = {},
): AppServerSkillOrigin | undefined {
  return classifySkillOriginCore(skill, directories, options, undefined, undefined);
}

/**
 * Attaches `origin` to every skill. The skills keep their order and every
 * other field; a skill that already carries an origin is reclassified, since
 * the directories are what changed.
 */
export function withSkillOrigins<T extends AppServerSkillSummary>(
  skills: readonly T[],
  directories: readonly SkillOriginDirectory[],
  options: SkillOriginOptions = {},
): T[] {
  let directoryIndex: DirectoryIndex | undefined;
  let bundledRoots: PreparedBundledRoot[] | undefined;

  return skills.map((skill) => {
    const origin = classifySkillOriginCore(
      skill,
      directories,
      options,
      () => {
        directoryIndex ??= buildDirectoryIndex(directories);
        return directoryIndex;
      },
      () => {
        bundledRoots ??= prepareBundledSkillRoots(options.bundledSkillRoots);
        return bundledRoots;
      },
    );
    if (!origin) {
      if (!skill.origin) {
        return skill;
      }
      const { origin: _origin, ...rest } = skill;
      return rest as T;
    }
    return { ...skill, origin };
  });
}

function classifySkillOriginCore(
  skill: Pick<AppServerSkillSummary, "path" | "pluginId" | "scope">,
  directories: readonly SkillOriginDirectory[],
  options: SkillOriginOptions,
  getDirectoryIndex: (() => DirectoryIndex) | undefined,
  getBundledRoots: (() => readonly PreparedBundledRoot[]) | undefined,
): AppServerSkillOrigin | undefined {
  const skillPath = skill.path?.trim();
  if (!skillPath) {
    return undefined;
  }
  const pluginId = skill.pluginId?.trim();
  if (pluginId) {
    return {
      kind: "plugin",
      label: pluginId.split("@")[0]?.trim() || pluginId,
      pluginId,
    };
  }

  const scope = skill.scope?.trim().toLowerCase();
  switch (scope) {
    case "system":
      return { kind: "built-in", label: "Built-in" };
    case "admin":
      return { kind: "admin", label: "Admin" };
    case "antigravity-user":
      return { kind: "personal", label: "Personal" };
    case "user": {
      const normalizedSkillPath = normalizeTrimmedPath(skillPath);
      // PwrAgent hands Codex its own bundled skill folder, which Codex lists
      // as a user root. Without this check those skills read as Codex home,
      // where the operator then looks for a copy that does not exist.
      const preparedRoots = getBundledRoots
        ? getBundledRoots()
        : prepareBundledSkillRoots(options.bundledSkillRoots);
      if (preparedRoots.length > 0) {
        const isWindowsSkill = isTrimmedWindowsPath(skillPath);
        let foldedSkillPath: string | undefined;
        for (const root of preparedRoots) {
          const caseInsensitive = isWindowsSkill || root.isWindows;
          const target = caseInsensitive
            ? (foldedSkillPath ??= normalizedSkillPath.toLowerCase())
            : normalizedSkillPath;
          const prefix = caseInsensitive ? root.folded : root.normalized;
          if (isNormalizedPathInside(target, prefix)) {
            return { kind: "pwragent", label: "PwrAgent" };
          }
        }
      }
      // Codex has two user roots, `~/.agents/skills` and
      // `$CODEX_HOME/skills`. The second one moves with the Codex profile, so
      // it is recognized as "not the first" rather than by name.
      return normalizedSkillPath.includes("/.agents/skills/")
        ? { kind: "personal", label: "Personal" }
        : { kind: "codex-home", label: "Codex home" };
    }
    default:
      break;
  }

  const project = getDirectoryIndex
    ? matchIndexedLinkedDirectory(skillPath, getDirectoryIndex(), directories)
    : matchLinkedDirectory(skillPath, directories);
  if (project) {
    return project;
  }
  if (scope === "repo") {
    return {
      kind: "repository",
      label: repositoryFolderLabel(skillPath) ?? skillRootLabel(skillPath) ?? "Repository",
    };
  }
  return { kind: "other", label: skillRootLabel(skillPath) ?? "Other" };
}

/**
 * The result is cached on the list itself, because every surface that labels
 * a chip asks this of the same catalog: the transcript asks once per rendered
 * message, and the composer once per chip it mints. Skill catalogs here are
 * always freshly built and never mutated in place — a caller that does mutate
 * one has to hand over a new array.
 */
const sharedSkillNameCache = new WeakMap<object, ReadonlySet<string>>();

/**
 * The names more than one skill answers to, case-folded.
 *
 * This is the one question behind every origin label: `$release` alone says
 * which file it runs unless some other skill is also called `$release`. The
 * composer's picker, a picked chip, a restored draft, the transcript's sent
 * chips and the messaging `/skills` browser all ask it, so they ask it here
 * — four copies of the rule had already drifted to three different answers.
 *
 * Two skills at the same path are one skill listed twice, not a collision.
 * Names are folded because `$Release` and `$release` are at least as easy to
 * confuse as two identical ones. A skill without a path is not counted: no
 * surface can link to one, so it cannot be what a `$name` meant.
 */
export function findSharedSkillNames(
  skills: readonly { name: string; path?: string }[],
): ReadonlySet<string> {
  const cached = sharedSkillNameCache.get(skills);
  if (cached) {
    return cached;
  }
  const pathsByName = new Map<string, Set<string>>();
  for (const skill of skills) {
    const path = skill.path?.trim();
    if (!path) {
      continue;
    }
    const key = foldSkillName(skill.name);
    const paths = pathsByName.get(key);
    if (paths) {
      paths.add(path);
    } else {
      pathsByName.set(key, new Set([path]));
    }
  }
  const shared = new Set<string>();
  for (const [name, paths] of pathsByName) {
    if (paths.size > 1) {
      shared.add(name);
    }
  }
  sharedSkillNameCache.set(skills, shared);
  return shared;
}

/**
 * Whether `name` is one of `findSharedSkillNames`'s answers. Go through this
 * rather than `set.has(name)`: the set holds folded names.
 */
export function isSharedSkillName(
  sharedNames: ReadonlySet<string>,
  name: string,
): boolean {
  return sharedNames.has(foldSkillName(name));
}

function foldSkillName(name: string): string {
  return name.trim().toLowerCase();
}

const ORIGIN_KIND_RANK: Record<AppServerSkillOrigin["kind"], number> = {
  project: 0,
  repository: 1,
  personal: 2,
  "codex-home": 3,
  pwragent: 4,
  plugin: 5,
  "built-in": 6,
  admin: 7,
  other: 8,
};

/**
 * Orders two skills that tie on everything else: the primary project first,
 * then linked projects in thread order, then everything that is not a project.
 * The primary project comes first because a same-named skill in it is the one
 * the thread was most likely opened to use.
 */
export function compareSkillOrigins(
  left: AppServerSkillOrigin | undefined,
  right: AppServerSkillOrigin | undefined,
): number {
  const leftRank = left ? ORIGIN_KIND_RANK[left.kind] : Number.MAX_SAFE_INTEGER;
  const rightRank = right ? ORIGIN_KIND_RANK[right.kind] : Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return (left?.directoryIndex ?? 0) - (right?.directoryIndex ?? 0);
}

/**
 * The origin's kind in words: the heading of the desktop hover card, and the
 * suffix a text-only surface appends.
 */
export function describeSkillOriginKind(origin: AppServerSkillOrigin): string {
  switch (origin.kind) {
    case "project":
      if (origin.worktree) {
        return "Project skill · worktree";
      }
      return origin.directoryIndex === 0
        ? "Project skill · primary"
        : "Project skill · linked";
    case "repository":
      return "Repository skill";
    case "personal":
      return "Personal skill";
    case "codex-home":
      return "Personal skill · Codex home";
    case "pwragent":
      return "Bundled with PwrAgent";
    case "plugin":
      return "Plugin skill";
    case "built-in":
      return "Bundled with Codex";
    case "admin":
      return "Managed by an administrator";
    case "other":
      return "Other location";
  }
}

/** The marketplace half of a `<plugin>@<marketplace>` id. */
export function skillOriginMarketplace(origin: AppServerSkillOrigin): string | undefined {
  if (origin.kind !== "plugin" || !origin.pluginId) {
    return undefined;
  }
  const at = origin.pluginId.indexOf("@");
  const marketplace = at >= 0 ? origin.pluginId.slice(at + 1).trim() : "";
  return marketplace || undefined;
}

/**
 * An origin read back from somewhere it was stored: a saved composer
 * document, or a chip's `data-skill-origin` in pasted HTML. Anything that is
 * not a well-formed origin is dropped, not repaired, so a chip never shows a
 * label this module did not produce the shape of.
 */
export function readSkillOrigin(value: unknown): AppServerSkillOrigin | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const { kind, label } = record;
  if (
    typeof kind !== "string"
    || !Object.prototype.hasOwnProperty.call(ORIGIN_KIND_RANK, kind)
    || typeof label !== "string"
    || !label.trim()
  ) {
    return undefined;
  }
  const directoryIndex = record.directoryIndex;
  return {
    kind: kind as AppServerSkillOrigin["kind"],
    label,
    ...(typeof directoryIndex === "number"
      && Number.isInteger(directoryIndex)
      && directoryIndex >= 0
      ? { directoryIndex }
      : {}),
    ...(record.worktree === true ? { worktree: true } : {}),
    ...(typeof record.pluginId === "string" && record.pluginId
      ? { pluginId: record.pluginId }
      : {}),
  };
}

type IndexedRoot = {
  order: number;
  origin: AppServerSkillOrigin;
};

type DirectoryIndex = {
  allFoldedRoots: Map<string, IndexedRoot>;
  exactRoots: Map<string, IndexedRoot>;
  hasUnicodeCaseLengthChange: boolean;
  windowsFoldedRoots: Map<string, IndexedRoot>;
};

type PreparedBundledRoot = {
  folded: string;
  isWindows: boolean;
  normalized: string;
};

function prepareBundledSkillRoots(
  roots: readonly string[] | undefined,
): PreparedBundledRoot[] {
  if (!roots?.length) {
    return [];
  }
  const prepared: PreparedBundledRoot[] = [];
  for (const raw of roots) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const normalized = normalizeTrimmedPath(trimmed);
    if (!normalized) {
      continue;
    }
    prepared.push({
      folded: normalized.toLowerCase(),
      isWindows: isTrimmedWindowsPath(trimmed),
      normalized,
    });
  }
  return prepared;
}

function buildDirectoryIndex(
  directories: readonly SkillOriginDirectory[],
): DirectoryIndex {
  const exactRoots = new Map<string, IndexedRoot>();
  const windowsFoldedRoots = new Map<string, IndexedRoot>();
  const allFoldedRoots = new Map<string, IndexedRoot>();
  let hasUnicodeCaseLengthChange = false;
  let nextOrder = 0;

  for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex += 1) {
    const directory = directories[directoryIndex]!;
    const trimmedLabel = directory.label.trim();
    for (let slot = 0; slot < 2; slot += 1) {
      const worktree = slot === 0;
      const root = (worktree ? directory.worktreePath : directory.path)?.trim();
      if (!root) {
        continue;
      }
      const normalized = normalizeTrimmedPath(root);
      if (!normalized) {
        continue;
      }
      const isWindows = isTrimmedWindowsPath(root);
      const folded = normalized.toLowerCase();
      if (folded.length !== normalized.length) {
        hasUnicodeCaseLengthChange = true;
      }
      const entry: IndexedRoot = {
        order: nextOrder,
        origin: {
          kind: "project",
          label: trimmedLabel || lastSegmentNormalized(normalized) || "Project",
          directoryIndex,
          ...(worktree ? { worktree: true } : {}),
        },
      };
      nextOrder += 1;

      if (!allFoldedRoots.has(folded)) {
        allFoldedRoots.set(folded, entry);
      }
      if (isWindows) {
        if (!windowsFoldedRoots.has(folded)) {
          windowsFoldedRoots.set(folded, entry);
        }
      } else if (!exactRoots.has(normalized)) {
        exactRoots.set(normalized, entry);
      }
    }
  }

  return {
    allFoldedRoots,
    exactRoots,
    hasUnicodeCaseLengthChange,
    windowsFoldedRoots,
  };
}

function matchIndexedLinkedDirectory(
  skillPath: string,
  index: DirectoryIndex,
  directories: readonly SkillOriginDirectory[],
): AppServerSkillOrigin | undefined {
  if (index.allFoldedRoots.size === 0) {
    return undefined;
  }
  const normalizedValue = normalizeTrimmedPath(skillPath);
  if (!normalizedValue) {
    return undefined;
  }
  const isWindowsValue = isTrimmedWindowsPath(skillPath);
  const needsFolded = isWindowsValue || index.windowsFoldedRoots.size > 0;
  const foldedValue = needsFolded ? normalizedValue.toLowerCase() : normalizedValue;
  if (
    needsFolded
    && (index.hasUnicodeCaseLengthChange || foldedValue.length !== normalizedValue.length)
  ) {
    return matchLinkedDirectory(skillPath, directories);
  }

  const lookupPrefix = (prefix: string, foldedPrefix: string): IndexedRoot | undefined => {
    if (isWindowsValue) {
      return index.allFoldedRoots.get(foldedPrefix);
    }
    const exactHit = index.exactRoots.get(prefix);
    if (index.windowsFoldedRoots.size === 0) {
      return exactHit;
    }
    const windowsHit = index.windowsFoldedRoots.get(foldedPrefix);
    if (!exactHit) {
      return windowsHit;
    }
    if (!windowsHit) {
      return exactHit;
    }
    return exactHit.order <= windowsHit.order ? exactHit : windowsHit;
  };

  let slashPos = normalizedValue.lastIndexOf("/");
  while (slashPos > 0) {
    const hit = lookupPrefix(
      normalizedValue.slice(0, slashPos),
      needsFolded ? foldedValue.slice(0, slashPos) : "",
    );
    if (hit) {
      return { ...hit.origin };
    }
    slashPos = normalizedValue.lastIndexOf("/", slashPos - 1);
  }

  if (normalizedValue.charCodeAt(0) === 47) {
    const rootHit = lookupPrefix("/", "/");
    if (rootHit) {
      return { ...rootHit.origin };
    }
  }

  return undefined;
}

function matchLinkedDirectory(
  skillPath: string,
  directories: readonly SkillOriginDirectory[],
): AppServerSkillOrigin | undefined {
  if (directories.length === 0) {
    return undefined;
  }
  const isWindowsSkill = isTrimmedWindowsPath(skillPath);
  const normalizedSkill = normalizeTrimmedPath(skillPath);
  let foldedSkill: string | undefined;

  let best:
    | { length: number; origin: AppServerSkillOrigin }
    | undefined;
  for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex += 1) {
    const directory = directories[directoryIndex]!;
    for (let slot = 0; slot < 2; slot += 1) {
      const worktree = slot === 0;
      const root = (worktree ? directory.worktreePath : directory.path)?.trim();
      if (!root) {
        continue;
      }
      const normalizedRoot = normalizeTrimmedPath(root);
      if (!normalizedRoot) {
        continue;
      }
      const caseInsensitive = isWindowsSkill || isTrimmedWindowsPath(root);
      const target = caseInsensitive
        ? (foldedSkill ??= normalizedSkill.toLowerCase())
        : normalizedSkill;
      const prefix = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
      if (!isNormalizedPathInside(target, prefix)) {
        continue;
      }
      const length = normalizedRoot.length;
      // Longest root wins, so a linked subdirectory beats the repository that
      // contains it. On a tie the earlier directory keeps it.
      if (!best || length > best.length) {
        best = {
          length,
          origin: {
            kind: "project",
            label: directory.label.trim() || lastSegmentNormalized(normalizedRoot) || "Project",
            directoryIndex,
            ...(worktree ? { worktree: true } : {}),
          },
        };
      }
    }
  }
  return best?.origin;
}

/** The folder that holds the `.agents` or `.codex` skills directory. */
function repositoryFolderLabel(skillPath: string): string | undefined {
  const segments = normalizePath(skillPath).split("/");
  const markerIndex = segments.findIndex(
    (segment, index) =>
      (segment === ".agents" || segment === ".codex")
      && segments[index + 1] === "skills",
  );
  return markerIndex > 0 ? segments[markerIndex - 1] || undefined : undefined;
}

/**
 * The folder the skill's own folder sits in, skipping a plain `skills`
 * folder: `/opt/team-skills/lint/SKILL.md` is `team-skills`, and
 * `/opt/team/skills/lint/SKILL.md` is `team`. A leading dot is dropped.
 */
function skillRootLabel(skillPath: string): string | undefined {
  const segments = normalizePath(skillPath).split("/").filter(Boolean);
  // [..., root, skillFolder, "SKILL.md"]
  let index = segments.length - 3;
  if (segments[index] === "skills") {
    index -= 1;
  }
  const label = segments[index]?.replace(/^\.+/, "");
  return label || undefined;
}

function isNormalizedPathInside(normalizedValue: string, normalizedRoot: string): boolean {
  if (!normalizedRoot) {
    return false;
  }
  if (normalizedRoot === "/") {
    return normalizedValue.charCodeAt(0) === 47;
  }
  return normalizedValue.length > normalizedRoot.length
    && normalizedValue.charCodeAt(normalizedRoot.length) === 47
    && normalizedValue.startsWith(normalizedRoot);
}

function isTrimmedWindowsPath(trimmed: string): boolean {
  if (trimmed.length >= 3 && trimmed.charCodeAt(1) === 58) {
    const drive = trimmed.charCodeAt(0);
    const sep = trimmed.charCodeAt(2);
    if (
      ((drive >= 65 && drive <= 90) || (drive >= 97 && drive <= 122))
      && (sep === 47 || sep === 92)
    ) {
      return true;
    }
  }
  return trimmed.length >= 2
    && trimmed.charCodeAt(0) === 92
    && trimmed.charCodeAt(1) === 92;
}

function normalizeTrimmedPath(trimmed: string): string {
  const normalized = trimmed.includes("\\") ? trimmed.replace(/\\/g, "/") : trimmed;
  if (normalized.length <= 1 || normalized.charCodeAt(normalized.length - 1) !== 47) {
    return normalized;
  }
  let end = normalized.length;
  while (end > 0 && normalized.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return normalized.slice(0, end);
}

function normalizePath(value: string): string {
  return normalizeTrimmedPath(value.trim());
}

function lastSegmentNormalized(normalized: string): string | undefined {
  return normalized.split("/").filter(Boolean).pop();
}
