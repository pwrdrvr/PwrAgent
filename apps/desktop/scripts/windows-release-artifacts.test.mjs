import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  WINDOWS_ALIAS_NAMES,
  installerName,
  writeWindowsReleaseAliases,
} from "./windows-release-artifacts.mjs";

const require = createRequire(import.meta.url);
const { findFile, parseUpdateInfo } = require("electron-updater/out/providers/Provider");
const { GenericProvider } = require("electron-updater/out/providers/GenericProvider");

const directories = [];
const version = "1.2.3-beta.4";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// release.mjs writes SHA256SUMS over every installer it packaged, before any
// alias exists. Spell that here rather than importing it: the production writer
// scans for `.exe` and would happily record an alias as an installer, which is
// exactly the input this module must not be tested against.
function writeChecksums(dist, installers) {
  const lines = installers.map((name) => `${sha256(readFileSync(join(dist, name)))}  ${name}`);
  writeFileSync(join(dist, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

// electron-builder's own Windows output: the installer, its blockmap, and a
// latest.yml naming that installer, in the shape a published release carries.
function fixture(architectures = ["x64"]) {
  const dist = mkdtempSync(join(tmpdir(), "pwragent-windows-artifacts-"));
  directories.push(dist);
  const files = architectures.map((arch) => {
    const url = installerName(version, arch);
    const bytes = Buffer.from(`installer bytes for ${arch}`);
    writeFileSync(join(dist, url), bytes);
    writeFileSync(join(dist, `${url}.blockmap`), `blockmap ${arch}`);
    return { url, sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length };
  });
  writeFileSync(
    join(dist, "latest.yml"),
    [
      `version: ${version}`,
      "files:",
      ...files.flatMap((file) => [
        `  - url: ${file.url}`,
        `    sha512: ${file.sha512}`,
        `    size: ${file.size}`,
      ]),
      `path: ${files[0].url}`,
      `sha512: ${files[0].sha512}`,
      `releaseDate: '${new Date().toISOString()}'`,
      "",
    ].join("\n"),
  );
  writeChecksums(dist, files.map((file) => file.url));
  return dist;
}

afterEach(() => {
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe("Windows release aliases", () => {
  test("copies the installer to a stable, version-free name", () => {
    const dist = fixture();
    const [alias] = writeWindowsReleaseAliases(dist, version);

    expect(alias).toMatchObject({
      installer: installerName(version, "x64"),
      alias: "PwrAgent.Setup.exe",
      arch: "x64",
    });
    const installer = readFileSync(join(dist, installerName(version, "x64")));
    expect(readFileSync(join(dist, "PwrAgent.Setup.exe"))).toEqual(installer);
    expect(alias.sha256).toBe(sha256(installer));
    expect(alias.size).toBe(installer.length);
  });

  // Named so it cannot be "simplified" back to a space: GitHub Releases rewrites
  // a space in an uploaded asset filename to a period and a later rename cannot
  // undo it, so the local artifact must already carry the published spelling.
  test("uses the spelling GitHub Releases stores, with no space and no version", () => {
    for (const name of Object.values(WINDOWS_ALIAS_NAMES)) {
      expect(name).not.toMatch(/\s/);
      // No version, but an architecture may carry digits (Arm64 stays open).
      expect(name).not.toMatch(/\d+\.\d+\.\d+/);
      expect(name).toBe(name.replace(/ /g, "."));
    }
    expect(WINDOWS_ALIAS_NAMES).toEqual({
      x64: "PwrAgent.Setup.exe",
      arm64: "PwrAgent.Setup.Arm.exe",
    });
  });

  test("keeps the versioned installer and lists the alias in SHA256SUMS", () => {
    const dist = fixture();
    const installer = installerName(version, "x64");
    writeWindowsReleaseAliases(dist, version);

    expect(existsSync(join(dist, installer))).toBe(true);
    expect(existsSync(join(dist, `${installer}.blockmap`))).toBe(true);
    // The advertised download has to appear under the name it is advertised by,
    // the way PwrAgent-linux-x64.deb already does. Same bytes, same digest.
    const digest = sha256(readFileSync(join(dist, installer)));
    expect(readFileSync(join(dist, "SHA256SUMS"), "utf8")).toBe(
      `${digest}  ${installer}\n${digest}  PwrAgent.Setup.exe\n`,
    );
  });

  test("records the alias once when the step runs twice", () => {
    const dist = fixture();
    writeWindowsReleaseAliases(dist, version);
    const once = readFileSync(join(dist, "SHA256SUMS"), "utf8");
    writeWindowsReleaseAliases(dist, version);

    expect(readFileSync(join(dist, "SHA256SUMS"), "utf8")).toBe(once);
  });

  test("leaves latest.yml alone, so the updater still fetches the versioned installer", () => {
    const dist = fixture();
    const before = readFileSync(join(dist, "latest.yml"), "utf8");
    writeWindowsReleaseAliases(dist, version);
    expect(readFileSync(join(dist, "latest.yml"), "utf8")).toBe(before);

    // auto-updater.ts pins a generic feed to one tag's download directory.
    // NsisUpdater then picks its .exe out of latest.yml, never out of the
    // release's asset list, so a second asset beside the installer cannot
    // redirect an update to the unversioned alias.
    const url = `https://github.com/pwrdrvr/PwrAgent/releases/download/v${version}/`;
    const provider = new GenericProvider({ provider: "generic", url }, { channel: null }, {
      isUseMultipleRangeRequest: false,
      platform: "win32",
      executor: null,
    });
    const info = parseUpdateInfo(before, "latest.yml", new URL(`${url}latest.yml`));
    expect(findFile(provider.resolveFiles(info), "exe").url.href).toBe(
      `${url}${installerName(version, "x64")}`,
    );
  });

  test("names a future Windows ARM installer without disturbing x64", () => {
    const dist = fixture(["x64", "arm64"]);
    const aliases = writeWindowsReleaseAliases(dist, version);

    expect(aliases.map((entry) => entry.alias)).toEqual([
      "PwrAgent.Setup.Arm.exe",
      "PwrAgent.Setup.exe",
    ]);
    expect(readFileSync(join(dist, "PwrAgent.Setup.Arm.exe"), "utf8")).toBe("installer bytes for arm64");
    expect(readFileSync(join(dist, "PwrAgent.Setup.exe"), "utf8")).toBe("installer bytes for x64");
  });

  test("refuses an installer whose bytes disagree with the checksum manifest", () => {
    const dist = fixture();
    writeFileSync(join(dist, installerName(version, "x64")), "tampered after packaging");
    expect(() => writeWindowsReleaseAliases(dist, version)).toThrow("does not match SHA256SUMS");
    expect(existsSync(join(dist, "PwrAgent.Setup.exe"))).toBe(false);
  });

  test("refuses an installer the checksum manifest does not cover", () => {
    const dist = fixture();
    writeFileSync(join(dist, "SHA256SUMS"), `${"0".repeat(64)}  PwrAgent-other-setup.exe\n`);
    expect(() => writeWindowsReleaseAliases(dist, version)).toThrow("no entry for");
    expect(existsSync(join(dist, "PwrAgent.Setup.exe"))).toBe(false);
  });

  test("refuses an architecture with no agreed alias rather than guessing one", () => {
    const dist = fixture(["x64"]);
    const surprise = `PwrAgent-${version}-windows-ia32-setup.exe`;
    writeFileSync(join(dist, surprise), "surprise");
    writeChecksums(dist, [installerName(version, "x64"), surprise]);

    expect(() => writeWindowsReleaseAliases(dist, version)).toThrow("no stable alias is defined");
    // Validation runs to completion before any copy, so x64 gets no stale alias.
    expect(existsSync(join(dist, "PwrAgent.Setup.exe"))).toBe(false);
  });

  // release.mjs clears dist for macOS but not for Windows, so a repeated local
  // build leaves earlier versions lying around. They are not ours to alias.
  test("ignores an installer left behind by an earlier version", () => {
    const dist = fixture();
    const stale = "PwrAgent-0.0.1-windows-x64-setup.exe";
    writeFileSync(join(dist, stale), "an older build");
    writeChecksums(dist, [stale, installerName(version, "x64")]);

    const [alias] = writeWindowsReleaseAliases(dist, version);
    expect(alias.installer).toBe(installerName(version, "x64"));
    expect(readFileSync(join(dist, "PwrAgent.Setup.exe"), "utf8")).toBe("installer bytes for x64");
  });

  test("says so when only another version's installer is present", () => {
    const dist = fixture();
    const stale = "PwrAgent-0.0.1-windows-x64-setup.exe";
    rmSync(join(dist, installerName(version, "x64")));
    writeFileSync(join(dist, stale), "an older build");
    writeChecksums(dist, [stale]);

    expect(() => writeWindowsReleaseAliases(dist, version)).toThrow(`No Windows installer for ${version}`);
    expect(existsSync(join(dist, "PwrAgent.Setup.exe"))).toBe(false);
  });

  test("refuses an empty dist and a version that would confuse the architecture parse", () => {
    const dist = fixture();
    for (const name of readdirSync(dist).filter((entry) => entry.endsWith("-setup.exe"))) {
      rmSync(join(dist, name));
    }
    expect(() => writeWindowsReleaseAliases(dist, version)).toThrow("No *-setup.exe found under");
    expect(() => writeWindowsReleaseAliases(fixture(), "1.2.3-windows-x64")).toThrow("Invalid");
    expect(() => writeWindowsReleaseAliases(fixture(), "v1.2.3")).toThrow("Invalid");
  });
});
