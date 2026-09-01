import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  describeNoticeDrift,
  expandOptionalPlatformVariants,
  enrichRecord,
  StaleInstallError,
} from "./generate-third-party-licenses.mjs";

const temporaryDirectories = [];

function createTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "pwragent-license-generator-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createRecord(packagePath) {
  return {
    name: "example-package",
    version: "1.2.3",
    declaredLicense: "MIT",
    packagePath,
  };
}

function captureError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("expected callback to throw");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("third-party license package enrichment", () => {
  it("rejects a license report without an installed package path", () => {
    const error = captureError(() => enrichRecord(createRecord(undefined)));

    expect(error).toBeInstanceOf(StaleInstallError);
    expect(error.message).toBe(
      [
        "Cannot generate THIRD_PARTY_LICENSES for example-package@1.2.3: `pnpm licenses` did not report an installed package path.",
        "The installed dependencies are stale or incomplete. Run `pnpm install`, then rerun the license command.",
      ].join("\n"),
    );
  });

  it("rejects a reported package directory that does not exist", () => {
    const packagePath = join(createTemporaryDirectory(), "missing-package");
    const error = captureError(() => enrichRecord(createRecord(packagePath)));

    expect(error).toBeInstanceOf(StaleInstallError);
    expect(error.message).toBe(
      [
        `Cannot generate THIRD_PARTY_LICENSES for example-package@1.2.3: \`pnpm licenses\` reported package path "${packagePath}", but that directory does not exist.`,
        "The installed dependencies are stale or incomplete. Run `pnpm install`, then rerun the license command.",
      ].join("\n"),
    );
  });

  it("rejects a reported package directory without package.json", () => {
    const packagePath = join(createTemporaryDirectory(), "incomplete-package");
    mkdirSync(packagePath);
    const packageJsonPath = join(packagePath, "package.json");
    const error = captureError(() => enrichRecord(createRecord(packagePath)));

    expect(error).toBeInstanceOf(StaleInstallError);
    expect(error.message).toBe(
      [
        `Cannot generate THIRD_PARTY_LICENSES for example-package@1.2.3: \`pnpm licenses\` reported package path "${packagePath}", but "${packageJsonPath}" does not exist.`,
        "The installed dependencies are stale or incomplete. Run `pnpm install`, then rerun the license command.",
      ].join("\n"),
    );
  });

  it("keeps metadata fallback text for an installed package without a license file", () => {
    const packagePath = join(createTemporaryDirectory(), "installed-package");
    mkdirSync(packagePath);
    writeFileSync(
      join(packagePath, "package.json"),
      JSON.stringify({
        name: "example-package",
        version: "1.2.3",
        author: "Example Author",
        repository: "git+https://github.com/example/example-package.git",
        license: "MIT",
      }),
    );

    const enriched = enrichRecord(createRecord(packagePath));

    expect(enriched.source).toBe("https://github.com/example/example-package");
    expect(enriched.licenseFile).toBe("package metadata");
    expect(enriched.licenseText).toContain(
      "The installed package does not include a separate license file. Its package metadata declares MIT.",
    );
    expect(enriched.licenseText).toContain("Copyright (c) Example Author");
  });

  it("includes all platform-specific optional package variants", () => {
    const packagePath = join(createTemporaryDirectory(), "canvas");
    mkdirSync(packagePath);
    writeFileSync(
      join(packagePath, "package.json"),
      JSON.stringify({
        name: "example-canvas",
        version: "1.2.3",
        optionalDependencies: {
          "example-canvas-darwin-arm64": "1.2.3",
          "example-canvas-linux-x64": "1.2.3",
          "example-canvas-wasm": "1.2.3",
          "unrelated-optional-package": "1.2.3",
        },
      }),
    );

    const records = expandOptionalPlatformVariants([
      {
        ...createRecord(packagePath),
        name: "example-canvas",
      },
      {
        ...createRecord(packagePath),
        name: "example-canvas-darwin-arm64",
      },
    ]);

    expect(records.map((record) => `${record.name}@${record.version}`).sort()).toEqual([
      "example-canvas-darwin-arm64@1.2.3",
      "example-canvas-linux-x64@1.2.3",
      "example-canvas@1.2.3",
    ]);
  });
});


describe("describeNoticeDrift", () => {
  const summaryLine = (key) => `- ${key} | https://example.invalid/${key}`;
  const notice = (keys) => `${keys.map(summaryLine).join("\n")}\n`;

  it("names the packages each side has and the other does not", () => {
    const lines = describeNoticeDrift(
      notice(["a@1.0.0", "b@2.0.0"]),
      notice(["a@1.0.0", "c@3.0.0"]),
    );
    expect(lines).toEqual([
      "only in the freshly generated notice (1): c@3.0.0",
      "only in the committed notice (1): b@2.0.0",
    ]);
  });

  it("reads package keys only from the summary list", () => {
    // Every package appears twice in the notice: once in the summary list with
    // a source URL, and again under "Applies to:" with its declared license. A
    // pattern loose enough to match both would double every count and report a
    // package as added when only its license section moved.
    const lines = describeNoticeDrift("", `${notice(["a@1.0.0"])}\n- a@1.0.0 (MIT)\n`);
    expect(lines).toEqual(["only in the freshly generated notice (1): a@1.0.0"]);
  });

  it("caps the list so a wholesale regeneration cannot flood a CI log", () => {
    // The widened-selector change added 69 packages at once; an uncapped list
    // would bury the header it is meant to explain.
    const keys = Array.from({ length: 25 }, (_, index) => `p${String(index).padStart(2, "0")}@1.0.0`);
    const lines = describeNoticeDrift("", notice(keys));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("(25):");
    expect(lines[0]).toContain("p19@1.0.0");
    expect(lines[0]).not.toContain("p20@1.0.0");
    expect(lines[1]).toBe("  ...and 5 more");
  });

  it("falls back to the first differing line when the package set is unchanged", () => {
    // A license text or source URL that changed under an unchanged version is
    // invisible to the package-level view, and reporting nothing there would
    // leave "out of date" as unactionable as before.
    const lines = describeNoticeDrift(
      "PwrAgent Third-Party Licenses\nCopyright (c) 2025\n",
      "PwrAgent Third-Party Licenses\nCopyright (c) 2026\n",
    );
    expect(lines).toEqual([
      'the package set is identical; the text differs from line 2: committed "Copyright (c) 2025"'
        + ', generated "Copyright (c) 2026"',
    ]);
  });

  it("reports a length-only difference when one notice is a prefix of the other", () => {
    const lines = describeNoticeDrift("same\n", "same\n\n\n");
    expect(lines).toEqual(["the package set is identical; the text differs only in length"]);
  });
});
