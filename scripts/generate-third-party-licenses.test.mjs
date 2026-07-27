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
});
