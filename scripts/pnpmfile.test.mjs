// Covers the root `.pnpmfile.cjs` git-dependency policy. It lives under
// `scripts/` because that is the directory the root Vitest project already
// globs for repository-tooling tests (`scripts/**/*.test.mjs`); the subject is
// the repository root file one level up.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
  function workspaceGlobs() {
    const text = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
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

  function subdirectories(dir, { recursive }) {
    const absolute = join(repoRoot, dir);
    if (!existsSync(absolute)) return [];
    const found = [];
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Without this a `dir/**` walk descends into every installed package.
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = `${dir}/${entry.name}`;
      found.push(child);
      if (recursive) found.push(...subdirectories(child, { recursive }));
    }
    return found;
  }

  function expandGlob(glob) {
    if (!glob.includes("*") && !glob.startsWith("!")) return [glob];
    if (glob.endsWith("/**")) {
      return subdirectories(glob.slice(0, -3), { recursive: true });
    }
    if (glob.endsWith("/*")) {
      return subdirectories(glob.slice(0, -2), { recursive: false });
    }
    // Refuse rather than match nothing: a pattern that quietly expands to []
    // turns this whole test into a no-op that still reports success.
    throw new Error(
      `pnpm-workspace.yaml uses a glob this test cannot expand: ${glob}. `
        + "Teach expandGlob about it rather than letting it match nothing.",
    );
  }

  function workspacePackageNames() {
    const names = [JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).name];
    for (const glob of workspaceGlobs()) {
      for (const dir of expandGlob(glob)) {
        // Intermediate directories of a nested glob legitimately have no
        // manifest — `packages/messaging` is exactly that case here.
        const manifest = join(repoRoot, dir, "package.json");
        if (!existsSync(manifest)) continue;
        names.push(JSON.parse(readFileSync(manifest, "utf8")).name);
      }
    }
    return [...new Set(names)];
  }

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
