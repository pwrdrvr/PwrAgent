import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  WINDOWS_ALIAS_NAMES,
  installerName,
  writeWindowsChecksums,
  writeWindowsReleaseAliases,
} from "./windows-release-artifacts.mjs";

const MODULE_PATH = fileURLToPath(new URL("./windows-release-artifacts.mjs", import.meta.url));

const require = createRequire(import.meta.url);
const { findFile, parseUpdateInfo } = require("electron-updater/out/providers/Provider");
const { GenericProvider } = require("electron-updater/out/providers/GenericProvider");

const directories = [];
const version = "1.2.3-beta.4";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// The real writer, not a re-spelling of its format: readChecksums parses what
// this produces, and the two drifting apart would only ever fail on the release
// runner. release.mjs calls exactly this function at the end of Windows
// packaging, so keeping the test on the production writer is the point.
function writeChecksums(dist) {
  writeWindowsChecksums(dist);
}

// electron-builder's own Windows output: the installer, its blockmap, and a
// latest.yml naming that installer, in the shape a published release carries.
function populate(dist, architectures = ["x64"]) {
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
  writeChecksums(dist);
  return dist;
}

function fixture(architectures = ["x64"]) {
  const dist = mkdtempSync(join(tmpdir(), "pwragent-windows-artifacts-"));
  directories.push(dist);
  return populate(dist, architectures);
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

  // windowsInstallerArtifacts asks "what did electron-builder build" by matching
  // the -setup.exe suffix, and relies on no alias matching it. Name an alias
  // something ending in -setup.exe and a second run would alias its own copy.
  test("no alias name can be mistaken for an installer by the artifact scan", () => {
    for (const name of Object.values(WINDOWS_ALIAS_NAMES)) {
      expect(name.endsWith("-setup.exe")).toBe(false);
    }
  });

  test("hashes the alias it wrote, not the installer it copied", () => {
    const dist = fixture();
    const [alias] = writeWindowsReleaseAliases(dist, version);
    const recorded = new Map(
      readFileSync(join(dist, "SHA256SUMS"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => [line.slice(66), line.slice(0, 64)]),
    );

    // Every published line must describe the bytes of the file it names.
    for (const [name, digest] of recorded) {
      expect(digest).toBe(sha256(readFileSync(join(dist, name))));
    }
    expect(recorded.get("PwrAgent.Setup.exe")).toBe(alias.sha256);
  });

  // The CLI is how this module is actually invoked -- the workflow runs it as a
  // process and nothing else does, so nothing but this covers the entrypoint
  // guard, the stage package.json read, or the argument handling. The guard in
  // particular has to fire on Windows, where argv[1] and import.meta.url
  // normalize differently.
  describe("command line", () => {
    function run(...args) {
      return spawnSync(process.execPath, [MODULE_PATH, ...args], { encoding: "utf8" });
    }

    function stage(manifest = { version }, architectures = ["x64"]) {
      const root = mkdtempSync(join(tmpdir(), "pwragent-windows-stage-"));
      directories.push(root);
      mkdirSync(join(root, "dist"));
      populate(join(root, "dist"), architectures);
      writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
      return root;
    }

    test("cuts the alias when invoked as a process", () => {
      const root = stage();
      const result = run(root);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("PwrAgent.Setup.exe <- ");
      expect(result.stdout).toContain("wrote 1 stable Windows alias(es)");
      expect(readFileSync(join(root, "dist", "PwrAgent.Setup.exe"), "utf8")).toBe(
        "installer bytes for x64",
      );
    });

    test("takes the version from the stage manifest, not from the file names", () => {
      const root = stage({ version: "9.9.9" });
      const result = run(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("No Windows installer for 9.9.9");
      expect(existsSync(join(root, "dist", "PwrAgent.Setup.exe"))).toBe(false);
    });

    test("refuses a stage with no directory argument and one with no manifest", () => {
      const missingArgument = run();
      expect(missingArgument.status).toBe(1);
      expect(missingArgument.stderr).toContain("Usage: windows-release-artifacts.mjs");

      const root = stage();
      rmSync(join(root, "package.json"));
      expect(run(root).status).not.toBe(0);
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
    writeChecksums(dist);

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
    writeChecksums(dist);

    const [alias] = writeWindowsReleaseAliases(dist, version);
    expect(alias.installer).toBe(installerName(version, "x64"));
    expect(readFileSync(join(dist, "PwrAgent.Setup.exe"), "utf8")).toBe("installer bytes for x64");
  });

  test("says so when only another version's installer is present", () => {
    const dist = fixture();
    const stale = "PwrAgent-0.0.1-windows-x64-setup.exe";
    rmSync(join(dist, installerName(version, "x64")));
    writeFileSync(join(dist, stale), "an older build");
    writeChecksums(dist);

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
