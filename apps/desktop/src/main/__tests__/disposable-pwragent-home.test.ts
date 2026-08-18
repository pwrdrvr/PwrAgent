// Pins the `PWRAGENT_HOME` redirect in `vitest.workspace.ts`.
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
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import workspaceConfig from "../../../../../vitest.workspace";
import { isPathWithin } from "../../shared/path-within";
import { PWRAGENT_HOME_ENV, resolvePwragentRoot } from "../profile";

const GUARDED_PROJECTS = ["desktop-main", "desktop-renderer"];

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
    "declares a disposable root for the %s project",
    (name) => {
      const project = findProject(name);

      expect(project?.test?.env?.[PWRAGENT_HOME_ENV]).toBeTruthy();
      expect(isDisposable(project?.test?.env?.[PWRAGENT_HOME_ENV] ?? "")).toBe(
        true,
      );
    },
  );
});

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
