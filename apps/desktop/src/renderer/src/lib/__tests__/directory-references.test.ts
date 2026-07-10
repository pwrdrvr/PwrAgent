import { describe, expect, it } from "vitest";
import type { NavigationDirectorySummary } from "@pwragent/shared";
import {
  buildDirectoryReferenceInsertText,
  filterDirectoryReferenceCandidates,
  findDirectoryReferenceTrigger,
  listReferencedDirectories,
} from "../directory-references";

const HOME = "/Users/huntharo";

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

const GIPHY = makeDirectory({
  key: "dir:giphy-services",
  label: "giphy-services",
  path: `${HOME}/GIPHY/giphy-services`,
  latestUpdatedAt: 300,
});
const SEARCH = makeDirectory({
  key: "dir:search-product",
  label: "search-product",
  path: `${HOME}/GIPHY/search-product`,
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
    const text = "check out @gip";
    expect(findDirectoryReferenceTrigger(text, text.length)).toEqual({
      start: 10,
      end: text.length,
      query: "gip",
    });
  });

  it("allows path-ish query characters", () => {
    const text = "see @~/GIPHY/search";
    expect(findDirectoryReferenceTrigger(text, text.length)?.query).toBe(
      "~/GIPHY/search",
    );
  });

  it("does not trigger inside an email address", () => {
    const text = "mail huntharo@gmail.com";
    expect(findDirectoryReferenceTrigger(text, text.length)).toBeUndefined();
  });

  it("does not trigger when the caret is before the @", () => {
    expect(findDirectoryReferenceTrigger("@gip", 0)).toBeUndefined();
  });
});

describe("filterDirectoryReferenceCandidates", () => {
  const directories = [PWRAGNT, SEARCH, GIPHY, UNLINKED];

  it("returns referenceable directories most recently updated first", () => {
    expect(
      filterDirectoryReferenceCandidates(directories, "").map((d) => d.key),
    ).toEqual([GIPHY.key, SEARCH.key, PWRAGNT.key]);
  });

  it("filters by label", () => {
    expect(
      filterDirectoryReferenceCandidates(directories, "search").map((d) => d.key),
    ).toEqual([SEARCH.key]);
  });

  it("filters by path substring", () => {
    expect(
      filterDirectoryReferenceCandidates(directories, "GIPHY/").map((d) => d.key),
    ).toEqual([GIPHY.key, SEARCH.key]);
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

describe("buildDirectoryReferenceInsertText", () => {
  it("tildifies the directory path", () => {
    expect(buildDirectoryReferenceInsertText(SEARCH, HOME)).toBe(
      "~/GIPHY/search-product",
    );
  });

  it("leaves paths outside home unchanged", () => {
    expect(
      buildDirectoryReferenceInsertText({ path: "/opt/work/app" }, HOME),
    ).toBe("/opt/work/app");
  });
});

describe("listReferencedDirectories", () => {
  const directories = [GIPHY, SEARCH, PWRAGNT, UNLINKED];

  it("finds a tilde-path reference", () => {
    expect(
      listReferencedDirectories(
        "You might be able to see it in ~/GIPHY/search-product.",
        directories,
        { homeDir: HOME },
      ).map((d) => d.key),
    ).toEqual([SEARCH.key]);
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
        "look at ~/GIPHY/giphy-services/build.sbt",
        directories,
        { homeDir: HOME },
      ).map((d) => d.key),
    ).toEqual([GIPHY.key]);
  });

  it("does not match a sibling directory whose name extends the path", () => {
    expect(
      listReferencedDirectories(
        "see ~/GIPHY/search-product-v2 for details",
        directories,
        { homeDir: HOME },
      ),
    ).toEqual([]);
  });

  it("returns each directory once for repeated mentions", () => {
    expect(
      listReferencedDirectories(
        "~/GIPHY/search-product and again ~/GIPHY/search-product",
        directories,
        { homeDir: HOME },
      ),
    ).toHaveLength(1);
  });

  it("honors excludePaths for already-linked directories", () => {
    expect(
      listReferencedDirectories(
        "work in ~/GIPHY/giphy-services and read ~/GIPHY/search-product",
        directories,
        { homeDir: HOME, excludePaths: [`${HOME}/GIPHY/giphy-services`] },
      ).map((d) => d.key),
    ).toEqual([SEARCH.key]);
  });

  it("keeps only the deepest match for nested tracked repos", () => {
    const parent = makeDirectory({
      key: "dir:giphy-root",
      label: "GIPHY",
      path: `${HOME}/GIPHY`,
    });
    expect(
      listReferencedDirectories(
        "fetch ~/GIPHY/search-product",
        [...directories, parent],
        { homeDir: HOME },
      ).map((d) => d.key),
    ).toEqual([SEARCH.key]);
  });

  it("accepts punctuation boundaries after the path", () => {
    for (const draft of [
      "(~/GIPHY/search-product)",
      "~/GIPHY/search-product, then more",
      "~/GIPHY/search-product? yes",
    ]) {
      expect(
        listReferencedDirectories(draft, directories, { homeDir: HOME }),
      ).toHaveLength(1);
    }
  });
});
