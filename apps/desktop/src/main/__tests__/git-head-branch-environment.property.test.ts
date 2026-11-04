import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NOT_A_GIT_REPOSITORY, probeCurrentGitBranch } from "../app-server/git-head-branch";

const execFile = promisify(execFileCallback);

// The probe exists so a thread start or turn end in a folder with no
// repository launches no Git (PowerShell plus Git on Windows, #3226). Git
// configuration passed through the environment defers the probe to Git only
// when it could change what Git discovers or how it reads HEAD.
//
// Playwright puts `core.autocrlf=false` in the environment the app inherits.
// Treating it as an override sent every E2E thread start in a scratch folder
// to Git. On a fresh Windows runner that launch took 2.2 s of a 2.3 s first
// send, and over 5 s when composer-image-thread-switch.spec.ts became the
// first thread start in its lane.

const isolatedGitKeys = /^(?:PWRAGENT_GIT_PATH|GIT_(?:DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|INDEX_FILE|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG.*))$/i;
let savedGitEnv: Map<string, string>;

beforeEach(() => {
  savedGitEnv = new Map();
  for (const [key, value] of Object.entries(process.env)) {
    if (isolatedGitKeys.test(key) && value !== undefined) {
      savedGitEnv.set(key, value);
      delete process.env[key];
    }
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (isolatedGitKeys.test(key)) delete process.env[key];
  }
  for (const [key, value] of savedGitEnv) process.env[key] = value;
});

type ConfigEntry = { key: string; value: string };

function gitEnvironment(entries: readonly ConfigEntry[]): Record<string, string> {
  const env: Record<string, string> = {};
  if (entries.length === 0) return env;
  env.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach((entry, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = entry.key;
    env[`GIT_CONFIG_VALUE_${index}`] = entry.value;
  });
  return env;
}

/** Git with the same environment configuration, and nothing from the machine. */
async function git(cwd: string, args: string[], entries: readonly ConfigEntry[] = []) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (isolatedGitKeys.test(key)) delete env[key];
  }
  return await execFile("git", ["-C", cwd, ...args], {
    env: {
      ...env,
      ...gitEnvironment(entries),
      GIT_CONFIG_GLOBAL: path.join(cwd, "missing-global-config"),
      GIT_CONFIG_SYSTEM: path.join(cwd, "missing-system-config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    encoding: "utf8",
    windowsHide: true,
  });
}

/** What `readCurrentGitBranch` would report, according to Git itself. */
async function gitAnswer(cwd: string, entries: readonly ConfigEntry[]) {
  try {
    const { stdout } = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], entries);
    return { branch: stdout.trim() };
  } catch (error) {
    if (/not a git repository/i.test(String((error as { stderr?: string }).stderr ?? error))) {
      return NOT_A_GIT_REPOSITORY;
    }
    throw error;
  }
}

describe("probeCurrentGitBranch with Git configuration in the environment", () => {
  let root: string;
  let layouts: Record<"no-repository" | "branch" | "detached", string>;
  let noRepositoryReachable = true;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-head-env-")));
    layouts = {
      "no-repository": path.join(root, "scratch", "nested"),
      branch: path.join(root, "branch"),
      detached: path.join(root, "detached"),
    };
    await mkdir(layouts["no-repository"], { recursive: true });
    // The walk reaches the filesystem root, so a repository that encloses
    // this machine's temp directory makes the no-repository case unreachable.
    noRepositoryReachable = await git(layouts["no-repository"], ["rev-parse", "--git-dir"])
      .then(() => false, () => true);
    for (const [layout, branch] of [["branch", "topic/probe"], ["detached", "main"]] as const) {
      const cwd = layouts[layout];
      await mkdir(cwd);
      await git(cwd, ["init", "-q", "-b", branch]);
      await git(cwd, ["-c", "user.name=Probe", "-c", "user.email=probe@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
    }
    await git(layouts.detached, ["checkout", "-q", "--detach"]);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Line-ending conversion and the trust list change neither discovery nor
  // the ref backend, so they must leave the probe able to answer.
  const neutralEntry = fc.oneof(
    fc.record({
      key: fc.constantFrom("core.autocrlf", "core.autoCRLF", "CORE.AUTOCRLF"),
      value: fc.constantFrom("true", "false", "input"),
    }),
    fc.record({
      key: fc.constantFrom("safe.directory", "Safe.Directory"),
      value: fc.constantFrom("*", "/nonexistent/trusted"),
    }),
  );

  it("answers as Git does whenever the environment holds only configuration that cannot change discovery or HEAD", async (context) => {
    if (!noRepositoryReachable) context.skip();
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("no-repository", "branch", "detached") as fc.Arbitrary<keyof typeof layouts>,
      fc.array(neutralEntry, { maxLength: 3 }),
      async (layout, entries) => {
        const cwd = layouts[layout];
        const expected = await gitAnswer(cwd, entries);
        Object.assign(process.env, gitEnvironment(entries));
        try {
          expect(await probeCurrentGitBranch(cwd)).toEqual(expected);
        } finally {
          for (const key of Object.keys(gitEnvironment(entries))) delete process.env[key];
        }
      },
    ), { numRuns: 25 });
  });

  it("proves no repository for a scratch folder under Playwright's core.autocrlf setting", async (context) => {
    if (!noRepositoryReachable) context.skip();
    const entries = [{ key: "core.autocrlf", value: "false" }];
    await expect(gitAnswer(layouts["no-repository"], entries)).resolves.toBe(NOT_A_GIT_REPOSITORY);
    Object.assign(process.env, gitEnvironment(entries));
    expect(await probeCurrentGitBranch(layouts["no-repository"])).toBe(NOT_A_GIT_REPOSITORY);
  });

  it("still leaves the answer to Git for configuration it does not recognize", async () => {
    for (const entries of [
      [{ key: "core.worktree", value: root }],
      [{ key: "include.path", value: path.join(root, "extra.config") }],
      [{ key: "core.autocrlf", value: "false" }, { key: "core.bare", value: "true" }],
    ]) {
      Object.assign(process.env, gitEnvironment(entries));
      try {
        expect(await probeCurrentGitBranch(layouts["no-repository"])).toBeUndefined();
        expect(await probeCurrentGitBranch(layouts.branch)).toBeUndefined();
      } finally {
        for (const key of Object.keys(gitEnvironment(entries))) delete process.env[key];
      }
    }
  });
});
