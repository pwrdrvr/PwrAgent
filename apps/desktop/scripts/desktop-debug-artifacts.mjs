import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_DEBUG_TARGETS = [
  "darwin-universal", "darwin-arm64", "win32-x64", "linux-x64", "linux-arm64",
];
const scriptPath = fileURLToPath(import.meta.url);
const defaultDesktopRoot = resolve(dirname(scriptPath), "..");
const javascript = /\.(?:js|cjs|mjs)$/;
const debugFile = /\.(?:js|cjs|mjs|map|html|css)$/;
const mapComment = /(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL\s*=/;
const instructions = `# PwrAgent desktop debug artifact

manifest.json identifies the exact build, target, and SHA-256 of every file.
out/ preserves paths relative to app.asar, including main, preload, renderer,
worker entries, lazy chunks, and hidden JavaScript source maps. Maps embed
sourcesContent, so a checkout at the recorded commit is optional for inspection.
External npm modules and native code are outside these Vite source maps.

Match the installed version and platform/architecture first, then confirm the
generated JavaScript's SHA-256 against manifest.json (extract it from app.asar).
Use the adjacent .map for the exact stack-frame file, line, and column. Stack
lines are 1-based; source-map API columns are 0-based (subtract one from a
browser stack's column). DevTools supports manually loading a source map for
the matching generated file; maps are intentionally absent from the app.
Never rebuild a tag and assume its chunk names or offsets match a shipped app.
CI run ID and attempt distinguish repeated builds of the same version/commit.
`;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout.trim();
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function walk(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return walk(root, path);
      if (!entry.isFile()) throw new Error(`Unexpected non-file in build output: ${path}`);
      return debugFile.test(path) ? [path] : [];
    });
}

// Validate real build output before retaining it. A renderer-only map would
// miss preload/main workers; an empty or source-less map cannot debug offline.
export function inspectDebugOutput(outRoot) {
  const paths = walk(outRoot);
  const mappedTargets = new Set();
  const files = paths.map((path) => {
    const bytes = readFileSync(join(outRoot, path));
    if (javascript.test(path) && mapComment.test(bytes.toString("utf8"))) {
      throw new Error(`Source map URL is not hidden: ${path}`);
    }
    if (/\.(?:js|cjs|mjs)\.map$/.test(path)) {
      const map = JSON.parse(bytes);
      const generated = path.slice(0, -4);
      if (!paths.includes(generated) || map.file !== basename(generated)) {
        throw new Error(`Source map has no matching JavaScript: ${path}`);
      }
      if (map.version !== 3 || !map.mappings || !map.sources?.length
        || map.sourcesContent?.length !== map.sources.length
        || map.sourcesContent.some((source) => typeof source !== "string")) {
        throw new Error(`Source map lacks mappings or embedded sources: ${path}`);
      }
      mappedTargets.add(path.split("/")[0]);
    }
    return {
      path: `out/${path}`,
      bytes: bytes.length,
      sha256: hash(bytes),
      ...(javascript.test(path)
        ? { sourceMap: paths.includes(`${path}.map`) ? `out/${path}.map` : null }
        : {}),
    };
  });
  for (const target of ["main", "preload", "renderer"]) {
    if (!mappedTargets.has(target)) throw new Error(`Missing ${target} source maps`);
  }
  return files;
}

export function createDesktopDebugArtifact({
  desktopRoot = defaultDesktopRoot,
  repoRoot = resolve(desktopRoot, "../.."),
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  const target = `${platform}-${arch}`;
  if (!RELEASE_DEBUG_TARGETS.includes(target)) throw new Error(`Unsupported debug target: ${target}`);
  const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
  const version = pkg.version;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid debug artifact version: ${version}`);
  }
  if (env.RELEASE_TAG && env.RELEASE_TAG !== `v${version}`) {
    throw new Error(`Debug artifact version ${version} does not match ${env.RELEASE_TAG}`);
  }
  const files = inspectDebugOutput(join(desktopRoot, "out"));
  const require = createRequire(join(desktopRoot, "package.json"));
  const tools = Object.fromEntries(["electron", "electron-vite", "vite", "electron-builder"].map(
    (name) => [name, require(`${name}/package.json`).version],
  ));
  const dirty = spawnSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: repoRoot });
  if (dirty.error || ![0, 1].includes(dirty.status)) throw new Error("Cannot determine build tree state");
  const manifest = {
    schemaVersion: 1,
    version,
    releaseTag: env.RELEASE_TAG || null,
    commit: run("git", ["rev-parse", "HEAD"], repoRoot),
    trackedChanges: dirty.status === 1,
    builtAt: new Date().toISOString(),
    platform,
    arch,
    buildHost: { platform: process.platform, arch: process.arch, node: process.version },
    tools,
    lockfileSha256: hash(readFileSync(join(repoRoot, "pnpm-lock.yaml"))),
    ci: {
      repository: env.GITHUB_REPOSITORY || null,
      ref: env.GITHUB_REF || null,
      runId: env.GITHUB_RUN_ID || null,
      runAttempt: env.GITHUB_RUN_ATTEMPT || null,
      workflow: env.GITHUB_WORKFLOW || null,
    },
    files,
  };
  // Outside out/ and release-stage: pnpm deploy and electron-builder must not
  // copy the debug archive into a signed app or a protected signing input.
  const destination = join(desktopRoot, ".local", "debug-artifacts");
  mkdirSync(destination, { recursive: true });
  const name = `PwrAgent-${version}-${target}-debug.tar.gz`;
  const archive = join(destination, name);
  const staging = mkdtempSync(join(tmpdir(), "pwragent-debug-"));
  try {
    for (const file of files) {
      const targetPath = join(staging, file.path);
      mkdirSync(dirname(targetPath), { recursive: true });
      copyFileSync(join(desktopRoot, file.path), targetPath);
    }
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(staging, "README.md"), instructions);
    run("tar", ["-czf", archive, "-C", staging, "manifest.json", "README.md", "out"], repoRoot);
    writeFileSync(`${archive}.sha256`, `${hash(readFileSync(archive))}  ${name}\n`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { archive, manifest };
}

// Publication must fail if any target's intermediate artifact was omitted or
// comes from another tag/commit. Digests protect the archive in transit; the
// manifest's per-file digests let an operator match an installed app exactly.
export function verifyReleaseDebugArtifacts(directory, version, commit) {
  for (const target of RELEASE_DEBUG_TARGETS) {
    const name = `PwrAgent-${version}-${target}-debug.tar.gz`;
    const archive = join(directory, name);
    const recorded = readFileSync(`${archive}.sha256`, "utf8").trim();
    if (recorded !== `${hash(readFileSync(archive))}  ${name}`) {
      throw new Error(`Debug artifact checksum mismatch: ${name}`);
    }
    const manifest = JSON.parse(run("tar", ["-xOf", archive, "manifest.json"], directory));
    if (manifest.schemaVersion !== 1 || manifest.version !== version
      || manifest.commit !== commit || manifest.releaseTag !== `v${version}`
      || `${manifest.platform}-${manifest.arch}` !== target || manifest.trackedChanges) {
      throw new Error(`Debug artifact build identity mismatch: ${name}`);
    }
  }
}

export function verifyPublishedDebugArtifacts(names, version) {
  const published = new Set(names);
  for (const target of RELEASE_DEBUG_TARGETS) {
    const archive = `PwrAgent-${version}-${target}-debug.tar.gz`;
    for (const name of [archive, `${archive}.sha256`]) {
      if (!published.has(name)) throw new Error(`Published release is missing ${name}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    if (process.argv[2] === "verify-published") {
      verifyPublishedDebugArtifacts(readFileSync(process.argv[3], "utf8").trim().split(/\r?\n/), process.argv[4]);
      console.log("Verified published debug artifact names");
    } else if (process.argv[2] === "verify-release") {
      verifyReleaseDebugArtifacts(resolve(process.argv[3]), process.argv[4], process.argv[5]);
      console.log("Verified all five release debug artifacts");
    } else {
      const result = createDesktopDebugArtifact({ platform: process.argv[2], arch: process.argv[3] });
      console.log(`Created ${result.archive} (${result.manifest.files.length} files)`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
