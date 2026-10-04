import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { build } from "vite";
import { inlineWorkerDebugCode } from "./inline-worker-debug-code.mjs";
import {
  createDesktopDebugArtifact, inspectDebugOutput, RELEASE_DEBUG_TARGETS,
  desktopDebugTarCommand,
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
      const result = spawnSync(desktopDebugTarCommand(), ["-xOf", archive, "out/main/workers/index.js"], { encoding: "utf8" });
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

it("selects Windows native tar rather than a PATH entry from Git", () => {
  expect(desktopDebugTarCommand("win32", "D:\\Windows")).toBe("D:\\Windows\\System32\\tar.exe");
  expect(desktopDebugTarCommand("linux")).toBe("tar");
  expect(desktopDebugTarCommand("darwin")).toBe("tar");
});

it("retains usable hidden maps for the real lazy inline pixel-diff worker", async () => {
  const { root, desktopRoot, out } = fixture();
  try {
    const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "../src/renderer");
    const workerDebug = inlineWorkerDebugCode();
    let inlineCode;
    await build({
      configFile: false,
      root: sourceRoot,
      logLevel: "silent",
      plugins: [workerDebug.renderer, {
        name: "capture-inline-worker-payload",
        transform(code, id) {
          if (id.endsWith("?worker&inline")) {
            // Vite embeds the exact generated worker as this string literal;
            // esbuild may change its quoting before this transform runs.
            const literal = code.match(/^const jsContent = (.*);$/m)?.[1];
            expect(literal).toBeDefined();
            inlineCode = runInNewContext(literal);
          }
        },
      }],
      worker: { plugins: () => [workerDebug.worker] },
      build: {
        outDir: join(out, "renderer"),
        emptyOutDir: true,
        minify: "esbuild",
        sourcemap: "hidden",
        rollupOptions: {
          input: join(sourceRoot, "src/features/thread-detail/image-diff/pixel-diff-client.ts"),
          preserveEntrySignatures: "strict",
        },
      },
    });
    // Vite's synthetic inline-worker wrapper has an empty map when it is
    // dynamically imported directly. Build the actual client so this catches
    // that packaging regression rather than accepting a handwritten map.
    const { manifest } = createDesktopDebugArtifact({
      desktopRoot, repoRoot: root, platform: "linux", arch: "arm64", env: {},
    });
    const workerMap = manifest.files.find((file) =>
      /renderer\/assets\/pixel-diff\.worker-.*\.js\.map$/.test(file.path));
    expect(workerMap).toBeDefined();
    expect(inlineCode).toEqual(expect.any(String));
    expect(readFileSync(join(desktopRoot, workerMap.path.slice(0, -4)), "utf8"))
      .toBe(inlineCode);
    const map = JSON.parse(readFileSync(join(desktopRoot, workerMap.path), "utf8"));
    expect(map.sources).toEqual(expect.arrayContaining([
      expect.stringContaining("pixel-diff.worker.ts"),
      expect.stringContaining("pixel-diff-options.ts"),
      expect.stringContaining("pixelmatch"),
    ]));
    expect(map.sourcesContent).toContain(readFileSync(join(
      sourceRoot, "src/features/thread-detail/image-diff/pixel-diff.worker.ts",
    ), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("captures the configured Linux architecture from release orchestration before packaging", () => {
  // Execute the actual capture call with the architecture resolver in scope.
  // Generator-only tests cannot catch a missing binding in release.mjs.
  const release = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
  const resolver = release.slice(
    release.indexOf("function currentLinuxBuilderArch()"),
    release.indexOf("function findLinuxUnpackedDir"),
  );
  const capture = release.slice(
    release.indexOf("  const debug = createDesktopDebugArtifact("),
    release.indexOf("  console.log(`  debug artifact:"),
  );
  for (const arch of ["x64", "arm64"]) {
    let options;
    runInNewContext(`${resolver}\n${capture}`, {
      process: { env: { PWRAGENT_LINUX_ARCH: arch }, arch: "x64" },
      linux: true, win: false, macArch: "universal",
      desktopRoot: "/fixture/desktop", repoRoot: "/fixture",
      createDesktopDebugArtifact: (captured) => {
        options = captured;
        return { archive: "/fixture/debug.tar.gz" };
      },
    });
    expect(options).toMatchObject({ platform: "linux", arch });
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
