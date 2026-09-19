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
    case "user":
      // Codex has two user roots, `~/.agents/skills` and
      // `$CODEX_HOME/skills`. The second one moves with the Codex profile, so
      // it is recognized as "not the first" rather than by name.
      return normalizePath(skillPath).includes("/.agents/skills/")
        ? { kind: "personal", label: "Personal" }
        : { kind: "codex-home", label: "Codex home" };
    default:
      break;
  }

  const project = matchLinkedDirectory(skillPath, directories);
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
 * Attaches `origin` to every skill. The skills keep their order and every
 * other field; a skill that already carries an origin is reclassified, since
 * the directories are what changed.
 */
export function withSkillOrigins<T extends AppServerSkillSummary>(
  skills: readonly T[],
  directories: readonly SkillOriginDirectory[],
): T[] {
  return skills.map((skill) => {
    const origin = classifySkillOrigin(skill, directories);
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

const ORIGIN_KIND_RANK: Record<AppServerSkillOrigin["kind"], number> = {
  project: 0,
  repository: 1,
  personal: 2,
  "codex-home": 3,
  plugin: 4,
  "built-in": 5,
  admin: 6,
  other: 7,
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

function matchLinkedDirectory(
  skillPath: string,
  directories: readonly SkillOriginDirectory[],
): AppServerSkillOrigin | undefined {
  let best:
    | { length: number; origin: AppServerSkillOrigin }
    | undefined;
  directories.forEach((directory, directoryIndex) => {
    const candidates: Array<{ root: string | undefined; worktree: boolean }> = [
      { root: directory.worktreePath, worktree: true },
      { root: directory.path, worktree: false },
    ];
    for (const candidate of candidates) {
      const root = candidate.root?.trim();
      if (!root || !isPathInside(skillPath, root)) {
        continue;
      }
      const length = normalizePath(root).length;
      // Longest root wins, so a linked subdirectory beats the repository that
      // contains it. On a tie the earlier directory keeps it.
      if (!best || length > best.length) {
        best = {
          length,
          origin: {
            kind: "project",
            label: directory.label.trim() || lastSegment(root) || "Project",
            directoryIndex,
            ...(candidate.worktree ? { worktree: true } : {}),
          },
        };
      }
    }
  });
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

function isPathInside(value: string, root: string): boolean {
  const caseInsensitive = isWindowsPath(value) || isWindowsPath(root);
  const normalizedValue = caseFold(normalizePath(value), caseInsensitive);
  const normalizedRoot = caseFold(normalizePath(root), caseInsensitive);
  if (!normalizedRoot) {
    return false;
  }
  return normalizedRoot === "/"
    ? normalizedValue.startsWith("/")
    : normalizedValue.startsWith(`${normalizedRoot}/`);
}

function caseFold(value: string, caseInsensitive: boolean): string {
  return caseInsensitive ? value.toLowerCase() : value;
}

function isWindowsPath(value: string): boolean {
  const trimmed = value.trim();
  return /^[a-z]:[\\/]/i.test(trimmed) || /^\\\\/.test(trimmed);
}

function normalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function lastSegment(value: string): string | undefined {
  return normalizePath(value).split("/").filter(Boolean).pop();
}
