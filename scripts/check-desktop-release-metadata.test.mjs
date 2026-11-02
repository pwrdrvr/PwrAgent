import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const directories = [];
const signingInputPaths = JSON.parse(readFileSync(join(repoRoot, "scripts/release/signing-input-paths.json"), "utf8"));
const sources = new Set([
  "pnpm-workspace.yaml",
  "scripts/check-desktop-release-metadata.mjs",
  "scripts/release/check-signing-input.mjs",
  "scripts/release/signing-input-paths.json",
  "scripts/release/install-trusted-signing.ps1",
  "scripts/release/archive-windows-signing-input.ps1",
  "apps/desktop/package.json",
  "packages/pwragent/package.json",
  "packages/pwragent/scripts/release.mjs",
  "apps/desktop/electron-builder.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  ".github/workflows/preview-build.yml",
  ".github/actions/select-xcode-for-actool/action.yml",
  "docs/desktop-release-runbook.md",
  "CHANGELOG.md",
  ...Object.values(signingInputPaths).flat().filter((path) => path.endsWith(".mjs")),
]);

function fixture() {
  const local = join(repoRoot, ".local");
  mkdirSync(local, { recursive: true });
  const root = mkdtempSync(join(local, "release-metadata-test-"));
  directories.push(root);
  for (const path of sources) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repoRoot, path), join(root, path));
  }
  return root;
}

function replace(root, path, before, after) {
  const file = join(root, path);
  const source = readFileSync(file, "utf8");
  expect(source).toContain(before);
  writeFileSync(file, source.replace(before, after));
}

function check(root) {
  const { version } = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8"));
  return spawnSync(process.execPath, [
    join(root, "scripts/check-desktop-release-metadata.mjs"), "--tag", `v${version}`,
  ], { cwd: root, encoding: "utf8" });
}

afterEach(() => {
  directories.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

test("accepts the current packaging contract with Linux naming delegated to its helper", () => {
  const result = check(fixture());
  expect(result.status, result.stderr).toBe(0);
});

test("rejects Outpost version or npm channel drift from the desktop authority", () => {
  for (const change of [{ version: "0.1.0-alpha.1" }, { publishConfig: { access: "public", registry: "https://registry.npmjs.org", tag: "next" } }]) {
    const root = fixture();
    const file = join(root, "packages/pwragent/package.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...change }));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Outpost release metadata");
  }
});

test.each(
  ["sign", "linux-package", "windows-prepare"].flatMap((job) =>
    ["lint", "test"].map((dependency) => ({ job, dependency })),
  ),
)("rejects $job bypassing the $dependency release gate", ({ job, dependency }) => {
  const root = fixture();
  const path = ".github/workflows/release.yml";
  const workflow = readFileSync(join(root, path), "utf8");
  const jobBody = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [A-Za-z0-9_-]+:\n/)[0];
  const need = `      - ${dependency}\n`;
  expect(jobBody).toContain(need);
  replace(root, path, jobBody, jobBody.replace(need, ""));
  const result = check(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${job} must depend on ${dependency}`);
});

test.each([
  ...["install-deps", "lint", "test", "prepare", "sign"].map((job) => ({ file: "release.yml", job })),
  { file: "ci.yml", job: "macos-install-deps" },
  { file: "ci.yml", job: "test-macos" },
  { file: "ci.yml", job: "desktop-e2e-macos" },
  { file: "preview-build.yml", job: "preview" },
])("rejects self-hosted Mac compute in $file $job", ({ file, job }) => {
  const root = fixture();
  const path = `.github/workflows/${file}`;
  const source = readFileSync(join(root, path), "utf8");
  const body = source.split(`\n  ${job}:\n`)[1].split(/\n  [A-Za-z0-9_-]+:\n/)[0];
  const selfHosted = body.replace("runs-on: macos-26", "runs-on: [self-hosted, macOS, ARM64]");
  expect(selfHosted).not.toBe(body);
  replace(root, path, body, selfHosted);
  const result = check(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${job} must run on macos-26`);
});

test("rejects a release dependency install that downloads the cache on a hit", () => {
  const root = fixture();
  replace(root, ".github/workflows/release.yml", '          lookup-only: "true"\n', "");
  const result = check(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("lookup-only");
});

test.each(["windows-sign", "publish-release-assets", "publish-release-notes"])(
  "rejects %s without explicit runtime-only Node setup",
  (job) => {
    const root = fixture();
    const path = ".github/workflows/release.yml";
    const workflow = readFileSync(join(root, path), "utf8");
    const body = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [A-Za-z0-9_-]+:\n/)[0];
    const runtime = body.match(/      - name: Set up Node\.js runtime only\n[\s\S]*?(?=      - )/)[0];
    replace(root, path, body, body.replace(runtime, ""));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${job} Set up Node.js runtime only must contain`);
  },
);

test.each(["windows-sign", "publish-release-assets", "publish-release-notes"])(
  "rejects %s enabling package-manager caching in runtime-only setup",
  (job) => {
    const root = fixture();
    const path = ".github/workflows/release.yml";
    const workflow = readFileSync(join(root, path), "utf8");
    const body = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [A-Za-z0-9_-]+:\n/)[0];
    replace(root, path, body, body.replace("package-manager-cache: false", "package-manager-cache: true"));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${job} Set up Node.js runtime only must contain "package-manager-cache: false"`);
  },
);

test("rejects a release test matrix that omits half the suite", () => {
  const root = fixture();
  replace(root, ".github/workflows/release.yml", "lane: [1, 2]", "lane: [1]");
  const result = check(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("test must contain \"lane: [1, 2]\"");
});

test("rejects release unit tests that may skip the macOS icon compile", () => {
  const root = fixture();
  replace(root, ".github/workflows/release.yml", "PWRAGENT_REQUIRE_ACTOOL: \"1\"", "PWRAGENT_REQUIRE_ACTOOL: \"0\"");
  const result = check(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("test must contain \"PWRAGENT_REQUIRE_ACTOOL:");
});

test.each([
  ["a stale protocol version", "@pwrdrvr/codex-app-server-protocol@0.133.0"],
  ["a package-wide protocol exception", "@pwrdrvr/codex-app-server-protocol"],
  ["an organization-wide exception", "@pwrdrvr/*"],
])("rejects %s in the release age exclusions", (_name, exception) => {
  const root = fixture();
  const desktop = JSON.parse(readFileSync(join(root, "apps/desktop/package.json"), "utf8"));
  const pin = `@pwrdrvr/codex-app-server-protocol@${desktop.dependencies["@pwrdrvr/codex-app-server-protocol"]}`;
  replace(root, "pnpm-workspace.yaml", `  - '${pin}'`, `  - '${exception}'`);
  const result = check(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`minimumReleaseAgeExclude must contain the exact desktop protocol pin ${pin}`);
});

test("rejects a desktop protocol upgrade without its version-scoped age exception", () => {
  const root = fixture();
  const path = join(root, "apps/desktop/package.json");
  const desktop = JSON.parse(readFileSync(path, "utf8"));
  desktop.dependencies["@pwrdrvr/codex-app-server-protocol"] = "0.999.0";
  writeFileSync(path, JSON.stringify(desktop));
  const result = check(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("exact desktop protocol pin @pwrdrvr/codex-app-server-protocol@0.999.0");
});

test.each([
  [
    "a lost format",
    "[\"deb\", \"rpm\", \"pacman\", \"tar.gz\"]",
    "[\"deb\", \"pacman\", \"tar.gz\"]",
    "must support DEB, RPM, pacman and tar.gz",
  ],
  [
    "a lost architecture",
    "[\"x64\", \"arm64\"]",
    "[\"x64\"]",
    "must support x64 and arm64",
  ],
  [
    "an incorrect builder architecture",
    "deb: \"amd64\"",
    "deb: \"x64\"",
    "format-specific architecture names",
  ],
  [
    "a broken stable download URL",
    "return `PwrAgent-linux-${arch}.${extension}`;",
    "return `PwrAgent-${arch}.${extension}`;",
    "stable alias",
  ],
])("rejects %s in the executable artifact helper", (_name, before, after, diagnostic) => {
  const root = fixture();
  replace(root, "apps/desktop/scripts/linux-release-artifacts.mjs", before, after);
  const result = check(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(diagnostic);
});

test("rejects a package omitted from publication even when debug retention still includes it", () => {
  const root = fixture();
  replace(root, ".github/workflows/release.yml", "            linux-dist/*.rpm \\\n", "");
  const result = check(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Create release and publish all platform assets must contain \"linux-dist/*.rpm\"");
});

test("still rejects a signing archive that loses the reusable Linux helper", () => {
  const root = fixture();
  const path = join(root, "scripts/release/signing-input-paths.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.windows = manifest.windows.filter((entry) => !entry.endsWith("/linux-release-artifacts.mjs"));
  writeFileSync(path, JSON.stringify(manifest));
  const result = check(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("release.mjs imports ./linux-release-artifacts.mjs, but signing input omits");
});
