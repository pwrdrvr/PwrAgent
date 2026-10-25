import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// `check` decides whether a job may skip the dependency cache restore, and
// `seed` is the only writer of the store that later jobs trust. Both run here
// against a scratch root with an injected clock; `install` needs the network
// and is exercised by CI itself.
const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "macos-e2e-guest-store.sh",
);

const DAY = 86400;
const NOW = 1_800_000_000;

let scratch;
let root;
let workspace;
let envFile;
let outputFile;

function run(command, { now = NOW, cacheRoot = root } = {}) {
  writeFileSync(envFile, "");
  writeFileSync(outputFile, "");
  const result = spawnSync("bash", [scriptPath, command], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: scratch,
      PWRAGENT_CI_CACHE_ROOT: cacheRoot,
      PWRAGENT_CI_NOW: String(now),
      GITHUB_ENV: envFile,
      GITHUB_OUTPUT: outputFile,
      GITHUB_WORKSPACE: workspace,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    env: readFileSync(envFile, "utf8"),
    output: readFileSync(outputFile, "utf8"),
  };
}

/** What configure-nodejs leaves in the workspace after a cold install. */
function fakeConfigureNodejs() {
  mkdirSync(path.join(workspace, ".pnpm-store", "v11", "files"), { recursive: true });
  writeFileSync(path.join(workspace, ".pnpm-store", "v11", "files", "pkg"), "bytes");
  mkdirSync(path.join(workspace, ".cache", "configure-nodejs", "electron"), { recursive: true });
  writeFileSync(path.join(workspace, ".cache", "configure-nodejs", "electron", "electron.zip"), "zip");
  mkdirSync(path.join(workspace, ".cache", "configure-nodejs", "npm"), { recursive: true });
}

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "guest-store-"));
  root = path.join(scratch, "cache-root");
  workspace = path.join(scratch, "workspace");
  envFile = path.join(scratch, "github-env");
  outputFile = path.join(scratch, "github-output");
  mkdirSync(workspace);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// The script runs only on the macOS guest. Windows unit lanes have no POSIX
// paths for its absolute-root guard, so skip there as the cleanup test does.
describe.skipIf(process.platform === "win32")("macos-e2e-guest-store.sh", () => {
  it("reports a cold store on a fresh guest and exports the root", () => {
    const result = run("check");
    expect(result.status).toBe(0);
    expect(result.output).toBe("warm=false\n");
    expect(result.env).toContain(`PWRAGENT_CI_CACHE_ROOT=${root}\n`);
  });

  it("seeds from the workspace, then reports warm", () => {
    fakeConfigureNodejs();
    const seeded = run("seed");
    expect(seeded.status).toBe(0);
    expect(existsSync(path.join(workspace, ".pnpm-store"))).toBe(false);
    expect(readFileSync(path.join(root, "pnpm-store", "v11", "files", "pkg"), "utf8")).toBe("bytes");
    expect(existsSync(path.join(root, "electron", "electron.zip"))).toBe(true);
    expect(seeded.env).toContain(`PNPM_CONFIG_STORE_DIR=${root}/pnpm-store\n`);
    expect(seeded.env).toContain(`electron_config_cache=${root}/electron\n`);

    expect(run("check", { now: NOW + DAY }).output).toBe("warm=true\n");
  });

  it("expires an old store so it is re-seeded from the current lockfile", () => {
    fakeConfigureNodejs();
    run("seed");
    const result = run("check", { now: NOW + 14 * DAY });
    expect(result.output).toBe("warm=false\n");
    expect(existsSync(path.join(root, "pnpm-store"))).toBe(false);
    expect(existsSync(path.join(root, "electron"))).toBe(false);
  });

  it("never trusts a store without its seed marker", () => {
    mkdirSync(path.join(root, "pnpm-store", "v11"), { recursive: true });
    const result = run("check");
    expect(result.output).toBe("warm=false\n");
    expect(existsSync(path.join(root, "pnpm-store"))).toBe(false);
  });

  it("treats an unreadable marker as cold", () => {
    mkdirSync(path.join(root, "pnpm-store"), { recursive: true });
    writeFileSync(path.join(root, "pnpm-store", ".pwragent-seeded"), "garbage\n");
    expect(run("check").output).toBe("warm=false\n");
  });

  it("leaves the store cold when configure-nodejs installed nothing", () => {
    const result = run("seed");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("stays cold");
    expect(existsSync(path.join(root, "pnpm-store"))).toBe(false);
  });

  it.each(["relative/path", "/"])("refuses the cache root %s", (cacheRoot) => {
    const result = run("check", { cacheRoot });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing guest cache root");
  });
});
