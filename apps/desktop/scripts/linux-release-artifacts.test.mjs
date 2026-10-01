import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createLinuxStableAliases,
  LINUX_ARCHITECTURES,
  LINUX_PACKAGE_EXTENSIONS,
  linuxPackageName,
  linuxStableName,
  writeLinuxChecksums,
} from "./linux-release-artifacts.mjs";

const directories = [];
const version = "1.2.3-beta.4";
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const { Arch, getArtifactArchName } = builderRequire("builder-util");

function fixture(architectures = LINUX_ARCHITECTURES) {
  const dir = mkdtempSync(join(tmpdir(), "pwragent-linux-packages-"));
  directories.push(dir);
  for (const arch of architectures) {
    for (const extension of LINUX_PACKAGE_EXTENSIONS) {
      const name = linuxPackageName(version, arch, extension);
      writeFileSync(join(dir, name), `package bytes for ${name}`);
    }
  }
  return dir;
}

afterEach(() => {
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe("Linux release artifacts", () => {
  test("matches the pinned electron-builder's artifact names for every format and architecture", () => {
    for (const arch of LINUX_ARCHITECTURES) {
      for (const extension of LINUX_PACKAGE_EXTENSIONS) {
        const artifactArch = getArtifactArchName(Arch[arch], extension);
        expect(linuxPackageName(version, arch, extension)).toBe(`PwrAgent-${version}-linux-${artifactArch}.${extension}`);
      }
    }
  });
  test("normalizes electron-builder's format-specific architectures into stable downloads", () => {
    const dir = fixture();
    expect(linuxPackageName(version, "x64", "deb")).toBe(`PwrAgent-${version}-linux-amd64.deb`);
    expect(linuxPackageName(version, "x64", "rpm")).toBe(`PwrAgent-${version}-linux-x86_64.rpm`);
    for (const arch of LINUX_ARCHITECTURES) {
      expect(createLinuxStableAliases(dir, version, arch)).toHaveLength(4);
      for (const extension of LINUX_PACKAGE_EXTENSIONS) {
        expect(readFileSync(join(dir, linuxStableName(arch, extension)))).toEqual(
          readFileSync(join(dir, linuxPackageName(version, arch, extension))),
        );
      }
    }
  });

  test("hashes every format and alias after merging architectures", () => {
    const dir = fixture();
    for (const arch of LINUX_ARCHITECTURES) createLinuxStableAliases(dir, version, arch);
    const manifest = readFileSync(writeLinuxChecksums(dir, version, LINUX_ARCHITECTURES), "utf8");
    const lines = manifest.trim().split("\n");
    expect(lines).toHaveLength(16);
    for (const line of lines) {
      const [digest, name] = line.split("  ");
      expect(digest).toBe(createHash("sha256").update(readFileSync(join(dir, name))).digest("hex"));
    }
    expect(writeLinuxChecksums(dir, version, LINUX_ARCHITECTURES)).toBe(join(dir, "SHA256SUMS"));
    expect(readFileSync(join(dir, "SHA256SUMS"), "utf8")).toBe(manifest);
  });

  test("fails before writing aliases if one format is absent", () => {
    const dir = fixture(["x64"]);
    rmSync(join(dir, linuxPackageName(version, "x64", "rpm")));
    expect(() => createLinuxStableAliases(dir, version, "x64")).toThrow("linux-x86_64.rpm");
    expect(() => statSync(join(dir, linuxStableName("x64", "deb")))).toThrow();
  });

  test("publication rejects a missing architecture, alias, or stale version", () => {
    const dir = fixture(["x64"]);
    createLinuxStableAliases(dir, version, "x64");
    expect(() => writeLinuxChecksums(dir, version, LINUX_ARCHITECTURES)).toThrow("linux-aarch64.rpm");
    rmSync(join(dir, linuxStableName("x64", "pacman")));
    expect(() => writeLinuxChecksums(dir, version, ["x64"])).toThrow("PwrAgent-linux-x64.pacman");
    expect(() => writeLinuxChecksums(dir, "9.9.9", ["x64"])).toThrow("PwrAgent-9.9.9");
  });
});
