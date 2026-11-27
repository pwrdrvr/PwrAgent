import { describe, expect, it } from "vitest";
import type { AppServerSkillSummary } from "@pwragent/shared/contracts/normalized-app-server";
import {
  applySkillOriginVisibility,
  createComposerDirectoryToken,
  createComposerSkillToken,
  resolveComposerDirectoryTokens,
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

describe("resolveComposerDirectoryTokens", () => {
  it("keeps the first token and first loaded row for each non-excluded path", () => {
    const first = { key: "first", kind: "workspace" as const, label: "repo", path: "C:/work/repo" };
    const duplicate = { ...first, key: "second", path: "C:\\work\\repo" };
    const tokens = ["/outside/", first.path, "/outside", duplicate.path, "/linked"].map((path, i) =>
      createComposerDirectoryToken({ label: `chip-${i}`, path }, i));

    const rows = resolveComposerDirectoryTokens(tokens, [first, duplicate], new Set(["/linked"]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      key: "directory-reference:/outside", kind: "directory", label: "chip-0", path: "/outside/",
    });
    expect(rows[1]).toBe(first);
  });

  it.each([[8, 16], [16, 8], [16, 16]])(
    "visits each of %i loaded directory paths at most once for %i tokens",
    (directoryCount, tokenCount) => {
      let reads = 0;
      const rows = Array.from({ length: directoryCount }, (_, i) => ({
        key: `row-${i}`,
        kind: "directory" as const,
        label: `repo-${i}`,
        get path() {
          reads += 1;
          return `/work/repo-${i}`;
        },
      }));
      const tokens = Array.from({ length: tokenCount }, (_, i) =>
        createComposerDirectoryToken({ label: `repo-${i}`, path: `/work/repo-${i}` }, i)).reverse();

      const resolved = resolveComposerDirectoryTokens(tokens, rows, new Set());
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThanOrEqual(directoryCount);
      expect(resolved.map((row) => row.key)).toEqual(tokens.map((token) =>
        rows[token.index]?.key ?? `directory-reference:${token.path}`));
      for (const [i, token] of tokens.entries()) {
        if (rows[token.index]) expect(resolved[i]).toBe(rows[token.index]);
      }
    },
  );
});
