import { describe, expect, it } from "vitest";
import type { AppServerSkillSummary } from "../contracts/normalized-app-server";
import {
  classifySkillOrigin,
  compareSkillOrigins,
  describeSkillOriginKind,
  skillOriginMarketplace,
  withSkillOrigins,
  type SkillOriginDirectory,
} from "../skill-origin";

// The layout from the report that prompted this: one thread, three linked
// projects, and each project ships its own `.agents/skills/release`.
const directories: SkillOriginDirectory[] = [
  { label: "PwrSnap", path: "/Users/fixture-user/pwrdrvr/PwrSnap" },
  { label: "PwrAgnt", path: "/Users/fixture-user/pwrdrvr/PwrAgnt" },
  { label: "PwrGit", path: "/Users/fixture-user/pwrdrvr/PwrGit" },
];

describe("classifySkillOrigin", () => {
  it("names the linked project a repo skill lives in, and marks the primary", () => {
    expect(
      classifySkillOrigin(
        {
          path: "/Users/fixture-user/pwrdrvr/PwrSnap/.agents/skills/release/SKILL.md",
          scope: "repo",
        },
        directories,
      ),
    ).toEqual({ kind: "project", label: "PwrSnap", directoryIndex: 0 });
    expect(
      classifySkillOrigin(
        {
          path: "/Users/fixture-user/pwrdrvr/PwrGit/.agents/skills/release/SKILL.md",
          scope: "repo",
        },
        directories,
      ),
    ).toEqual({ kind: "project", label: "PwrGit", directoryIndex: 2 });
  });

  it("matches a worktree checkout and keeps the project's label", () => {
    expect(
      classifySkillOrigin(
        {
          path: "/Users/fixture-user/.codex/worktrees/4f2a/PwrSnap/.agents/skills/release/SKILL.md",
          scope: "repo",
        },
        [
          {
            label: "PwrSnap",
            path: "/Users/fixture-user/pwrdrvr/PwrSnap",
            worktreePath: "/Users/fixture-user/.codex/worktrees/4f2a/PwrSnap",
          },
        ],
      ),
    ).toEqual({
      kind: "project",
      label: "PwrSnap",
      directoryIndex: 0,
      worktree: true,
    });
  });

  it("gives the skill to the deepest linked directory that contains it", () => {
    expect(
      classifySkillOrigin(
        {
          path: "/Users/fixture-user/pwrdrvr/PwrAgnt/apps/desktop/.agents/skills/e2e/SKILL.md",
          scope: "repo",
        },
        [
          { label: "PwrAgnt", path: "/Users/fixture-user/pwrdrvr/PwrAgnt" },
          { label: "desktop", path: "/Users/fixture-user/pwrdrvr/PwrAgnt/apps/desktop" },
        ],
      ),
    ).toMatchObject({ kind: "project", label: "desktop", directoryIndex: 1 });
  });

  it("does not treat a sibling folder with a shared prefix as inside", () => {
    expect(
      classifySkillOrigin(
        {
          path: "/Users/fixture-user/pwrdrvr/PwrSnapOld/.agents/skills/release/SKILL.md",
          scope: "repo",
        },
        directories,
      ),
    ).toEqual({ kind: "repository", label: "PwrSnapOld" });
  });

  it("labels a repo skill outside every linked directory by its repository folder", () => {
    expect(
      classifySkillOrigin(
        { path: "/Users/fixture-user/pwrdrvr/.agents/skills/shared/SKILL.md", scope: "repo" },
        directories,
      ),
    ).toEqual({ kind: "repository", label: "pwrdrvr" });
  });

  it("trusts scope before the path, so a linked home folder does not claim personal skills", () => {
    const home: SkillOriginDirectory[] = [{ label: "fixture-user", path: "/Users/fixture-user" }];
    expect(
      classifySkillOrigin(
        { path: "/Users/fixture-user/.agents/skills/slidev/SKILL.md", scope: "user" },
        home,
      ),
    ).toEqual({ kind: "personal", label: "Personal" });
    expect(
      classifySkillOrigin(
        { path: "/Users/fixture-user/.codex/skills/.system/imagegen/SKILL.md", scope: "system" },
        home,
      ),
    ).toEqual({ kind: "built-in", label: "Built-in" });
  });

  it("splits Codex's two user roots without knowing where Codex home is", () => {
    expect(
      classifySkillOrigin(
        { path: "/Users/fixture-user/.agents/skills/slidev/SKILL.md", scope: "user" },
        directories,
      ),
    ).toEqual({ kind: "personal", label: "Personal" });
    // A PwrAgent Codex profile can move CODEX_HOME anywhere.
    expect(
      classifySkillOrigin(
        { path: "/Users/fixture-user/.pwragent/codex-work/skills/confluence/SKILL.md", scope: "user" },
        directories,
      ),
    ).toEqual({ kind: "codex-home", label: "Codex home" });
  });

  it("names a plugin skill by its plugin, ahead of its scope", () => {
    const origin = classifySkillOrigin(
      {
        path: "/Users/fixture-user/.codex/plugins/cache/openai-primary-runtime/documents/26.904.11930/skills/documents/SKILL.md",
        pluginId: "documents@openai-primary-runtime",
        scope: "user",
      },
      directories,
    );
    expect(origin).toEqual({
      kind: "plugin",
      label: "documents",
      pluginId: "documents@openai-primary-runtime",
    });
    expect(origin && skillOriginMarketplace(origin)).toBe("openai-primary-runtime");
  });

  it("recognizes admin skills", () => {
    expect(
      classifySkillOrigin({ path: "/etc/codex/skills/lint/SKILL.md", scope: "admin" }, directories),
    ).toEqual({ kind: "admin", label: "Admin" });
  });

  it("falls back to the folder above the skill for an unknown root", () => {
    expect(
      classifySkillOrigin({ path: "/opt/team-skills/lint/SKILL.md" }, directories),
    ).toEqual({ kind: "other", label: "team-skills" });
    expect(
      classifySkillOrigin({ path: "/opt/team/skills/lint/SKILL.md" }, directories),
    ).toEqual({ kind: "other", label: "team" });
  });

  it("matches a project without a scope, for backends that send none", () => {
    expect(
      classifySkillOrigin(
        { path: "/Users/fixture-user/pwrdrvr/PwrAgnt/.codex/skills/ce-plan/SKILL.md" },
        directories,
      ),
    ).toMatchObject({ kind: "project", label: "PwrAgnt" });
  });

  it("matches Windows paths case-insensitively and across separators", () => {
    expect(
      classifySkillOrigin(
        { path: "c:\\Users\\Fixture\\src\\PwrSnap\\.agents\\skills\\release\\SKILL.md", scope: "repo" },
        [{ label: "PwrSnap", path: "C:\\Users\\Fixture\\src\\PwrSnap" }],
      ),
    ).toMatchObject({ kind: "project", label: "PwrSnap" });
    expect(
      classifySkillOrigin(
        { path: "C:\\Users\\Fixture\\.agents\\skills\\slidev\\SKILL.md", scope: "user" },
        [],
      ),
    ).toEqual({ kind: "personal", label: "Personal" });
  });

  it("has nothing to say about a skill without a path", () => {
    expect(classifySkillOrigin({ scope: "repo" }, directories)).toBeUndefined();
  });
});

describe("compareSkillOrigins", () => {
  it("orders the primary project, then linked projects, then everything else", () => {
    const skills = withSkillOrigins<AppServerSkillSummary>(
      [
        { name: "release", path: "/Users/fixture-user/.codex/skills/.system/release/SKILL.md", scope: "system" },
        { name: "release", path: "/Users/fixture-user/pwrdrvr/PwrGit/.agents/skills/release/SKILL.md", scope: "repo" },
        { name: "release", path: "/Users/fixture-user/.agents/skills/release/SKILL.md", scope: "user" },
        { name: "release", path: "/Users/fixture-user/pwrdrvr/PwrSnap/.agents/skills/release/SKILL.md", scope: "repo" },
        { name: "release", path: "/Users/fixture-user/pwrdrvr/PwrAgnt/.agents/skills/release/SKILL.md", scope: "repo" },
      ],
      directories,
    );
    expect(
      [...skills]
        .sort((left, right) => compareSkillOrigins(left.origin, right.origin))
        .map((skill) => skill.origin?.label),
    ).toEqual(["PwrSnap", "PwrAgnt", "PwrGit", "Personal", "Built-in"]);
  });

  it("sorts a skill with no origin last", () => {
    expect(compareSkillOrigins(undefined, { kind: "other", label: "x" })).toBeGreaterThan(0);
  });
});

describe("withSkillOrigins", () => {
  it("attaches origins and drops a stale one when there is no path", () => {
    const [withPath, withoutPath] = withSkillOrigins(
      [
        { name: "release", path: "/Users/fixture-user/pwrdrvr/PwrGit/.agents/skills/release/SKILL.md", scope: "repo" },
        { name: "legacy", origin: { kind: "other", label: "stale" } },
      ],
      directories,
    );
    expect(withPath?.origin).toMatchObject({ kind: "project", label: "PwrGit" });
    expect(withoutPath).toEqual({ name: "legacy" });
  });
});

describe("describeSkillOriginKind", () => {
  it("tells the primary, a linked project, and a worktree apart", () => {
    expect(describeSkillOriginKind({ kind: "project", label: "PwrSnap", directoryIndex: 0 }))
      .toBe("Project skill · primary");
    expect(describeSkillOriginKind({ kind: "project", label: "PwrGit", directoryIndex: 2 }))
      .toBe("Project skill · linked");
    expect(
      describeSkillOriginKind({ kind: "project", label: "PwrSnap", directoryIndex: 0, worktree: true }),
    ).toBe("Project skill · worktree");
  });
});
