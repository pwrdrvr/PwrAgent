import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createDesktopDebugArtifact, inspectDebugOutput, RELEASE_DEBUG_TARGETS,
  verifyReleaseDebugArtifacts,
  verifyPublishedDebugArtifacts,
} from "./desktop-debug-artifacts.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pwragent-debug-test-"));
  const desktopRoot = join(root, "apps", "desktop");
  mkdirSync(desktopRoot, { recursive: true });
  writeFileSync(join(desktopRoot, "package.json"), '{"version":"1.2.3"}\n');
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const name of ["electron", "electron-vite", "vite", "electron-builder"]) {
    const path = join(desktopRoot, "node_modules", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), '{"version":"1.0.0"}\n');
  }
  for (const target of ["main", "preload", "renderer/assets", "main/workers", "renderer/assets/lazy"]) {
    const path = join(desktopRoot, "out", target);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "index.js"), "throw new Error('fixture');\n");
    writeFileSync(join(path, "index.js.map"), JSON.stringify({
      version: 3, file: "index.js", sources: ["index.ts"], names: [],
      sourcesContent: ["throw new Error('fixture');\n"], mappings: "AAAA",
    }));
  }
  writeFileSync(join(desktopRoot, "out", "renderer", "index.html"), '<script src="assets/index.js"></script>');
  // Git state is owned by the fixture, not the operator's checkout.
  for (const args of [
    ["init", "--quiet"], ["add", "."],
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  }
  return { root, desktopRoot, out: join(desktopRoot, "out") };
}

it("retains exact JS, workers, lazy chunks, maps and build identity for all release targets", () => {
  const { root, desktopRoot } = fixture();
  try {
    let commit;
    for (const target of RELEASE_DEBUG_TARGETS) {
      const [platform, arch] = target.split("-");
      const { archive, manifest } = createDesktopDebugArtifact({
        desktopRoot, repoRoot: root, platform, arch,
        env: { RELEASE_TAG: "v1.2.3", GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2" },
      });
      commit = manifest.commit;
      expect(manifest).toMatchObject({
        version: "1.2.3", platform, arch, trackedChanges: false,
        ci: { runId: "42", runAttempt: "2" },
      });
      const result = spawnSync("tar", ["-xOf", archive, "out/main/workers/index.js"], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(readFileSync(join(desktopRoot, "out/main/workers/index.js"), "utf8"));
      expect(manifest.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "out/renderer/assets/lazy/index.js", sourceMap: "out/renderer/assets/lazy/index.js.map" }),
        expect.objectContaining({ path: "out/renderer/index.html" }),
      ]));
    }
    const directory = join(desktopRoot, ".local/debug-artifacts");
    expect(() => verifyReleaseDebugArtifacts(directory, "1.2.3", commit)).not.toThrow();
    expect(() => verifyReleaseDebugArtifacts(directory, "1.2.3", "wrong-commit")).toThrow("identity mismatch");
    const name = "PwrAgent-1.2.3-linux-arm64-debug.tar.gz";
    writeFileSync(join(directory, name), "corrupt archive");
    expect(() => verifyReleaseDebugArtifacts(directory, "1.2.3", commit)).toThrow("checksum mismatch");
    rmSync(join(directory, `${name}.sha256`));
    expect(() => verifyReleaseDebugArtifacts(directory, "1.2.3", commit)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("requires all archive and checksum names on the published release", () => {
  const names = RELEASE_DEBUG_TARGETS.flatMap((target) => {
    const name = `PwrAgent-1.2.3-${target}-debug.tar.gz`;
    return [name, `${name}.sha256`];
  });
  expect(() => verifyPublishedDebugArtifacts(names, "1.2.3")).not.toThrow();
  expect(() => verifyPublishedDebugArtifacts(names.slice(1), "1.2.3")).toThrow("missing");
});

it("rejects missing target maps, exposed map URLs, missing embedded sources and orphan maps", () => {
  const { root, out, desktopRoot } = fixture();
  try {
    const path = join(out, "preload/index.js");
    const mapPath = `${path}.map`;
    const originalMap = readFileSync(mapPath, "utf8");
    writeFileSync(path, "throw 1;\n//# sourceMappingURL=index.js.map");
    expect(() => inspectDebugOutput(out)).toThrow("not hidden");
    writeFileSync(path, "throw 1;");
    const map = JSON.parse(originalMap);
    map.sourcesContent = [null];
    writeFileSync(mapPath, JSON.stringify(map));
    expect(() => inspectDebugOutput(out)).toThrow("embedded sources");
    writeFileSync(mapPath, originalMap);
    rmSync(path);
    expect(() => inspectDebugOutput(out)).toThrow("matching JavaScript");
    rmSync(mapPath);
    expect(() => inspectDebugOutput(out)).toThrow("Missing preload");
    expect(() => createDesktopDebugArtifact({
      desktopRoot, repoRoot: root, platform: "linux", arch: "x64", env: { RELEASE_TAG: "v1.2.4" },
    })).toThrow("does not match");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
