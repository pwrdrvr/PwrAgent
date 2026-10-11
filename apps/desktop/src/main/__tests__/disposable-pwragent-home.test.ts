// Pins the disposable-root redirects in `vitest.workspace.ts`.
//
// Without it, `resolvePwragentRoot` falls back to `~/.pwragent` and every test
// that touches a root-relative path reads and writes the operator's live
// application state — their `config.toml`, their `state.db`, their installed
// agent runtimes. Only about a dozen main tests override the root themselves,
// so the protection is a property of the config, not of the tests, and a
// one-line config edit could remove it silently. These assertions are what
// makes that edit fail.
//
// Two halves, and both are needed: the declared config value proves the
// redirect is still written down for each desktop project, and the runtime
// value proves it actually reached a forked worker.
//
// `XDG_CONFIG_HOME` / `XDG_STATE_HOME` are pinned the same way and for the
// same reason. Nothing in the app reads them today — the pre-profile
// migration that searched them for `pwragnt/` state is gone — so they are a
// guard against a future reader resolving into `~/.config` and
// `~/.local/state`. A guard nothing asserts on is one config edit from being
// dropped, which is the case this file exists for.
//
// `PATH` is sandboxed on every project, not just the desktop ones: the running
// Node first, then the repository's own pnpm bin directories, and no other
// entry inside the operator's home, where version-manager shims and personal
// bin directories live.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import workspaceConfig from "../../../../../vitest.workspace";
import { isPathWithin } from "../../shared/path-within";
import { PWRAGENT_HOME_ENV, resolvePwragentRoot } from "../profile";

const GUARDED_PROJECTS = [
  "desktop-main",
  "desktop-renderer",
  "desktop-renderer-node",
];
const PATH_SANDBOXED_PROJECTS = ["messaging", "shared", ...GUARDED_PROJECTS];
const POSIX_SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const GUARDED_ENV_VARS = [
  PWRAGENT_HOME_ENV,
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
];

type ConfiguredProject = {
  test?: { env?: Record<string, string>; name?: string };
};

describe("disposable PWRAGENT_HOME", () => {
  it("points this worker's PwrAgent root at a disposable directory", () => {
    const configured = process.env[PWRAGENT_HOME_ENV];

    expect(configured).toBeTruthy();
    expect(isDisposable(configured ?? "")).toBe(true);
  });

  it("keeps resolvePwragentRoot away from the operator's home", () => {
    const resolved = resolvePwragentRoot();

    expect(isDisposable(resolved)).toBe(true);
    expect(resolved).not.toBe(path.join(os.homedir(), ".pwragent"));
  });

  // A test that needs its own root still gets it: the seeded value is a
  // default, and both `vi.stubEnv` and an explicit `env` argument win over it.
  it("stays overridable by a test that brings its own root", () => {
    const ownRoot = path.join(os.tmpdir(), "pwragent-own-root");

    expect(resolvePwragentRoot({ env: { [PWRAGENT_HOME_ENV]: ownRoot } })).toBe(
      ownRoot,
    );
  });

  it.each(GUARDED_PROJECTS)(
    "declares disposable roots for the %s project",
    (name) => {
      const project = findProject(name);

      for (const variable of GUARDED_ENV_VARS) {
        expect(project?.test?.env?.[variable]).toBeTruthy();
        expect(isDisposable(project?.test?.env?.[variable] ?? "")).toBe(true);
      }
    },
  );

  it.each(["XDG_CONFIG_HOME", "XDG_STATE_HOME"])(
    "points this worker's %s at a disposable directory",
    (variable) => {
      expect(isDisposable(process.env[variable] ?? "")).toBe(true);
    },
  );
});

describe("sandboxed PATH", () => {
  it("resolves this worker's executables from the running Node and outside the operator's home", () => {
    expectSandboxedPath(process.env.PATH ?? "");
  });

  it.each(PATH_SANDBOXED_PROJECTS)(
    "declares a sandboxed PATH for the %s project",
    (name) => {
      const env = findProject(name)?.test?.env ?? {};
      const key = Object.keys(env).find((variable) => variable.toUpperCase() === "PATH");

      expect(key).toBeDefined();
      expectSandboxedPath(env[key ?? ""] ?? "");
    },
  );
});

function expectSandboxedPath(searchPath: string): void {
  const nodeDirectory = path.dirname(process.execPath);
  const [first, ...rest] = searchPath.split(path.delimiter);
  const outsideRepository = rest.filter((entry) => !isAtOrWithin(REPOSITORY_ROOT, entry));

  expect(first).toBe(nodeDirectory);
  expect(outsideRepository.filter((entry) => isAtOrWithin(os.homedir(), entry))).toEqual([]);
  if (process.platform !== "win32") {
    expect(outsideRepository).toEqual(POSIX_SYSTEM_PATH.filter((entry) => entry !== nodeDirectory));
  }
}

/** The config's own containment rule: the root counts, and Windows ignores case. */
function isAtOrWithin(root: string, entry: string): boolean {
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const resolvedRoot = fold(path.resolve(root));
  const resolvedEntry = fold(path.resolve(entry));
  return resolvedEntry === resolvedRoot || isPathWithin(resolvedRoot, resolvedEntry);
}

function findProject(name: string): ConfiguredProject | undefined {
  const projects = (workspaceConfig.test?.projects ?? []) as unknown[];
  return projects.find(
    (project): project is ConfiguredProject =>
      typeof project === "object"
      && project !== null
      && (project as ConfiguredProject).test?.name === name,
  );
}

/**
 * Disposable means "under the OS temp dir". No realpath dance is needed here,
 * unlike in the spawn guard: both the declared and the runtime value are built
 * from `os.tmpdir()` in this same process, so they share its spelling.
 */
function isDisposable(target: string): boolean {
  return target.length > 0 && isPathWithin(os.tmpdir(), path.resolve(target));
}
