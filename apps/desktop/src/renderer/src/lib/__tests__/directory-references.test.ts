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

describe("findDirectoryReferenceTrigger", () => {
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

  it("finds a tilde-path reference", () => {
    expect(
      listReferencedDirectories(
        "You might be able to see it in ~/Projects/catalog-portal.",
        directories,
        { homeDir: HOME },
      ).map((d) => d.key),
    ).toEqual([CATALOG_PORTAL.key]);
  });

  it("finds an absolute-path reference", () => {
    expect(
      listReferencedDirectories(
        `compare against ${HOME}/pwrdrvr/PwrAgnt please`,
        directories,
        { homeDir: HOME },
      ).map((d) => d.key),
    ).toEqual([PWRAGNT.key]);
  });

  it("resolves a deeper file path to its tracked repo", () => {
    expect(
      listReferencedDirectories(
        "look at ~/Projects/catalog-service/build.sbt",
        directories,
        { homeDir: HOME },
      ).map((d) => d.key),
    ).toEqual([CATALOG_SERVICE.key]);
  });

  it("does not match a sibling directory whose name extends the path", () => {
    expect(
      listReferencedDirectories(
        "see ~/Projects/catalog-portal-v2 for details",
        directories,
        { homeDir: HOME },
      ),
    ).toEqual([]);
  });

  it("returns each directory once for repeated mentions", () => {
    expect(
      listReferencedDirectories(
        "~/Projects/catalog-portal and again ~/Projects/catalog-portal",
        directories,
        { homeDir: HOME },
      ),
    ).toHaveLength(1);
  });

  it("honors excludePaths for already-linked directories", () => {
    expect(
      listReferencedDirectories(
        "work in ~/Projects/catalog-service and read ~/Projects/catalog-portal",
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
        "fetch ~/Projects/catalog-portal",
        [...directories, parent],
        { homeDir: HOME },
      ).map((d) => d.key),
    ).toEqual([CATALOG_PORTAL.key]);
  });

  it("accepts punctuation boundaries after the path", () => {
    for (const draft of [
      "(~/Projects/catalog-portal)",
      "~/Projects/catalog-portal, then more",
      "~/Projects/catalog-portal? yes",
    ]) {
      expect(
        listReferencedDirectories(draft, directories, { homeDir: HOME }),
      ).toHaveLength(1);
    }
  });
});
