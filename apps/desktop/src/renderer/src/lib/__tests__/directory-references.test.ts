import { describe, expect, it } from "vitest";
import type { NavigationDirectorySummary } from "@pwragent/shared";
import {
  buildDirectoryReferenceInsertText,
  buildDirectoryReferenceMarkdown,
  buildFileReferenceTooltip,
  decodeMarkdownDestination,
  fileLabelFromPath,
  filterDirectoryReferenceCandidates,
  findDirectoryReferenceTrigger,
  listReferencedDirectories,
} from "../directory-references";

const HOME = "/Users/example";

function makeDirectory(
  overrides: Partial<NavigationDirectorySummary> & { key: string },
): NavigationDirectorySummary {
  return {
    kind: "directory",
    label: overrides.key,
    threadKeys: [],
    needsAttentionCount: 0,
    ...overrides,
  };
}

const CATALOG_SERVICE = makeDirectory({
  key: "dir:catalog-service",
  label: "catalog-service",
  path: `${HOME}/Projects/catalog-service`,
  latestUpdatedAt: 300,
});
const CATALOG_PORTAL = makeDirectory({
  key: "dir:catalog-portal",
  label: "catalog-portal",
  path: `${HOME}/Projects/catalog-portal`,
  latestUpdatedAt: 200,
});
const PWRAGNT = makeDirectory({
  key: "dir:pwragnt",
  label: "PwrAgnt",
  path: `${HOME}/pwrdrvr/PwrAgnt`,
  latestUpdatedAt: 100,
});
const UNLINKED = makeDirectory({
  key: "dir:unlinked",
  kind: "unlinked",
  label: "Unlinked",
  latestUpdatedAt: 400,
});

/** The serialized `@` chip the composer sends for a path. */
function chip(path: string): string {
  return buildDirectoryReferenceMarkdown({ label: fileLabelFromPath(path), path });
}

describe("Windows directory reference round trips", () => {
  it.each(["C:/Projects", "C:\\Projects", "//server/share", "\\\\server\\share"])(
    "links the deepest directory after inserting a native path under %s",
    (root) => {
      const parent = makeDirectory({ key: "parent", path: root });
      const child = makeDirectory({ key: "child", path: `${root}/app` });
      const sibling = makeDirectory({ key: "sibling", path: `${root}/app-other` });
      const nativePath = buildDirectoryReferenceInsertText(child);
      const draft = `Read ${chip(`${nativePath}\\src\\file.ts`)}`;
      expect(listReferencedDirectories(draft, [parent, child, sibling])).toEqual([child]);
      expect(listReferencedDirectories(draft, [child], { excludePaths: [nativePath] })).toEqual([]);
      expect(listReferencedDirectories(draft, [parent, child], { excludePaths: [nativePath] })).toEqual([]);
      expect(listReferencedDirectories(
        `100% done: ${buildDirectoryReferenceMarkdown({ label: "app", path: child.path! })}`,
        [parent, child],
      )).toEqual([child]);
    },
  );

  it("keeps POSIX backslashes as filename characters", () => {
    const parent = makeDirectory({ key: "parent", path: "/repo" });
    const sibling = makeDirectory({ key: "sibling", path: "/repo\\other" });
    expect(listReferencedDirectories(`Read ${chip("/repo\\other/file.ts")}`, [parent, sibling]))
      .toEqual([sibling]);
    expect(listReferencedDirectories(`Read ${chip("/repo")} and ${chip("/repo\\other")}`, [parent, sibling]))
      .toEqual([parent, sibling]);
  });
});

describe("findDirectoryReferenceTrigger", () => {
  it.each(["C:/Projects/app", "C:\\Projects\\app", "\\\\server\\share\\app"])(
    "keeps autocomplete open while typing a Windows path: %s",
    (query) => {
      const text = `see @${query}`;
      expect(findDirectoryReferenceTrigger(text, text.length)).toEqual({
        start: 4,
        end: text.length,
        query,
      });
    },
  );

  it("matches a bare @ at the start of the draft", () => {
    expect(findDirectoryReferenceTrigger("@", 1)).toEqual({
      start: 0,
      end: 1,
      query: "",
    });
  });

  it("matches @ after whitespace and captures the query", () => {
    const text = "check out @cat";
    expect(findDirectoryReferenceTrigger(text, text.length)).toEqual({
      start: 10,
      end: text.length,
      query: "cat",
    });
  });

  it("allows path-ish query characters", () => {
    const text = "see @~/Projects/catalog";
    expect(findDirectoryReferenceTrigger(text, text.length)?.query).toBe(
      "~/Projects/catalog",
    );
  });

  it("does not trigger inside an email address", () => {
    const text = "mail fixtureuser@example.com";
    expect(findDirectoryReferenceTrigger(text, text.length)).toBeUndefined();
  });

  it("does not trigger when the caret is before the @", () => {
    expect(findDirectoryReferenceTrigger("@cat", 0)).toBeUndefined();
  });
});

describe("filterDirectoryReferenceCandidates", () => {
  const directories = [PWRAGNT, CATALOG_PORTAL, CATALOG_SERVICE, UNLINKED];

  it.each([
    ["C:/Projects/app", "C:\\Projects\\app"],
    ["C:\\Projects\\app", "Projects/app"],
    ["//server/share/app", "\\\\server\\share\\app"],
    ["\\\\server\\share\\app", "//server/share/app"],
  ])("matches Windows directory %s using query %s", (path, query) => {
    const directory = makeDirectory({ key: "windows", label: "app", path });
    expect(filterDirectoryReferenceCandidates([directory], query)).toEqual([directory]);
  });

  it("keeps backslashes literal when searching POSIX directory names", () => {
    const directory = makeDirectory({ key: "posix", path: "/repo/folder\\name" });
    expect(filterDirectoryReferenceCandidates([directory], "folder/name")).toEqual([]);
    expect(filterDirectoryReferenceCandidates([directory], "folder\\name")).toEqual([directory]);
  });

  it("returns referenceable directories most recently updated first", () => {
    expect(
      filterDirectoryReferenceCandidates(directories, "").map((d) => d.key),
    ).toEqual([CATALOG_SERVICE.key, CATALOG_PORTAL.key, PWRAGNT.key]);
  });

  it("filters by label", () => {
    expect(
      filterDirectoryReferenceCandidates(directories, "portal").map((d) => d.key),
    ).toEqual([CATALOG_PORTAL.key]);
  });

  it("filters by path substring", () => {
    expect(
      filterDirectoryReferenceCandidates(directories, "Projects/").map((d) => d.key),
    ).toEqual([CATALOG_SERVICE.key, CATALOG_PORTAL.key]);
  });

  it("keeps a project-name prefix ahead of a newer path-only match as the query grows", () => {
    const workspaces = makeDirectory({
      key: "dir:workspaces",
      label: "Workspaces",
      path: `${HOME}/.pwragent/profiles/default/projects/PwrAgnt-workspaces`,
      latestUpdatedAt: 500,
    });

    for (const query of ["pwr", "Pwrag"]) {
      expect(
        filterDirectoryReferenceCandidates([workspaces, PWRAGNT], query).map((d) => d.key),
      ).toEqual([PWRAGNT.key, workspaces.key]);
    }
  });

  it("includes older project-name prefixes before applying the ten-result limit", () => {
    const pathMatches = Array.from({ length: 10 }, (_, index) =>
      makeDirectory({
        key: `dir:path-${index}`,
        label: `Workspace ${index}`,
        path: `${HOME}/pwragnt/workspace-${index}`,
        latestUpdatedAt: index + 200,
      }),
    );

    expect(
      filterDirectoryReferenceCandidates([...pathMatches, PWRAGNT], "pwrag")
        .map((d) => d.key),
    ).toEqual([PWRAGNT.key, ...pathMatches.slice().reverse().slice(0, 9).map((d) => d.key)]);
  });

  it("excludes unlinked pseudo-directories and path-less entries", () => {
    const pathless = makeDirectory({ key: "dir:pathless", latestUpdatedAt: 500 });
    expect(
      filterDirectoryReferenceCandidates([UNLINKED, pathless], ""),
    ).toEqual([]);
  });

  it("caps the result at ten candidates", () => {
    const many = Array.from({ length: 15 }, (_, index) =>
      makeDirectory({
        key: `dir:${index}`,
        path: `${HOME}/repos/repo-${index}`,
        latestUpdatedAt: index,
      }),
    );
    expect(filterDirectoryReferenceCandidates(many, "")).toHaveLength(10);
  });
});

describe("fileLabelFromPath", () => {
  it("returns the basename of a posix path", () => {
    expect(fileLabelFromPath("/Users/fixture-user/notes/notes.txt")).toBe(
      "notes.txt",
    );
  });

  it("returns the basename of a windows path", () => {
    expect(fileLabelFromPath("C:\\Users\\fixture-user\\notes\\report.pdf")).toBe(
      "report.pdf",
    );
  });

  it("ignores a trailing separator", () => {
    expect(fileLabelFromPath("/Users/fixture-user/notes/")).toBe("notes");
  });

  it("returns a bare name unchanged", () => {
    expect(fileLabelFromPath("notes.txt")).toBe("notes.txt");
  });

  it("falls back to the input when no segment survives", () => {
    expect(fileLabelFromPath("")).toBe("");
    expect(fileLabelFromPath("///")).toBe("///");
  });
});

describe("buildFileReferenceTooltip", () => {
  it("returns just the tilde path with no linked suffix", () => {
    expect(
      buildFileReferenceTooltip(`${HOME}/notes/notes.txt`, HOME),
    ).toBe("~/notes/notes.txt");
  });
});

describe("buildDirectoryReferenceInsertText", () => {
  it("tildifies the directory path", () => {
    expect(buildDirectoryReferenceInsertText(CATALOG_PORTAL, HOME)).toBe(
      "~/Projects/catalog-portal",
    );
  });

  it("leaves paths outside home unchanged", () => {
    expect(
      buildDirectoryReferenceInsertText({ path: "/opt/work/app" }, HOME),
    ).toBe("/opt/work/app");
  });
});

describe("buildDirectoryReferenceMarkdown", () => {
  it("builds a bounded markdown link with the tilde path", () => {
    expect(
      buildDirectoryReferenceMarkdown(
        { label: "catalog-portal", path: `${HOME}/Projects/catalog-portal` },
        HOME,
      ),
    ).toBe("[@catalog-portal](~/Projects/catalog-portal)");
  });

  it("stays scannable when text glues onto the link", () => {
    const markdown = buildDirectoryReferenceMarkdown(
      { label: "catalog-portal", path: `${HOME}/Projects/catalog-portal` },
      HOME,
    );
    expect(
      listReferencedDirectories(`${markdown}are two of my fave projects`, [CATALOG_PORTAL], {
        homeDir: HOME,
      }).map((d) => d.key),
    ).toEqual([CATALOG_PORTAL.key]);
  });

  it("percent-encodes parens, spaces, and percents in the destination", () => {
    const markdown = buildDirectoryReferenceMarkdown(
      { label: "repo", path: `${HOME}/Backup (50% old)/repo` },
      HOME,
    );
    expect(markdown).toBe("[@repo](~/Backup%20%2850%25%20old%29/repo)");
    expect(decodeMarkdownDestination("~/Backup%20%2850%25%20old%29/repo")).toBe(
      "~/Backup (50% old)/repo",
    );
  });

  it("leaves never-encoded destinations unchanged when decoding", () => {
    expect(decodeMarkdownDestination("~/Projects/catalog-portal")).toBe(
      "~/Projects/catalog-portal",
    );
    expect(decodeMarkdownDestination("~/100%-legit")).toBe("~/100%-legit");
  });

  it("falls back to the bare tilde path for a link-breaking label", () => {
    expect(
      buildDirectoryReferenceMarkdown(
        { label: "weird]name", path: `${HOME}/weird]name` },
        HOME,
      ),
    ).toBe("~/weird]name");
  });
});

describe("listReferencedDirectories", () => {
  const directories = [CATALOG_SERVICE, CATALOG_PORTAL, PWRAGNT, UNLINKED];

  it("finds a tilde-path chip", () => {
    expect(
      listReferencedDirectories(
        "You might be able to see it in [@catalog-portal](~/Projects/catalog-portal).",
        directories,
        { homeDir: HOME },
      ).map((d) => d.key),
    ).toEqual([CATALOG_PORTAL.key]);
  });

  it("finds an absolute-path chip", () => {
    expect(
      listReferencedDirectories(
        `compare against [@PwrAgnt](${HOME}/pwrdrvr/PwrAgnt) please`,
        directories,
        { homeDir: HOME },
      ).map((d) => d.key),
    ).toEqual([PWRAGNT.key]);
  });

  it("resolves a file chip to its tracked repo", () => {
    expect(
      listReferencedDirectories(
        "look at [@build.sbt](~/Projects/catalog-service/build.sbt)",
        directories,
        { homeDir: HOME },
      ).map((d) => d.key),
    ).toEqual([CATALOG_SERVICE.key]);
  });

  // Typed or pasted text is not a reference. A pasted log, a diagnostics
  // block, or a stack trace mentions paths in other projects all the time,
  // and linking each of them moved threads into unrelated project groups.
  it.each([
    ["a tilde path", "You might be able to see it in ~/Projects/catalog-portal."],
    ["an absolute path", `compare against ${HOME}/pwrdrvr/PwrAgnt please`],
    ["a deeper file path", "look at ~/Projects/catalog-service/build.sbt"],
    ["a path in a pasted code block", [
      "what went wrong with this thread?",
      "```",
      "Collected at (UTC): 2026-10-28T02:23:21.875Z",
      `Project directory/worktree path: ${HOME}/Projects/catalog-portal/2026-10-27-ae1587`,
      `Log path: ${HOME}/pwrdrvr/PwrAgnt/apps/desktop/main.log`,
      "```",
    ].join("\n")],
  ])("does not attach %s written as plain text", (_label, draft) => {
    expect(listReferencedDirectories(draft, directories, { homeDir: HOME })).toEqual([]);
  });

  it("attaches only the chip when plain text names other projects", () => {
    expect(
      listReferencedDirectories(
        `Use [@catalog-portal](~/Projects/catalog-portal). Logs: ${HOME}/pwrdrvr/PwrAgnt/main.log`,
        directories,
        { homeDir: HOME },
      ).map((d) => d.key),
    ).toEqual([CATALOG_PORTAL.key]);
  });

  it.each([
    ["a sibling whose name extends the path", "[@backup](~/Projects/catalog-portal.bak)"],
    ["the same path under another root", `[@x](/Volumes/backup${HOME}/Projects/catalog-portal/x)`],
  ])("does not attach a chip for %s", (_label, draft) => {
    expect(listReferencedDirectories(draft, directories, { homeDir: HOME })).toEqual([]);
  });

  it("resolves chip targets the draft text cannot carry", () => {
    // A file named `[id].tsx` breaks the link syntax, so its chip serializes
    // as a bare path; the composer passes the target from its token state.
    const bareChip = buildDirectoryReferenceMarkdown(
      { label: "[id].tsx", path: `${HOME}/Projects/catalog-service/app/[id].tsx` },
      HOME,
    );
    expect(listReferencedDirectories(`Read ${bareChip}`, directories, { homeDir: HOME })).toEqual([]);
    expect(listReferencedDirectories(`Read ${bareChip}`, directories, {
      homeDir: HOME,
      referencePaths: [`${HOME}/Projects/catalog-service/app/[id].tsx`],
    }).map((d) => d.key)).toEqual([CATALOG_SERVICE.key]);
  });

  it("does not match a sibling directory whose name extends the path", () => {
    expect(
      listReferencedDirectories(
        "see [@catalog-portal-v2](~/Projects/catalog-portal-v2) for details",
        directories,
        { homeDir: HOME },
      ),
    ).toEqual([]);
  });

  it("returns each directory once for repeated mentions", () => {
    expect(
      listReferencedDirectories(
        "[@catalog-portal](~/Projects/catalog-portal) and again [@catalog-portal](~/Projects/catalog-portal)",
        directories,
        { homeDir: HOME },
      ),
    ).toHaveLength(1);
  });

  it("honors excludePaths for already-linked directories", () => {
    expect(
      listReferencedDirectories(
        "work in [@catalog-service](~/Projects/catalog-service) and read [@catalog-portal](~/Projects/catalog-portal)",
        directories,
        { homeDir: HOME, excludePaths: [`${HOME}/Projects/catalog-service`] },
      ).map((d) => d.key),
    ).toEqual([CATALOG_PORTAL.key]);
  });

  it("keeps only the deepest match for nested tracked repos", () => {
    const parent = makeDirectory({
      key: "dir:projects-root",
      label: "Projects",
      path: `${HOME}/Projects`,
    });
    expect(
      listReferencedDirectories(
        "fetch [@catalog-portal](~/Projects/catalog-portal)",
        [...directories, parent],
        { homeDir: HOME },
      ).map((d) => d.key),
    ).toEqual([CATALOG_PORTAL.key]);
  });

  it.each([
    "Read [@catalog-portal](~/Projects/catalog-portal)",
    `Read [@index.ts](${HOME}/Projects/catalog-portal/src/index.ts)`,
  ])("does not attach ancestors of an already-linked reference: %s", (draft) => {
    const home = makeDirectory({ key: "home", label: "example", path: HOME });
    const parent = makeDirectory({ key: "projects", path: `${HOME}/Projects` });
    expect(listReferencedDirectories(draft, [home, parent, CATALOG_PORTAL], {
      homeDir: HOME,
      excludePaths: [CATALOG_PORTAL.path!],
    })).toEqual([]);
  });

  it("recognizes already-linked paths outside the loaded directory page", () => {
    const home = makeDirectory({ key: "home", path: HOME });
    expect(listReferencedDirectories("Read [@catalog-portal](~/Projects/catalog-portal)", [home], {
      homeDir: HOME,
      excludePaths: [CATALOG_PORTAL.path!],
    })).toEqual([]);
  });

  it("still attaches an ancestor when the draft references that ancestor alone", () => {
    const home = makeDirectory({ key: "home", path: HOME });
    expect(listReferencedDirectories("Read [@example](~)", [home], {
      homeDir: HOME,
      excludePaths: [CATALOG_PORTAL.path!],
    })).toEqual([home]);
  });

  it("accepts punctuation after the chip", () => {
    for (const draft of [
      "([@catalog-portal](~/Projects/catalog-portal))",
      "[@catalog-portal](~/Projects/catalog-portal), then more",
      "[@catalog-portal](~/Projects/catalog-portal)? yes",
    ]) {
      expect(
        listReferencedDirectories(draft, directories, { homeDir: HOME }),
      ).toHaveLength(1);
    }
  });
});
