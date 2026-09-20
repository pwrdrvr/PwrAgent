import { describe, expect, it } from "vitest";
import type { AppServerSkillSummary } from "@pwragent/shared";
import {
  applySkillOriginVisibility,
  createComposerSkillToken,
} from "../composer-mention-tokens";

const releasePath = (project: string) =>
  `/Users/fixture-user/pwrdrvr/${project}/.agents/skills/release/SKILL.md`;

const release = (project: string, directoryIndex: number): AppServerSkillSummary => ({
  name: "release",
  description: `Release ${project}`,
  path: releasePath(project),
  origin: { kind: "project", label: project, directoryIndex },
});

const slidev: AppServerSkillSummary = {
  name: "slidev",
  path: "/Users/fixture-user/.agents/skills/slidev/SKILL.md",
  origin: { kind: "personal", label: "Personal" },
};

describe("applySkillOriginVisibility", () => {
  it("labels a chip minted before the catalog loaded", () => {
    // The draft was restored on launch, when nothing had called listSkills.
    const token = createComposerSkillToken(release("Harbor", 1), 0, []);
    expect(token.showOrigin).toBeUndefined();

    const [refreshed] = applySkillOriginVisibility(
      [token],
      [release("Northwind", 0), release("Harbor", 1), slidev],
    );
    expect(refreshed).toMatchObject({
      name: "release",
      origin: { label: "Harbor" },
      showOrigin: true,
    });
  });

  it("finds the origin in the catalog for a chip that carries none", () => {
    // A chip restored from plain `[$release](path)` markdown.
    const [refreshed] = applySkillOriginVisibility(
      [{ id: "a", index: 0, name: "release", path: releasePath("Harbor") }],
      [release("Northwind", 0), release("Harbor", 1)],
    );
    expect(refreshed?.origin).toEqual({
      kind: "project",
      label: "Harbor",
      directoryIndex: 1,
    });
    expect(refreshed?.showOrigin).toBe(true);
  });

  it("drops a label once the name is no longer shared", () => {
    const token = createComposerSkillToken(release("Harbor", 1), 0, [
      release("Northwind", 0),
      release("Harbor", 1),
    ]);
    expect(token.showOrigin).toBe(true);

    // Northwind was unlinked; `$release` says which file it runs again.
    const [refreshed] = applySkillOriginVisibility([token], [release("Harbor", 0)]);
    expect(refreshed?.showOrigin).toBeUndefined();
  });

  it("keeps the array identity when nothing moves, and an empty catalog changes nothing", () => {
    const catalog = [release("Northwind", 0), release("Harbor", 1)];
    const tokens = [createComposerSkillToken(release("Harbor", 1), 0, catalog)];

    // A new array would rebuild the editor's document on every render.
    expect(applySkillOriginVisibility(tokens, catalog)).toBe(tokens);
    // An empty catalog means "not loaded", never "no collisions".
    expect(applySkillOriginVisibility(tokens, [])).toBe(tokens);
    expect(applySkillOriginVisibility(tokens, undefined)).toBe(tokens);
  });

  it("leaves chips that are not skills alone", () => {
    const tokens = [
      {
        id: "dir",
        index: 0,
        kind: "directory" as const,
        name: "release",
        path: "/Users/fixture-user/pwrdrvr/Harbor",
      },
    ];
    expect(applySkillOriginVisibility(tokens, [release("Harbor", 1)])).toBe(tokens);
  });
});
