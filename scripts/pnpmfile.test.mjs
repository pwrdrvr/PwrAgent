// Covers the root `.pnpmfile.cjs` git-dependency policy. It lives under
// `scripts/` because that is the directory the root Vitest project already
// globs for repository-tooling tests (`scripts/**/*.test.mjs`); the subject is
// the repository root file two levels up.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

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
