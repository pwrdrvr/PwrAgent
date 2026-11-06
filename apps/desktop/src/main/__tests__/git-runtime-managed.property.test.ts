import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

// Which Git a PwrAgent command runs. The model: PWRAGENT_GIT_PATH, then the
// manual path, then the downloaded release chosen with Use, then the bundle.
// A chosen release that fails its checks is an error, never another Git.

const managedRoots = vi.hoisted(() => new Map<string, string | Error>());

vi.mock("../managed-git-runtime", () => ({
  resolveManagedGitRuntime: (generation: string) => {
    const entry = managedRoots.get(generation);
    if (entry === undefined || entry instanceof Error) {
      throw entry ?? new Error(`PwrDrvr Git ${generation} cannot be used: it is not installed.`);
    }
    return { root: entry, executable: path.join(entry, "bin", "git") };
  },
}));

vi.mock("../bundled-git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bundled-git")>()),
  bundledGitDirectory: () => "/app/Resources/git",
  bundledGitExecutable: () => "/app/Resources/git/bin/git",
  validateBundledGit: async () => "/app/Resources/git/bin/git",
}));

const { managedGitRoot } = await import("../managed-git-paths");
const { setGitCommandResolver, setManagedGitSelectionResolver } = await import("../git-command");
const { gitRuntimeEnvironment, resolveRuntimeGitExecutable } = await import("../git-runtime");

afterEach(() => {
  setGitCommandResolver(undefined);
  setManagedGitSelectionResolver(undefined);
  managedRoots.clear();
});

const scenario = fc.record({
  env: fc.option(fc.constant("/env/bin/git"), { nil: undefined }),
  manual: fc.option(fc.constant("/manual/bin/git"), { nil: undefined }),
  managed: fc.option(fc.constantFrom("2.56.0-dev-pwrgit.5-aaaaaaa", "2.56.0-dev-pwrgit.6-bbbbbbb"), { nil: undefined }),
  healthy: fc.boolean(),
});

describe("Git precedence with downloaded releases", () => {
  // No PwrDrvr Git runtime exists for Windows, and the model's paths are POSIX.
  it.skipIf(process.platform === "win32")("runs exactly the Git the model picks, and fails rather than switching for a rejected release", async () => {
    await fc.assert(fc.asyncProperty(scenario, async ({ env, manual, managed, healthy }) => {
      managedRoots.clear();
      if (managed) {
        managedRoots.set(managed, healthy ? `/pwragent/runtimes/git/versions/${managed}/linux-x64` : new Error("failed verification"));
      }
      setGitCommandResolver(() => manual);
      setManagedGitSelectionResolver(() => managed);
      const source: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", ...(env ? { PWRAGENT_GIT_PATH: env } : {}) };
      const expected = env ?? manual
        ?? (managed ? (healthy ? `/pwragent/runtimes/git/versions/${managed}/linux-x64/bin/git` : "error") : "/app/Resources/git/bin/git");
      if (expected === "error") {
        await expect(resolveRuntimeGitExecutable(source)).rejects.toThrow(/failed verification/);
      } else {
        await expect(resolveRuntimeGitExecutable(source)).resolves.toBe(expected);
      }
      // A shell or helper PwrAgent starts finds the same Git first on PATH,
      // and only PwrAgent's own Git gets PwrAgent's helper directory.
      const runtimeEnv = gitRuntimeEnvironment(source);
      const first = runtimeEnv.PATH?.split(path.delimiter)[0];
      if (expected === "error") {
        expect(runtimeEnv.GIT_EXEC_PATH).toBeUndefined();
        expect(runtimeEnv.PATH).toBe("/usr/bin:/bin");
      } else if (env || manual) {
        expect(first).toBe(path.dirname(expected));
        expect(runtimeEnv.GIT_EXEC_PATH).toBeUndefined();
      } else if (managed) {
        expect(first).toBe(path.dirname(expected));
        expect(runtimeEnv.GIT_EXEC_PATH).toBe(path.join(path.dirname(path.dirname(expected)), "libexec", "git-core"));
      } else {
        expect(runtimeEnv.GIT_EXEC_PATH).toBeDefined();
        expect(runtimeEnv.GIT_EXEC_PATH).not.toContain("/pwragent/runtimes/git/");
      }
    }), { numRuns: 80 });
  });

  it.skipIf(process.platform === "win32")("gives a chosen release its own helpers, templates and CA bundle", () => {
    const root = path.join(managedGitRoot(), "versions", "2.56.0-dev-pwrgit.5-aaaaaaa", "linux-x64");
    const staleCa = path.join(managedGitRoot(), "versions", "2.56.0-dev-pwrgit.4-0000000", "linux-x64", "ssl", "cacert.pem");
    managedRoots.set("2.56.0-dev-pwrgit.5-aaaaaaa", root);
    setManagedGitSelectionResolver(() => "2.56.0-dev-pwrgit.5-aaaaaaa");
    const env = gitRuntimeEnvironment({
      PATH: `/app/Resources/git/bin:/usr/bin`,
      GIT_EXEC_PATH: "/somewhere/else",
      GIT_SSL_CAINFO: staleCa,
    });
    expect(env.GIT_EXEC_PATH).toBe(path.join(root, "libexec", "git-core"));
    expect(env.GIT_TEMPLATE_DIR).toBe(`${root}/share/git-core/templates`);
    expect(env.PATH?.split(path.delimiter).slice(0, 2)).toEqual([path.join(root, "bin"), path.join(root, "libexec", "git-core")]);
    // Another release's CA path, inherited from a shell, is never kept.
    expect(env.GIT_SSL_CAINFO).not.toBe(staleCa);
  });

  it("gives a shell no PwrAgent Git when the chosen release was rejected", () => {
    managedRoots.set("2.56.0-dev-pwrgit.5-aaaaaaa", new Error("failed verification"));
    setManagedGitSelectionResolver(() => "2.56.0-dev-pwrgit.5-aaaaaaa");
    const env = gitRuntimeEnvironment({ PATH: "/usr/bin:/bin" });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.GIT_EXEC_PATH).toBeUndefined();
  });
});
