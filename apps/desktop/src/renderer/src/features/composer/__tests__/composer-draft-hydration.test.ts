import { describe, expect, it } from "vitest";
import type { AppServerSkillSummary } from "@pwragent/shared";
import { hydrateComposerDraft } from "../composer-draft-hydration";

const releasePath = (project: string) =>
  `/Users/fixture-user/pwrdrvr/${project}/.agents/skills/release/SKILL.md`;

const release = (project: string, directoryIndex: number): AppServerSkillSummary => ({
  name: "release",
  description: `Release ${project}`,
  path: releasePath(project),
  scope: "repo",
  origin: { kind: "project", label: project, directoryIndex },
});

describe("hydrateComposerDraft skill chips", () => {
  it("restores a same-named skill by its path, with its origin on the chip", () => {
    const { skillTokens } = hydrateComposerDraft(
      `Use [$release](${releasePath("PwrAgnt")})`,
      [release("PwrSnap", 0), release("PwrAgnt", 1)],
      undefined,
      undefined,
    );
    expect(skillTokens).toHaveLength(1);
    expect(skillTokens[0]).toMatchObject({
      name: "release",
      path: releasePath("PwrAgnt"),
      origin: { kind: "project", label: "PwrAgnt" },
      showOrigin: true,
    });
  });

  it("keeps an unknown path when the name alone cannot say which skill it was", () => {
    // PwrGit was unlinked since the draft was written. Falling back to the
    // first `release` by name would send PwrSnap's.
    const { skillTokens } = hydrateComposerDraft(
      `Use [$release](${releasePath("PwrGit")})`,
      [release("PwrSnap", 0), release("PwrAgnt", 1)],
      undefined,
      undefined,
    );
    expect(skillTokens[0]).toMatchObject({
      name: "release",
      path: releasePath("PwrGit"),
    });
    expect(skillTokens[0]?.origin).toBeUndefined();
    expect(skillTokens[0]?.showOrigin).toBeUndefined();
  });

  it("still follows a moved skill when its name is unique", () => {
    const { skillTokens } = hydrateComposerDraft(
      "Use [$release](/Users/fixture-user/old-checkout/.agents/skills/release/SKILL.md)",
      [release("PwrSnap", 0)],
      undefined,
      undefined,
    );
    expect(skillTokens[0]).toMatchObject({
      path: releasePath("PwrSnap"),
      origin: { label: "PwrSnap" },
    });
    // Nothing shares the name, so the chip does not need to say where.
    expect(skillTokens[0]?.showOrigin).toBeUndefined();
  });
});
