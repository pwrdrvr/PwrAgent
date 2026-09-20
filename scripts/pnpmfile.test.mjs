// Covers the root `.pnpmfile.cjs` git-dependency policy. It lives under
// `scripts/` because that is the directory the root Vitest project already
// globs for repository-tooling tests (`scripts/**/*.test.mjs`); the subject is
// the repository root file one level up.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pnpmfile = require("../.pnpmfile.cjs");
const { isGitSpec, isFirstParty, readPackage } = pnpmfile.__testing;

// Every shape pnpm resolves as a git fetch. `github:`, the bare `user/repo`
// form, and `git+https://` / `git+ssh://` to a known host all route through the
// `gitHostedTarball` fetcher; a non-hosted remote routes through `git`. Both
// fetchers are blocked below, but the spec scan has to catch all of them before
// a fetcher is ever reached.
const GIT_SPECS = [
  "github:user/repo",
  "user/repo",
  "user/repo#v1.0.0",
  "git+https://github.com/user/repo.git",
  "git+ssh://git@github.com/user/repo.git",
  "git://github.com/user/repo.git",
  "git@github.com:user/repo.git",
  "gitlab:x/y",
  "bitbucket:x/y",
  "https://github.com/user/repo",
  "git+file:///srv/repo.git",
];

// The allow side. `file:`, `link:` and `workspace:` with a single-segment path
// are the regression: before the `:` exclusion in the final alternation of
// `gitSpecPattern`, each parsed as a `user/repo` GitHub shortcut and threw
// `Blocked git dependency`. The two-segment forms escaped by accident, because
// the trailing character class cannot match a second `/`.
const REGISTRY_SPECS = [
  "4.9.5",
  "^2.2.1",
  "~1.0.0",
  "0.4.0-alpha.5",
  "*",
  "latest",
  "npm:other-package@1.0.0",
  "workspace:*",
  "workspace:^",
  "workspace:../pkg",
  "file:../local",
  "file:./packages/x",
  "link:../local",
  "link:./packages/x",
];

const RESOLVED_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

describe("gitSpecPattern", () => {
  it.each(GIT_SPECS)("treats %s as a git spec", (spec) => {
    expect(isGitSpec(spec)).toBe(true);
  });

  it.each(REGISTRY_SPECS)("allows %s", (spec) => {
    expect(isGitSpec(spec)).toBe(false);
  });

  it("ignores a non-string spec", () => {
    expect(isGitSpec(undefined)).toBe(false);
    expect(isGitSpec(null)).toBe(false);
    expect(isGitSpec(42)).toBe(false);
  });
});

describe("readPackage", () => {
  it.each(RESOLVED_FIELDS)(
    "blocks a git spec in %s on any package",
    (field) => {
      for (const spec of GIT_SPECS) {
        expect(() =>
          readPackage({ name: "some-transitive-package", [field]: { evil: spec } }),
        ).toThrow(/Blocked git dependency/);
      }
    },
  );

  it.each(RESOLVED_FIELDS)("allows a non-git spec in %s", (field) => {
    for (const spec of REGISTRY_SPECS) {
      expect(() =>
        readPackage({ name: "some-transitive-package", [field]: { ok: spec } }),
      ).not.toThrow();
    }
  });

  it("allows a first-party package to declare a local file/link dependency", () => {
    // The failure the `:` exclusion fixes, reached the way pnpm reaches it.
    for (const spec of ["file:../local", "link:../local", "workspace:../pkg"]) {
      expect(() =>
        readPackage({
          name: "@pwragent/desktop",
          dependencies: { local: spec },
          devDependencies: { alsoLocal: spec },
        }),
      ).not.toThrow();
    }
  });

  it.each(["pwragent-workspace", "@pwragent/desktop", "@pwragent/shared"])(
    "blocks a git devDependency in the first-party package %s",
    (name) => {
      for (const spec of GIT_SPECS) {
        expect(() => readPackage({ name, devDependencies: { evil: spec } })).toThrow(
          /Blocked git dependency/,
        );
      }
    },
  );

  it("leaves a transitive package's git devDependency alone", () => {
    // pnpm never installs a transitive devDependency, and the fetcher block
    // below is the backstop. Scanning them here fails the install over another
    // maintainer's tooling (axe-core's axe-test-fixtures is the live case).
    const manifest = {
      name: "axe-core",
      devDependencies: { "axe-test-fixtures": "github:dequelabs/axe-test-fixtures" },
    };
    expect(() => readPackage(manifest)).not.toThrow();
    expect(manifest.devDependencies["axe-test-fixtures"]).toBe(
      "github:dequelabs/axe-test-fixtures",
    );
  });

  it("strips protobufjs's unused jaguarjs-jsdoc GitHub devDependency", () => {
    const manifest = {
      name: "protobufjs",
      devDependencies: { "jaguarjs-jsdoc": "github:dcodeIO/jaguarjs-jsdoc" },
    };
    expect(() => readPackage(manifest)).not.toThrow();
    expect(manifest.devDependencies["jaguarjs-jsdoc"]).toBeUndefined();
  });

  it("treats a package with no name as not first party", () => {
    expect(isFirstParty({})).toBe(false);
    expect(isFirstParty(undefined)).toBe(false);
    expect(() => readPackage({ devDependencies: { evil: "github:a/b" } })).not.toThrow();
  });
});

describe("first-party coverage", () => {
  // `isFirstParty` gates devDependency scanning and the `pnpm.overrides` /
  // `resolutions` scan, so a workspace package the check misses silently loses
  // both. The name set is hand-maintained, which is exactly the kind of thing
  // that drifts, so this derives the expected list from the workspace globs in
  // `pnpm-workspace.yaml` instead of hardcoding paths — a hardcoded
  // `packages/` walk reports full coverage while an `apps/*` package sits
  // unscanned.
  function workspaceGlobs(root = repoRoot) {
    const text = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
    if (start === -1) {
      throw new Error("pnpm-workspace.yaml has no `packages:` block");
    }
    const globs = [];
    for (const line of lines.slice(start + 1)) {
      if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
      // A non-indented line is the next top-level key, so the block is done.
      if (!/^\s/.test(line)) break;
      const entry = /^\s+-\s+(.*?)\s*$/.exec(line);
      if (!entry) throw new Error(`unparsed line in packages block: ${line}`);
      globs.push(entry[1].replace(/^["']|["']$/g, ""));
    }
    return globs;
  }

  function subdirectories(root, dir, { recursive }) {
    const absolute = join(root, dir);
    if (!existsSync(absolute)) return [];
    const found = [];
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Without this a `dir/**` walk descends into every installed package and
      // reports their names as workspace packages. Exercised by the fixture
      // below, which puts a `node_modules` *inside* the recursively walked
      // path — beside it, the walk never reaches it and the assertion passes
      // whether or not this line exists.
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = `${dir}/${entry.name}`;
      found.push(child);
      if (recursive) found.push(...subdirectories(root, child, { recursive }));
    }
    return found;
  }

  function expandGlob(root, glob) {
    // Checked before anything else, and deliberately a refusal rather than a
    // silent skip. Routing `!x` through the branches below would let
    // `!packages/legacy/*` match the `/*` branch, find no directory named
    // `!packages/legacy`, and return [] — which does not exclude anything, so
    // the excluded packages stay in the set and this test over-reports what it
    // has checked. Nothing here declares an exclusion today; teach this
    // function real exclusion semantics rather than letting one through.
    if (glob.startsWith("!")) {
      throw new Error(
        `pnpm-workspace.yaml declares the exclusion ${glob}, which this test `
          + "does not implement. Teach expandGlob to subtract it.",
      );
    }
    if (!glob.includes("*")) return [glob];
    const recursive = glob.endsWith("/**");
    if (recursive || glob.endsWith("/*")) {
      const prefix = glob.slice(0, recursive ? -3 : -2);
      // The suffix test alone is not enough. An interior wildcard such as
      // `pack*ges/*` ends in `/*` but names no real directory, so the walk
      // would find nothing and return [] — the silent no-op this function
      // exists to refuse. Only expand when the prefix is a literal path.
      if (!prefix.includes("*")) return subdirectories(root, prefix, { recursive });
    }
    // Refuse rather than match nothing: a pattern that quietly expands to []
    // turns this whole test into a no-op that still reports success.
    throw new Error(
      `pnpm-workspace.yaml uses a glob this test cannot expand: ${glob}. `
        + "Teach expandGlob about it rather than letting it match nothing.",
    );
  }

  function workspacePackageNames(root = repoRoot) {
    const names = [JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name];
    for (const glob of workspaceGlobs(root)) {
      for (const dir of expandGlob(root, glob)) {
        // Intermediate directories of a nested glob legitimately have no
        // manifest — `packages/messaging` is exactly that case here.
        const manifest = join(root, dir, "package.json");
        if (!existsSync(manifest)) continue;
        names.push(JSON.parse(readFileSync(manifest, "utf8")).name);
      }
    }
    return [...new Set(names)];
  }

  // The helpers above are exercised against a throwaway workspace as well as
  // the real one. Asserting only against this repository would leave every
  // guard in them unexercised until the day someone adds the glob it guards.
  describe("against a synthetic workspace", () => {
    let fixtureRoot;

    function write(relative, contents) {
      const absolute = join(fixtureRoot, relative);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents);
    }

    function seed(globs) {
      fixtureRoot = mkdtempSync(join(tmpdir(), "pwragent-pnpmfile-"));
      write("package.json", JSON.stringify({ name: "fixture-root" }));
      write(
        "pnpm-workspace.yaml",
        `packages:\n${globs.map((g) => `  - ${g}`).join("\n")}\n`,
      );
      return fixtureRoot;
    }

    afterEach(() => {
      if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    });

    it("never walks into node_modules under a recursive glob", () => {
      // The node_modules goes INSIDE the walked path. Beside it — at the
      // fixture root, next to `nested/` — the walk never reaches it and this
      // assertion passes identically with the skip present or removed, which
      // makes it decorative.
      const root = seed(["nested/**"]);
      write("nested/one/package.json", JSON.stringify({ name: "real-package" }));
      write(
        "nested/one/node_modules/evil/package.json",
        JSON.stringify({ name: "installed-dependency" }),
      );

      const names = workspacePackageNames(root);
      expect(names).toContain("real-package");
      expect(names).not.toContain("installed-dependency");
    });

    it("sees a package outside the packages/ directory", () => {
      // The blindness a hardcoded `packages/` walk has: it reports full
      // coverage while an apps/* package sits unscanned.
      const root = seed(["apps/*", "packages/*"]);
      write("apps/tool/package.json", JSON.stringify({ name: "unscoped-tool" }));
      write("packages/lib/package.json", JSON.stringify({ name: "@scope/lib" }));

      expect(workspacePackageNames(root)).toEqual(
        expect.arrayContaining(["unscoped-tool", "@scope/lib"]),
      );
    });

    it("tolerates an intermediate directory with no manifest", () => {
      // `packages/messaging` in the real workspace.
      const root = seed(["packages/*", "packages/group/*"]);
      write("packages/group/member/package.json", JSON.stringify({ name: "member" }));

      expect(workspacePackageNames(root)).toContain("member");
    });

    it.each([
      ["!packages/legacy", "exclusion without a wildcard"],
      ["!packages/legacy/*", "exclusion that would otherwise match the /* branch"],
      ["!packages/legacy/**", "exclusion that would otherwise match the /** branch"],
    ])("refuses the exclusion %s (%s)", (glob) => {
      // Every one of these silently returned [] before the `!` check moved to
      // the top of expandGlob: an ignored exclusion leaves the excluded
      // packages in the set, so the test claims to have checked more than it
      // did.
      const root = seed(["packages/*", glob]);
      expect(() => workspacePackageNames(root)).toThrow(/does not implement/);
    });

    it("refuses a glob shape it cannot expand rather than matching nothing", () => {
      const root = seed(["pack*ges/*"]);
      expect(() => workspacePackageNames(root)).toThrow(/cannot expand/);
    });

    it("refuses a workspace file with no packages block", () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), "pwragent-pnpmfile-"));
      write("package.json", JSON.stringify({ name: "fixture-root" }));
      write("pnpm-workspace.yaml", "minimumReleaseAge: 10080\n");

      expect(() => workspacePackageNames(fixtureRoot)).toThrow(/no `packages:` block/);
    });

    it("stops the packages block at the next top-level key", () => {
      const root = seed(["packages/*"]);
      write(
        "pnpm-workspace.yaml",
        "packages:\n  # a comment\n  - packages/*\n\nminimumReleaseAge: 10080\nonlyBuiltDependencies:\n  - esbuild\n",
      );
      write("packages/lib/package.json", JSON.stringify({ name: "only-me" }));

      expect(workspaceGlobs(root)).toEqual(["packages/*"]);
      expect(workspacePackageNames(root)).toEqual(["fixture-root", "only-me"]);
    });
  });

  it("enumerates the workspace from pnpm-workspace.yaml", () => {
    // A typo in the parser would otherwise read as "nothing to check, all
    // covered", which is the failure mode this whole block exists to prevent.
    expect(workspaceGlobs().length).toBeGreaterThan(0);
    expect(workspacePackageNames().length).toBeGreaterThan(1);
  });

  it("covers every workspace package", () => {
    const uncovered = workspacePackageNames().filter(
      (name) => !isFirstParty({ name }),
    );
    expect(uncovered).toEqual([]);
  });

  it("does not treat an unrelated registry package as first party", () => {
    // The prefix is `@pwragent/`, which is exclusively ours — but a name that
    // merely starts with the letters must not slip through.
    for (const name of ["pwragent-cli", "@pwragentfoo/bar", "lodash", "@types/node"]) {
      expect(isFirstParty({ name })).toBe(false);
    }
  });
});

describe("pnpm.overrides and resolutions", () => {
  // An override is not a dependency field, so nothing above scans it — but pnpm
  // resolves its value exactly like a spec. It is also the quietest injection
  // point in the manifest: an override repoints a *transitive* package, so it
  // shows up in no dependency block at all.
  const OVERRIDE_OWNERS = ["pwragent-workspace", "@pwragent/desktop"];

  // Values pnpm legitimately accepts here, including its
  // reference-a-declared-dependency form. None may trip the git regex.
  const LEGITIMATE_OVERRIDES = [
    "0.5.1",
    "7.29.6",
    "^1.16.0",
    ">=4.0.0",
    "$some-dep",
    "npm:other@1.0.0",
    "workspace:*",
  ];

  it.each(OVERRIDE_OWNERS)("blocks a git spec in %s's pnpm.overrides", (name) => {
    for (const spec of GIT_SPECS) {
      expect(() =>
        readPackage({ name, pnpm: { overrides: { "is-number": spec } } }),
      ).toThrow(/Blocked git dependency/);
    }
  });

  it("names pnpm.overrides in the diagnostic, not the bare field", () => {
    // The whole point of scanning here rather than leaning on the fetcher: the
    // fetcher's error names neither the package nor where it was declared.
    expect(() =>
      readPackage({
        name: "pwragent-workspace",
        pnpm: { overrides: { "is-number": "github:user/repo" } },
      }),
    ).toThrow(
      "Blocked git dependency is-number@github:user/repo (in pwragent-workspace.pnpm.overrides)",
    );
  });

  it.each(OVERRIDE_OWNERS)("blocks a git spec in %s's resolutions", (name) => {
    for (const spec of GIT_SPECS) {
      expect(() => readPackage({ name, resolutions: { "is-number": spec } })).toThrow(
        /Blocked git dependency/,
      );
    }
  });

  it.each(LEGITIMATE_OVERRIDES)("allows the override value %s", (spec) => {
    expect(() =>
      readPackage({
        name: "pwragent-workspace",
        pnpm: { overrides: { "is-number": spec } },
        resolutions: { "is-number": spec },
      }),
    ).not.toThrow();
  });

  it("allows every override this repository actually declares", () => {
    // Guards the fix against the live manifest: a false positive here fails
    // \`pnpm install\` for everyone.
    const root = require("../package.json");
    expect(() => readPackage(structuredClone(root))).not.toThrow();
    expect(Object.keys(root.pnpm?.overrides ?? {}).length).toBeGreaterThan(0);
  });

  it("ignores a transitive package's own overrides", () => {
    // pnpm only honours overrides declared by the workspace root, so a registry
    // package's copy is inert; blocking on it is a false positive with nothing
    // behind it.
    expect(() =>
      readPackage({
        name: "some-registry-package",
        pnpm: { overrides: { lodash: "github:a/b" } },
        resolutions: { lodash: "github:a/b" },
      }),
    ).not.toThrow();
  });

  it("tolerates a manifest with no pnpm block", () => {
    expect(() => readPackage({ name: "pwragent-workspace" })).not.toThrow();
    expect(() => readPackage({ name: "pwragent-workspace", pnpm: null })).not.toThrow();
  });
});

describe("fetchers", () => {
  it("hands pnpm both git fetcher blocks as factories returning a thrower", async () => {
    const { fetchers } = pnpmfile.hooks;
    expect(Object.keys(fetchers).sort()).toEqual(["git", "gitHostedTarball"]);

    for (const factory of Object.values(fetchers)) {
      // pnpm calls the entry once to build its registry, then calls the result.
      // A hook that threw from the factory would break every install.
      const fetcher = factory({ defaultFetchers: {} });
      expect(typeof fetcher).toBe("function");
      await expect(fetcher()).rejects.toThrow(/Blocked pnpm git dependency fetch/);
    }
  });
});
