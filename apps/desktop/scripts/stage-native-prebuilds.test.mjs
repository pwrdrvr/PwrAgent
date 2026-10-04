import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NODE_PTY_REQUIRED_FILES,
  resolveBetterSqlite3Prebuild,
  resolveNodePtyPrebuild,
  stageNativePrebuilds,
} from "./stage-native-prebuilds.mjs";

const PACKAGED_TARGETS = [
  ["darwin", "x64"],
  ["darwin", "arm64"],
  ["linux", "x64"],
  ["linux", "arm64"],
  ["win32", "x64"],
  ["win32", "arm64"],
];

const temps = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
});

function writeFile(path, contents = path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function fixtureApp({ sqlitePackage = { version: "13.0.3", gypfile: false } } = {}) {
  const appDir = mkdtempSync(join(tmpdir(), "stage-native-prebuilds-"));
  temps.push(appDir);
  const sqliteDir = join(appDir, "node_modules", "better-sqlite3");
  const ptyDir = join(appDir, "node_modules", "node-pty");
  writeFile(join(sqliteDir, "package.json"), JSON.stringify(sqlitePackage));
  writeFile(join(ptyDir, "package.json"), JSON.stringify({ version: "1.2.0-beta.15" }));
  for (const [platform, arch] of PACKAGED_TARGETS) {
    writeFile(join(sqliteDir, "prebuilds", `${platform}-${arch}.node`), `sqlite ${platform}-${arch}`);
    const ptyPrebuild = join(ptyDir, "prebuilds", `${platform}-${arch}`);
    if (platform === "win32") {
      for (const file of [
        "conpty.node",
        "conpty.pdb",
        "conpty_console_list.node",
        "conpty_console_list.pdb",
        "conpty/conpty.dll",
        "conpty/OpenConsole.exe",
      ]) {
        writeFile(join(ptyPrebuild, file), `${file} ${arch}`);
      }
    } else {
      writeFile(join(ptyPrebuild, "pty.node"), `pty ${platform}-${arch}`);
      if (platform === "darwin") {
        // Deliberately not executable: staging must restore the mode bit.
        writeFile(join(ptyPrebuild, "spawn-helper"), `spawn-helper ${arch}`);
      }
    }
  }
  return { appDir, sqliteDir, ptyDir };
}

function listFiles(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? listFiles(join(dir, entry.name), relative)
      : [relative];
  });
}

describe("stageNativePrebuilds", () => {
  it("stages one Darwin architecture at build/Release and replaces the previous one", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { appDir, sqliteDir, ptyDir } = fixtureApp();
    // A host build, or the previous architecture's pass, left these behind.
    writeFile(join(sqliteDir, "build", "Release", "obj", "stale.o"));
    writeFile(join(ptyDir, "build", "Release", "pty.node"), "pty darwin-x64");

    stageNativePrebuilds({ appDir, platform: "darwin", arch: "arm64" });

    expect(listFiles(join(sqliteDir, "build"))).toEqual(["Release/better_sqlite3.node"]);
    expect(readFileSync(join(sqliteDir, "build", "Release", "better_sqlite3.node"), "utf8"))
      .toBe("sqlite darwin-arm64");
    expect(listFiles(join(ptyDir, "build")).sort()).toEqual([
      "Release/pty.node",
      "Release/spawn-helper",
    ]);
    expect(readFileSync(join(ptyDir, "build", "Release", "pty.node"), "utf8"))
      .toBe("pty darwin-arm64");
    // Windows has no POSIX mode bits; Darwin packaging only runs on macOS.
    if (process.platform !== "win32") {
      expect(statSync(join(ptyDir, "build", "Release", "spawn-helper")).mode & 0o777)
        .toBe(0o755);
    }
  });

  it("keeps Windows conpty files beside the binding and drops debug symbols", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { appDir, ptyDir } = fixtureApp();

    stageNativePrebuilds({ appDir, platform: "win32", arch: "x64" });

    expect(listFiles(join(ptyDir, "build")).sort()).toEqual([
      "Release/conpty.node",
      "Release/conpty/OpenConsole.exe",
      "Release/conpty/conpty.dll",
      "Release/conpty_console_list.node",
    ]);
  });

  it("refuses a better-sqlite3 without the Node-API prebuild layout", () => {
    const { appDir, sqliteDir } = fixtureApp({
      sqlitePackage: { version: "12.8.0" },
    });

    expect(() => stageNativePrebuilds({ appDir, platform: "darwin", arch: "arm64" }))
      .toThrow("better-sqlite3 12.8.0 does not expose the v13 Node-API prebuild layout");
    expect(existsSync(join(sqliteDir, "build"))).toBe(false);
  });

  it("refuses architectures with no prebuild", () => {
    const { appDir } = fixtureApp();

    expect(() => stageNativePrebuilds({ appDir, platform: "win32", arch: "ia32" }))
      .toThrow("Unsupported better-sqlite3 package architecture: ia32");
  });

  it("fails when a staged node-pty entry point is missing", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { appDir, ptyDir } = fixtureApp();
    rmSync(join(ptyDir, "prebuilds", "darwin-x64", "spawn-helper"));

    expect(() => stageNativePrebuilds({ appDir, platform: "darwin", arch: "x64" }))
      .toThrow("node-pty staging for darwin-x64 is missing spawn-helper");
  });
});

// A dependency bump that drops a packaged target would otherwise surface only
// in that platform's release job.
describe("installed native packages", () => {
  const require = createRequire(import.meta.url);
  const sqliteDir = dirname(require.resolve("better-sqlite3/package.json"));
  const ptyDir = dirname(require.resolve("node-pty/package.json"));

  it.each(PACKAGED_TARGETS)("ship a %s-%s prebuild", (platform, arch) => {
    expect(() => resolveBetterSqlite3Prebuild({ sqliteDir, platform, arch })).not.toThrow();
    const { prebuildDir } = resolveNodePtyPrebuild({ ptyDir, platform, arch });
    for (const file of NODE_PTY_REQUIRED_FILES[platform]) {
      expect(existsSync(join(prebuildDir, file)), file).toBe(true);
    }
  });
});
