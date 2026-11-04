import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import dugite from "dugite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bundledGitDirectory, bundledGitEnvironment, bundledGitExecutable } from "../bundled-git";
import { customGitEnvironment } from "../git-runtime";

// Real Git is the oracle: whatever the operator configured must read the same
// through PwrAgent's environment as through Dugite's own, however many times
// PwrAgent built that environment (its terminal and Codex environments build
// it twice) and whichever Pwr app built it first.

type Entry = readonly [key: string, value: string];
type Scenario = {
  operatorSystem: Entry[] | null;
  global: Entry[];
  local: Entry[];
  // Who set GIT_CONFIG_SYSTEM before this environment was built.
  inheritedFrom: "nothing" | "pwrgit";
  // How many times PwrAgent builds the environment.
  builds: number;
};

const KEYS = ["pwrtest.alpha", "pwrtest.beta", "checkout.reflink"];
const entry = fc.tuple(fc.constantFrom(...KEYS), fc.constantFrom("true", "false", "one", "two"));
const scenario: fc.Arbitrary<Scenario> = fc.record({
  operatorSystem: fc.option(fc.array(entry, { maxLength: 4 }), { nil: null }),
  global: fc.array(entry, { maxLength: 3 }),
  local: fc.array(entry, { maxLength: 3 }),
  inheritedFrom: fc.constantFrom("nothing", "pwrgit"),
  builds: fc.integer({ min: 1, max: 3 }),
});

function configText(entries: readonly Entry[], prefix = ""): string {
  return prefix + entries.map(([key, value]) => {
    const dot = key.lastIndexOf(".");
    return `[${key.slice(0, dot)}]\n\t${key.slice(dot + 1)} = ${value}\n`;
  }).join("");
}

/** Every pwrtest value and checkout.reflink, in the order Git reads them. */
function readConfig(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const result = spawnSync(bundledGitExecutable(), ["config", "--get-regexp", "^(pwrtest\\.|checkout\\.reflink$)"], {
    cwd,
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
  expect(result.status === 0 || result.status === 1, result.stderr).toBe(true);
  return result.stdout.split("\n").filter(Boolean);
}

// Include paths are compared unescaped, which holds for POSIX paths only.
describe.skipIf(process.platform === "win32")("bundled Git system config, against Git itself", () => {
  let root: string;
  let repo: string;
  let base: NodeJS.ProcessEnv;
  let otherBundleConfig: string;
  let run = 0;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pwragent-config-oracle-")));
    vi.stubEnv("PWRAGENT_HOME", path.join(root, "home"));
    repo = path.join(root, "repo");
    mkdirSync(repo);
    expect(spawnSync(bundledGitExecutable(), ["init", "-q", repo]).status).toBe(0);
    base = { ...process.env };
    for (const key of ["GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]) {
      delete base[key];
    }
    // Another Pwr app's bundled Git, as PwrGit's generated config includes it.
    const otherBundle = path.join(root, "OtherApp", "git");
    mkdirSync(path.join(otherBundle, "libexec", "git-core"), { recursive: true });
    mkdirSync(path.join(otherBundle, "etc"));
    otherBundleConfig = path.join(otherBundle, "etc", "gitconfig");
    writeFileSync(otherBundleConfig, "[pwrtest]\n\talpha = other-bundle\n");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function setUp(s: Scenario) {
    const dir = path.join(root, `run-${run += 1}`);
    mkdirSync(dir);
    const globalConfig = path.join(dir, "global");
    writeFileSync(globalConfig, configText(s.global));
    writeFileSync(path.join(repo, ".git", "config"), configText(s.local, "[core]\n\trepositoryformatversion = 0\n\tbare = false\n"));
    let operatorConfig: string | undefined;
    if (s.operatorSystem) {
      operatorConfig = path.join(dir, "operator system config");
      writeFileSync(operatorConfig, configText(s.operatorSystem));
    }
    const source: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_GLOBAL: globalConfig };
    if (s.inheritedFrom === "pwrgit") {
      // PwrGit's generated config: defaults, then the system config it read.
      const pwrgit = path.join(dir, "pwrgit-gitconfig");
      writeFileSync(pwrgit, [
        "# Written by PwrGit: defaults for its bundled Git, then the system",
        "[credential]",
        "\thelper = pwrgit",
        "[include]",
        `\tpath = "${operatorConfig ?? otherBundleConfig}"`,
        "",
      ].join("\n"));
      source.GIT_CONFIG_SYSTEM = pwrgit;
    } else if (operatorConfig) {
      source.GIT_CONFIG_SYSTEM = operatorConfig;
    }
    return { source, operatorConfig };
  }

  it("reads the operator's system, global and repository config as Dugite's Git does", () => {
    fc.assert(fc.property(scenario, (s) => {
      const { source, operatorConfig } = setUp(s);
      let env = source;
      for (let build = 0; build < s.builds; build += 1) env = bundledGitEnvironment(env, { platform: "linux" });
      const stock = dugite.setupEnvironment({}, {
        ...source,
        GIT_CONFIG_SYSTEM: operatorConfig ?? path.join(bundledGitDirectory(), "etc", "gitconfig"),
      }).env;
      const expected = readConfig(stock, repo);
      const actual = readConfig(env, repo);
      const isReflink = (line: string) => line.startsWith("checkout.reflink ");
      // The operator's values arrive complete and in order.
      expect(actual.filter((line) => !isReflink(line))).toEqual(expected.filter((line) => !isReflink(line)));
      // checkout.reflink is PwrAgent's default until the operator sets it.
      const reflink = (lines: string[]) => lines.filter(isReflink).at(-1);
      expect(reflink(actual)).toBe(reflink(expected) ?? "checkout.reflink true");
    }), { numRuns: 30 });
  });

  it("hands an installed Git the operator's own system config, or none", () => {
    fc.assert(fc.property(scenario, (s) => {
      const { source, operatorConfig } = setUp(s);
      let env = source;
      for (let build = 0; build < s.builds; build += 1) env = bundledGitEnvironment(env, { platform: "linux" });
      expect(customGitEnvironment(env, "/usr/bin/git").GIT_CONFIG_SYSTEM).toBe(operatorConfig);
    }), { numRuns: 50 });
  });
});

// Dugite is the oracle. It sets this only on Linux, and only without
// LOCAL_GIT_DIRECTORY, which PwrAgent always passes.
describe.skipIf(process.platform !== "linux")("bundled Git certificates, against Dugite", () => {
  it("points Git at the bundle's CA file exactly when Dugite would", () => {
    expect(existsSync(path.join(bundledGitDirectory(), "ssl", "cacert.pem"))).toBe(true);
    const inherited = fc.option(fc.constantFrom("", " ", "/operator/ca.pem", "relative.pem"), { nil: undefined });
    fc.assert(fc.property(inherited, fc.integer({ min: 1, max: 3 }), (value, builds) => {
      const source: NodeJS.ProcessEnv = { ...process.env };
      if (value === undefined) delete source.GIT_SSL_CAINFO;
      else source.GIT_SSL_CAINFO = value;
      let env = source;
      for (let build = 0; build < builds; build += 1) env = bundledGitEnvironment(env);
      expect(env.GIT_SSL_CAINFO).toBe(dugite.setupEnvironment({}, source).env.GIT_SSL_CAINFO);
    }));
  });
});
