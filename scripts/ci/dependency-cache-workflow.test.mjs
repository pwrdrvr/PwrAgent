import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Completed-tree consumers fail hard when their cache key misses, and a key
// that omits an install input restores a stale tree silently. These checks
// keep every producer/consumer pair in ci.yml on the same key inputs.

const root = fileURLToPath(new URL("../../", import.meta.url));
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const action = "pwrdrvr/configure-nodejs@d416c1c78119b25fe03ee3ef78b75af0d69b10a7";

function job(name) {
  const body = ci.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
  if (!body) throw new Error(`Missing job: ${name}`);
  return body;
}

function setup(body) {
  const step = body
    .split(/^      - /m)
    .find((part) => part.includes("uses: pwrdrvr/configure-nodejs@"));
  if (!step) throw new Error("Missing dependency setup");
  return step;
}

function input(step, name) {
  return step.match(new RegExp(`^          ${name}: (.+)$`, "m"))?.[1];
}

function cacheInputs(step) {
  return step
    .split("          cache-inputs: |\n")[1]
    ?.match(/^            \S+$/gm)
    .map((line) => line.trim()) ?? [];
}

test("ci.yml pins one reviewed configure-nodejs revision", () => {
  const references = [...ci.matchAll(/uses: (pwrdrvr\/configure-nodejs@\S+)/g)];
  expect(references.length).toBeGreaterThan(0);
  for (const reference of references) expect(reference[1]).toBe(action);
});

describe.each([
  ["install-deps", ["lint", "build", "desktop-e2e"]],
  [
    "windows-install-deps",
    [
      "windows-verify",
      "windows-renderer-packages",
      "windows-e2e",
    ],
  ],
])("%s", (producer, consumers) => {
  const producerJob = job(producer);
  const producerSetup = setup(producerJob);

  test("populates a completed tree from a full checkout", () => {
    expect(input(producerSetup, "dependency-cache")).toBe("node-modules");
    expect(input(producerSetup, "cache-mode")).toBe("populate");
    expect(input(producerSetup, "cache-key-suffix")).toContain(action.split("@")[1]);
    expect(producerSetup).not.toMatch(/lookup-only|persistent-store-dir/);
    // Consumers hash a full checkout; a sparse producer could hash differently.
    expect(producerJob).not.toContain("sparse-checkout");
    expect(producerJob).not.toContain("PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN");
  });

  test.each(consumers)("%s restores the same key and never installs", (consumer) => {
    const consumerJob = job(consumer);
    const consumerSetup = setup(consumerJob);
    expect(consumerJob).toMatch(new RegExp(`needs: \\[[^\\]]*\\b${producer}\\b`));
    expect(consumerJob.match(/^    runs-on: .+$/m)[0])
      .toBe(producerJob.match(/^    runs-on: .+$/m)[0]);
    expect(input(consumerSetup, "cache-mode")).toBe("restore");
    for (const key of [
      "node-version",
      "dependency-cache",
      "cache-key-suffix",
      "cache-electron",
      "working-directory",
      "package-manager",
    ]) {
      expect(input(consumerSetup, key)).toBe(input(producerSetup, key));
    }
    expect(cacheInputs(consumerSetup)).toEqual(cacheInputs(producerSetup));
    expect(consumerJob).toContain('PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false"');
    expect(consumerJob).not.toMatch(/run:.*pnpm (?:i|install|rebuild)\b|--ignore-scripts/);
  });
});

// desktop-main runs release-deploy-isolation.test.mjs, which installs offline
// from the job's pnpm store. Completed trees carry no store, so these lanes
// keep the store-backed install.
test.each(["test", "windows-desktop-main"])("%s keeps a pnpm store", (name) => {
  const body = job(name);
  const step = setup(body);
  expect(step).not.toMatch(/dependency-cache|cache-mode|lookup-only/);
  expect(input(step, "cache-electron")).toBe('"true"');
  expect(body).not.toContain("PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN");
});

test("cache inputs cover the install lifecycle and its local imports", () => {
  const inputs = cacheInputs(setup(job("install-deps")));
  const visit = (file, seen = new Set()) => {
    if (seen.has(file)) return;
    seen.add(file);
    expect(inputs).toContain(file);
    const absolute = resolve(root, file);
    expect(existsSync(absolute)).toBe(true);
    if (!file.endsWith(".mjs")) return;
    const source = readFileSync(absolute, "utf8");
    for (const match of source.matchAll(/from ["'](\.[^"']+)["']/g)) {
      visit(relative(root, resolve(dirname(absolute), match[1])).replaceAll("\\", "/"), seen);
    }
  };
  const desktop = JSON.parse(readFileSync(resolve(root, "apps/desktop/package.json"), "utf8"));
  // Fails when postinstall changes, so the input list is revisited with it.
  expect(desktop.scripts.postinstall).toBe(
    "node scripts/ensure-electron-runtime.mjs && node ../../scripts/linux-sandbox.mjs --warn",
  );
  visit(".nvmrc");
  visit("apps/desktop/scripts/ensure-electron-runtime.mjs");
  visit("scripts/linux-sandbox.mjs");
  for (const patch of readdirSync(resolve(root, "patches"))) visit(`patches/${patch}`);
  expect(readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8"))
    .toMatch(/^packageImportMethod: auto$/m);
});
