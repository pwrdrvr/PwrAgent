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
