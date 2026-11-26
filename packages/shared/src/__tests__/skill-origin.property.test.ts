import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  AppServerSkillOrigin,
  AppServerSkillSummary,
} from "../contracts/normalized-app-server";
import {
  classifySkillOrigin,
  withSkillOrigins,
  type SkillOriginDirectory,
  type SkillOriginOptions,
} from "../skill-origin";

// Slow, obviously-correct linear reference oracle matching the original
// O(S * D) specification: scope precedence, longest matching root, early
// directory tie breaks, worktree precedence within a directory, and path
// normalization (POSIX, Windows drive letters, UNC paths, trailing slashes,
// whitespace, and Unicode case folding).

function oracleNormalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function oracleIsWindowsPath(value: string): boolean {
  const trimmed = value.trim();
  return /^[a-z]:[\\/]/i.test(trimmed) || /^\\\\/.test(trimmed);
}

function oracleIsPathInside(value: string, root: string): boolean {
  const caseInsensitive = oracleIsWindowsPath(value) || oracleIsWindowsPath(root);
  const normalizedValue = caseInsensitive
    ? oracleNormalizePath(value).toLowerCase()
    : oracleNormalizePath(value);
  const normalizedRoot = caseInsensitive
    ? oracleNormalizePath(root).toLowerCase()
    : oracleNormalizePath(root);
  if (!normalizedRoot) {
    return false;
  }
  return normalizedRoot === "/"
    ? normalizedValue.startsWith("/")
    : normalizedValue.startsWith(`${normalizedRoot}/`);
}

function oracleLastSegment(value: string): string | undefined {
  return oracleNormalizePath(value).split("/").filter(Boolean).pop();
}

function oracleRepositoryFolderLabel(skillPath: string): string | undefined {
  const segments = oracleNormalizePath(skillPath).split("/");
  const markerIndex = segments.findIndex(
    (segment, index) =>
      (segment === ".agents" || segment === ".codex")
      && segments[index + 1] === "skills",
  );
  return markerIndex > 0 ? segments[markerIndex - 1] || undefined : undefined;
}

function oracleSkillRootLabel(skillPath: string): string | undefined {
  const segments = oracleNormalizePath(skillPath).split("/").filter(Boolean);
  let index = segments.length - 3;
  if (segments[index] === "skills") {
    index -= 1;
  }
  const label = segments[index]?.replace(/^\.+/, "");
  return label || undefined;
}

function oracleClassifySkillOrigin(
  skill: Pick<AppServerSkillSummary, "path" | "pluginId" | "scope">,
  directories: readonly SkillOriginDirectory[],
  options: SkillOriginOptions = {},
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
    case "user":
      if (
        options.bundledSkillRoots?.some(
          (root) => root.trim() && oracleIsPathInside(skillPath, root),
        )
      ) {
        return { kind: "pwragent", label: "PwrAgent" };
      }
      return oracleNormalizePath(skillPath).includes("/.agents/skills/")
        ? { kind: "personal", label: "Personal" }
        : { kind: "codex-home", label: "Codex home" };
    default:
      break;
  }

  let best: { length: number; origin: AppServerSkillOrigin } | undefined;
  directories.forEach((directory, directoryIndex) => {
    const candidates = [
      { root: directory.worktreePath, worktree: true },
      { root: directory.path, worktree: false },
    ];
    for (const candidate of candidates) {
      const root = candidate.root?.trim();
      if (!root || !oracleIsPathInside(skillPath, root)) {
        continue;
      }
      const length = oracleNormalizePath(root).length;
      if (!best || length > best.length) {
        best = {
          length,
          origin: {
            kind: "project",
            label: directory.label.trim() || oracleLastSegment(root) || "Project",
            directoryIndex,
            ...(candidate.worktree ? { worktree: true } : {}),
          },
        };
      }
    }
  });
  if (best) {
    return best.origin;
  }
  if (scope === "repo") {
    return {
      kind: "repository",
      label: oracleRepositoryFolderLabel(skillPath)
        ?? oracleSkillRootLabel(skillPath)
        ?? "Repository",
    };
  }
  return { kind: "other", label: oracleSkillRootLabel(skillPath) ?? "Other" };
}

function oracleWithSkillOrigins<T extends AppServerSkillSummary>(
  skills: readonly T[],
  directories: readonly SkillOriginDirectory[],
  options: SkillOriginOptions = {},
): T[] {
  return skills.map((skill) => {
    const origin = oracleClassifySkillOrigin(skill, directories, options);
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

// Generators that deliberately exercise nested roots, shared prefixes,
// duplicate roots, worktree ties, POSIX/Windows/UNC paths, casing variants,
// trailing slashes, and padding whitespace on the indexed fast path.
// Unicode case-length expansion is tested separately so it does not divert
// these runs onto the linear fallback.

const segmentArb = fc.constantFrom(
  "work",
  "Work",
  "PwrAgnt",
  "PwrAgntOld",
  "apps",
  "desktop",
  "wt",
  ".agents",
  ".codex",
  "skills",
);

const rootKindArb = fc.constantFrom("posix", "win-drive", "win-slash", "unc-win", "unc-posix", "slash-root", "empty-slashes");

const pathStyleWrap = (
  segments: string[],
  kind: string,
  trailingSlashes: number,
  padSpaces: boolean,
): string => {
  let raw: string;
  switch (kind) {
    case "win-drive":
      raw = `C:\\${segments.join("\\")}`;
      break;
    case "win-slash":
      raw = `c:/${segments.join("/")}`;
      break;
    case "unc-win":
      raw = `\\\\${segments.join("\\")}`;
      break;
    case "unc-posix":
      raw = `//${segments.join("/")}`;
      break;
    case "slash-root":
      raw = "/";
      break;
    case "empty-slashes":
      raw = "///";
      break;
    default:
      raw = `/${segments.join("/")}`;
      break;
  }
  const sep = kind === "win-drive" || kind === "unc-win" ? "\\" : "/";
  const suffixed = trailingSlashes > 0 ? `${raw}${sep.repeat(trailingSlashes)}` : raw;
  return padSpaces ? `  ${suffixed}  ` : suffixed;
};

const rootPathArb = fc
  .tuple(
    fc.array(segmentArb, { minLength: 1, maxLength: 4 }),
    rootKindArb,
    fc.integer({ min: 0, max: 3 }),
    fc.boolean(),
  )
  .map(([segments, kind, trailing, pad]) => pathStyleWrap(segments, kind, trailing, pad));

const directoryArb: fc.Arbitrary<SkillOriginDirectory> = fc
  .tuple(
    fc.constantFrom("", "  ", "Alpha", "Beta", "Gamma", "Delta"),
    rootPathArb,
    fc.option(rootPathArb, { nil: undefined }),
  )
  .map(([label, path, worktreePath]) => ({
    label,
    path,
    ...(worktreePath !== undefined ? { worktreePath } : {}),
  }));

const scopeArb = fc.constantFrom(
  undefined,
  "",
  "repo",
  "REPO",
  " user ",
  "system",
  "admin",
  "antigravity-user",
  "local",
);

const pluginIdArb = fc.constantFrom(
  undefined,
  "",
  "  ",
  "docs@marketplace",
  "solo-plugin",
);

describe("withSkillOrigins differential oracle", () => {
  it("matches the linear reference oracle across nested roots, ties, worktrees, normalization, and scopes", () => {
    fc.assert(
      fc.property(
        fc.array(directoryArb, { minLength: 0, maxLength: 12 }),
        fc.array(rootPathArb, { minLength: 0, maxLength: 3 }),
        fc.array(
          fc.record({
            name: fc.constantFrom("release", "deploy", "review", "lint"),
            dirChoice: fc.integer({ min: -2, max: 11 }),
            useWorktree: fc.boolean(),
            mutateCase: fc.boolean(),
            useBackslash: fc.boolean(),
            siblingSuffix: fc.constantFrom("", "Old", "-bak"),
            directEqual: fc.boolean(),
            extraSegments: fc.array(segmentArb, { minLength: 0, maxLength: 3 }),
            omitPath: fc.boolean(),
            trailingSlashes: fc.integer({ min: 0, max: 2 }),
            scope: scopeArb,
            pluginId: pluginIdArb,
            staleOrigin: fc.boolean(),
          }),
          { minLength: 0, maxLength: 24 },
        ),
        (directories, bundledSkillRoots, specs) => {
          const skills: AppServerSkillSummary[] = specs.map((spec) => {
            let skillPath: string | undefined;
            if (!spec.omitPath) {
              const pickedDir = spec.dirChoice >= 0 && spec.dirChoice < directories.length
                ? directories[spec.dirChoice]
                : undefined;
              const baseRoot = pickedDir
                ? (spec.useWorktree && pickedDir.worktreePath ? pickedDir.worktreePath : pickedDir.path)
                : spec.dirChoice === -1
                  ? "/Users/dev/.agents/skills"
                  : "C:\\Users\\dev\\external";
              const sep = spec.useBackslash ? "\\" : "/";
              const trimmedBase = baseRoot.trim();
              let composed = spec.directEqual
                ? trimmedBase
                : `${trimmedBase}${spec.siblingSuffix}${sep}${[...spec.extraSegments, spec.name, "SKILL.md"].join(sep)}`;
              if (spec.mutateCase) {
                composed = composed.toUpperCase();
              }
              if (spec.trailingSlashes > 0) {
                composed += sep.repeat(spec.trailingSlashes);
              }
              skillPath = composed;
            }
            return {
              name: spec.name,
              ...(skillPath !== undefined ? { path: skillPath } : {}),
              ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
              ...(spec.pluginId !== undefined ? { pluginId: spec.pluginId } : {}),
              ...(spec.staleOrigin ? { origin: { kind: "other" as const, label: "stale" } } : {}),
            };
          });

          const options: SkillOriginOptions = bundledSkillRoots.length > 0
            ? { bundledSkillRoots }
            : {};

          const actual = withSkillOrigins(skills, directories, options);
          const expected = oracleWithSkillOrigins(skills, directories, options);
          expect(actual).toEqual(expected);

          // Single-skill classifySkillOrigin must agree with batched withSkillOrigins.
          for (let i = 0; i < skills.length; i += 1) {
            expect(classifySkillOrigin(skills[i]!, directories, options)).toEqual(
              actual[i]!.origin,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("keeps Antigravity personal skills personal when their home directory is linked", () => {
    const home = [{ label: "Home", path: "/home/operator" }];
    const skills = withSkillOrigins<AppServerSkillSummary>([
      { name: "repo", path: "/home/operator/project/.agents/skills/repo/SKILL.md", scope: "repo" },
      { name: "personal", path: "/home/operator/.gemini/skills/personal/SKILL.md", scope: "antigravity-user" },
    ], home);
    expect(skills.map(({ origin }) => origin?.kind)).toEqual(["project", "personal"]);
  });

  it("preserves worktree precedence, early-directory ties, UNC casing ties in both orderings, and slash-root matching on the indexed path", () => {
    const baseDirectories: SkillOriginDirectory[] = [
      { label: "First", path: "/work/repo", worktreePath: "/work/repo/" },
      { label: "Second", path: "/work/repo" },
      { label: "Nested", path: "/work/repo/apps/desktop" },
      { label: "UncPosix", path: "//Server/Share" },
      { label: "UncWin", path: "\\\\server\\share" },
      { label: "Root", path: "/" },
    ];
    const skills: AppServerSkillSummary[] = [
      { name: "same-root", path: "/work/repo/.agents/skills/same-root/SKILL.md", scope: "repo" },
      { name: "nested", path: "/work/repo/apps/desktop/.agents/skills/nested/SKILL.md", scope: "repo" },
      { name: "unc-exact", path: "//Server/Share/.agents/skills/unc-exact/SKILL.md", scope: "repo" },
      { name: "unc-folded", path: "//SERVER/SHARE/.agents/skills/unc-folded/SKILL.md", scope: "repo" },
      { name: "unc-backslash", path: "\\\\SERVER\\SHARE\\.agents\\skills\\unc-backslash\\SKILL.md", scope: "repo" },
      { name: "slash-only", path: "/", scope: "repo" },
      { name: "root-child", path: "/unmatched", scope: "repo" },
    ];

    const actual = withSkillOrigins(skills, baseDirectories);
    expect(actual).toEqual(oracleWithSkillOrigins(skills, baseDirectories));
    expect(actual[0]?.origin).toEqual({ kind: "project", label: "First", directoryIndex: 0, worktree: true });
    expect(actual[1]?.origin).toEqual({ kind: "project", label: "Nested", directoryIndex: 2 });
    expect(actual[2]?.origin).toEqual({ kind: "project", label: "UncPosix", directoryIndex: 3 });
    expect(actual[3]?.origin).toEqual({ kind: "project", label: "UncWin", directoryIndex: 4 });
    expect(actual[4]?.origin).toEqual({ kind: "project", label: "UncPosix", directoryIndex: 3 });
    expect(actual[5]?.origin).toEqual({ kind: "project", label: "Root", directoryIndex: 5 });
    expect(actual[6]?.origin).toEqual({ kind: "project", label: "Root", directoryIndex: 5 });

    // Reversed UNC ordering: UncWin before UncPosix must win on exactHit && windowsHit ties.
    const reversedUncDirectories: SkillOriginDirectory[] = [
      { label: "UncWin", path: "\\\\server\\share" },
      { label: "UncPosix", path: "//Server/Share" },
    ];
    const uncSkills: AppServerSkillSummary[] = [
      { name: "unc-exact", path: "//Server/Share/.agents/skills/unc-exact/SKILL.md", scope: "repo" },
      { name: "unc-folded", path: "//SERVER/SHARE/.agents/skills/unc-folded/SKILL.md", scope: "repo" },
      { name: "unc-backslash", path: "\\\\SERVER\\SHARE\\.agents\\skills\\unc-backslash\\SKILL.md", scope: "repo" },
    ];
    const reversedActual = withSkillOrigins(uncSkills, reversedUncDirectories);
    expect(reversedActual).toEqual(oracleWithSkillOrigins(uncSkills, reversedUncDirectories));
    expect(reversedActual[0]?.origin).toEqual({ kind: "project", label: "UncWin", directoryIndex: 0 });
    expect(reversedActual[1]?.origin).toEqual({ kind: "project", label: "UncWin", directoryIndex: 0 });
    expect(reversedActual[2]?.origin).toEqual({ kind: "project", label: "UncWin", directoryIndex: 0 });
  });

  it("falls back cleanly when Unicode case folding changes path length", () => {
    const unicodeRootDirectories: SkillOriginDirectory[] = [
      { label: "UnicodeDotI", path: "C:\\İndex" },
      { label: "UnicodeCombined", path: "C:\\i\u0307ndex" },
    ];
    const skills: AppServerSkillSummary[] = [
      { name: "unicode-combined", path: "c:\\i\u0307ndex\\.agents\\skills\\unicode-combined\\SKILL.md", scope: "repo" },
      { name: "unicode-dot-i", path: "C:\\İndex\\.agents\\skills\\unicode-dot-i\\SKILL.md", scope: "repo" },
    ];
    const actual = withSkillOrigins(skills, unicodeRootDirectories);
    expect(actual).toEqual(oracleWithSkillOrigins(skills, unicodeRootDirectories));
    expect(actual[0]?.origin).toEqual({ kind: "project", label: "UnicodeCombined", directoryIndex: 1 });
    expect(actual[1]?.origin).toEqual({ kind: "project", label: "UnicodeCombined", directoryIndex: 1 });

    // Skill path itself expands on toLowerCase() against a standard Windows root.
    const standardDirs: SkillOriginDirectory[] = [
      { label: "CombinedOnly", path: "C:\\i\u0307ndex" },
    ];
    const skillExpands = withSkillOrigins([skills[1]!], standardDirs);
    expect(skillExpands).toEqual(oracleWithSkillOrigins([skills[1]!], standardDirs));
    expect(skillExpands[0]?.origin).toEqual({ kind: "project", label: "CombinedOnly", directoryIndex: 0 });
  });

  it("returns distinct origin objects per skill so callers cannot alias mutations across skills", () => {
    const directories: SkillOriginDirectory[] = [{ label: "Repo", path: "/work/repo" }];
    const [a, b] = withSkillOrigins<AppServerSkillSummary>(
      [
        { name: "one", path: "/work/repo/.agents/skills/one/SKILL.md", scope: "repo" },
        { name: "two", path: "/work/repo/.agents/skills/two/SKILL.md", scope: "repo" },
      ],
      directories,
    );
    expect(a?.origin).toEqual(b?.origin);
    expect(a?.origin).not.toBe(b?.origin);
  });
});
