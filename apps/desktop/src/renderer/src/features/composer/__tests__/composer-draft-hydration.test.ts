import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it, vi } from "vitest";
import { buildThreadMarkdownLink, buildThreadUrl } from "@pwragent/shared/contracts/thread-link";
import { type AppServerSkillSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { ThreadLinkHoverStore, type ThreadLinkContextValue } from "../../../lib/thread-links";
import { hydrateComposerDraft } from "../composer-draft-hydration";
import { serializeDraftWithSkillTokens } from "../composer-mention-tokens";

vi.mock("mdast-util-from-markdown", { spy: true });

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
  const thread = {
    backend: "codex" as const,
    threadId: "thread-code-title",
    title: "Fix `foo` crash",
  };
  const threadLinks: ThreadLinkContextValue = {
    resolve: (ref) => ref.threadId === thread.threadId ? thread : undefined,
    openRemoteViewer: () => undefined,
    show: () => undefined,
    getSnapshot: (link) => link,
    subscribe: () => () => undefined,
    hoverTarget: new ThreadLinkHoverStore(),
  };
  it("restores a paste with an incomplete link target without running CommonMark", () => {
    vi.mocked(fromMarkdown).mockClear();
    const text = "log) " + "[$a](x ".repeat(100);
    expect(hydrateComposerDraft(text, [], threadLinks, undefined)).toEqual({ draft: text, skillTokens: [] });
    expect(fromMarkdown).not.toHaveBeenCalled();
  });

  it("restores a CommonMark thread autolink without a bracketed label", () => {
    const url = buildThreadUrl(thread);
    const restored = hydrateComposerDraft(`See <${url}>`, [], threadLinks, undefined);
    expect(restored.draft).toBe("See ");
    expect(restored.skillTokens[0]).toMatchObject({ kind: "thread", index: 4, path: url });
  });

  it("bounds catalog path reads when restoring repeated skill chips", () => {
    let pathReads = 0;
    const catalog = Array.from({ length: 32 }, (_, i) => ({
      name: `s${i}`,
      get path() { pathReads += 1; return `/p/${i}`; },
    }));
    const restored = hydrateComposerDraft("[$s31](/p/31) ".repeat(32), catalog, undefined, undefined);
    expect(restored.skillTokens).toHaveLength(32);
    expect(pathReads).toBeLessThanOrEqual(2 * catalog.length + 2 * restored.skillTokens.length);
  });

  const labeledReferences = [
    {
      kind: "thread",
      link: buildThreadMarkdownLink(thread),
      path: buildThreadUrl(thread),
    },
    {
      kind: "pull-request",
      link: "[Fix `foo` crash](https://github.com/fixture/project/pull/42)",
      path: "https://github.com/fixture/project/pull/42",
    },
    {
      kind: "skill",
      link: "[$fix `foo`](/skills/fix/SKILL.md)",
      path: "/skills/fix/SKILL.md",
    },
    {
      kind: "directory",
      link: "[@fix `foo`](/project/src)",
      path: "/project/src",
    },
  ];

  it.each(labeledReferences)("hydrates a $kind link whose label contains inline code", ({ kind, link, path }) => {
    const prefix = "Keep `literal` intact. See ";
    const result = hydrateComposerDraft(`${prefix}${link} please.`, [], threadLinks, undefined);
    expect(result.draft).toBe(`${prefix} please.`);
    expect(result.skillTokens).toHaveLength(1);
    expect(result.skillTokens[0]).toMatchObject({ path, index: prefix.length });
    expect(result.skillTokens[0].kind ?? "skill").toBe(kind);
    if (kind === "thread") {
      expect(result.skillTokens[0].name).toBe(thread.title);
      expect(serializeDraftWithSkillTokens(result.draft, result.skillTokens))
        .toBe(`${prefix}${link} please.`);
    }
  });

  it.each(labeledReferences)("keeps a whole $kind link literal inside code despite code-formatted labels", ({ link }) => {
    for (const code of [`\`\`${link}\`\``, `\`\`\`\n${link}\n\`\`\``]) {
      const prefix = `${code}\n\nSee `;
      const result = hydrateComposerDraft(`${prefix}${buildThreadMarkdownLink(thread)}.`, [], threadLinks, undefined);
      expect(result.draft).toBe(`${prefix}.`);
      expect(result.skillTokens).toHaveLength(1);
      expect(result.skillTokens[0]).toMatchObject({ kind: "thread", index: prefix.length });
    }
  });

  it("keeps a literal reference inside the code-formatted label of an unrelated link", () => {
    const source = "[Example `[#42](https://github.com/fixture/project/pull/42)`](https://example.com)";
    expect(hydrateComposerDraft(source, [], threadLinks, undefined)).toEqual({
      draft: source,
      skillTokens: [],
    });
  });

  it.each([
    "```\nCONTENT\n```",
    "```markdown\nCONTENT\n```",
    "~~~\nCONTENT\n~~~",
    "```\nCONTENT",
    "    CONTENT",
    "`CONTENT`",
    "``CONTENT with `backticks` ``",
    "> ```\n> CONTENT\n> ```",
  ])("keeps reference links literal inside code: %s", (wrapper) => {
    const references = "[#42](https://github.com/fixture/project/pull/42) [$release](/skills/release/SKILL.md) [@src](~/project/src)";
    const code = wrapper.replace("CONTENT", references);
    const source = `Keep \`%APPDATA%\` intact.\n\n${code}\n\n`;
    expect(hydrateComposerDraft(source, [], undefined, undefined)).toEqual({
      draft: source,
      skillTokens: [],
    });
  });

  it("hydrates links outside code without moving their offsets across literal references", () => {
    const link = "[#42](https://github.com/fixture/project/pull/42)";
    const prefix = `Keep \`${link}\` literal.\n\nSee `;
    const result = hydrateComposerDraft(`${prefix}${link}.`, [], undefined, undefined);
    expect(result.draft).toBe(`${prefix}.`);
    expect(result.skillTokens).toHaveLength(1);
    expect(result.skillTokens[0]).toMatchObject({ kind: "pull-request", index: prefix.length });
  });

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
