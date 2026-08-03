import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkElectronVersionPolicy } from "./check-electron-version-policy.mjs";

const temporaryDirectories = [];

function writeReleaseInputs({ resolved, packaged }) {
  const root = mkdtempSync(join(tmpdir(), "pwragent-electron-policy-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "apps", "desktop"), { recursive: true });
  writeFileSync(
    join(root, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'

importers:

  apps/desktop:
    devDependencies:
      electron:
        specifier: ^${resolved}
        version: ${resolved}
`,
  );
  writeFileSync(
    join(root, "apps", "desktop", "electron-builder.yml"),
    `electronVersion: ${packaged}\n`,
  );
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Electron version policy", () => {
  it("allows the packaged runtime to match the resolved dependency", () => {
    const root = writeReleaseInputs({
      resolved: "41.10.3",
      packaged: "41.10.3",
    });

    expect(checkElectronVersionPolicy(root)).toEqual([]);
  });

  it("rejects a packaged runtime that differs from the resolved dependency", () => {
    const root = writeReleaseInputs({
      resolved: "41.10.3",
      packaged: "41.2.1",
    });

    expect(checkElectronVersionPolicy(root)).toEqual([
      "Electron runtime versions must match exactly; pnpm-lock.yaml resolves electron@41.10.3, apps/desktop/electron-builder.yml packages electron@41.2.1",
    ]);
  });
});
