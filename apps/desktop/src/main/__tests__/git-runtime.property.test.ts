import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureBundledGit, isPwrAgentGitPath } from "../bundled-git";
import { customGitEnvironment } from "../git-runtime";

const fixture = process.platform === "win32" ? "C:\\git-env-fixture" : "/git-env-fixture";
const resources = path.join(fixture, "Resources");
const agentRoot = path.join(fixture, "pwragent");
const installed = path.join(fixture, "installed", process.platform === "win32" ? "git.exe" : "git");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  configureBundledGit(undefined);
});

describe("installed Git PATH filtering", () => {
  const pathEntry = fc.constantFrom(
    "",
    path.dirname(installed),
    path.join(fixture, "another", "bin"),
    path.join(resources, "git"),
    path.join(resources, "git", "bin"),
    path.join(resources, "git-other", "bin"),
    path.join(agentRoot, "runtimes", "git", "versions", "selected", "bin"),
    path.join("relative", "bin"),
    process.platform === "win32" ? "\\rooted\\bin" : "../bin",
  );
  const launch = fc.record({
    pathEntries: fc.array(pathEntry, { maxLength: 12 }),
    pathKey: fc.constantFrom("PATH", "Path", "pAtH"),
    command: fc.constantFrom(installed, path.join(fixture, "other-install", "git"), "git"),
    switchBundle: fc.boolean(),
    switchAgentRoot: fc.boolean(),
    marker: fc.string(),
  });

  it("preserves the original environment transformation across launches and root changes", () => {
    fc.assert(fc.property(fc.array(launch, { minLength: 2, maxLength: 12 }), (launches) => {
      for (const { pathEntries, pathKey, command, switchBundle, switchAgentRoot, marker } of launches) {
        configureBundledGit(switchBundle ? path.join(fixture, "OtherResources") : resources);
        vi.stubEnv("PWRAGENT_HOME", switchAgentRoot ? path.join(fixture, "other-pwragent") : agentRoot);
        const inheritedPath = pathEntries.join(path.delimiter);
        const source = {
          ...(pathKey === "PATH" ? {} : { PATH: path.join(fixture, "first-path") }),
          [pathKey]: inheritedPath,
          GiT_ExEc_PaTh: "inherited helper",
          PREFIX: path.join(resources, "git"),
          GIT_SSL_CAINFO: path.join(fixture, "operator.pem"),
          GIT_ASKPASS: marker,
        };
        // The original filter resolves each entry on every call. It keeps the
        // last PATH casing, puts the selected Git first, and dedupes in order.
        const expectedPath = [...new Set([
          ...(path.isAbsolute(command) ? [path.dirname(command)] : []),
          ...inheritedPath.split(path.delimiter).filter((entry) => entry && !isPwrAgentGitPath(entry)),
        ])].join(path.delimiter);
        const expected = {
          GIT_SSL_CAINFO: source.GIT_SSL_CAINFO,
          GIT_ASKPASS: marker,
          ...(!isPwrAgentGitPath(source.PREFIX) ? { PREFIX: source.PREFIX } : {}),
          PATH: expectedPath,
        };
        expect(customGitEnvironment(source, command)).toEqual(expected);
        expect(customGitEnvironment({ ...source, GIT_ASKPASS: "updated" }, command))
          .toEqual({ ...expected, GIT_ASKPASS: "updated" });
      }
    }));
  });

  it("checks containment once for consecutive launches with the same absolute PATH inputs", () => {
    configureBundledGit(resources);
    vi.stubEnv("PWRAGENT_HOME", agentRoot);
    const source = {
      PATH: [path.join(resources, "git", "bin"), path.join(agentRoot, "bin")].join(path.delimiter),
    };
    const relative = vi.spyOn(path, "relative");
    const first = customGitEnvironment(source, installed);
    expect(relative.mock.calls.length).toBeGreaterThan(0);
    relative.mockClear();
    for (let launch = 0; launch < 8; launch++) {
      expect(customGitEnvironment({ ...source, GIT_OPTIONAL_LOCKS: String(launch) }, installed))
        .toEqual({ ...first, GIT_OPTIONAL_LOCKS: String(launch) });
    }
    expect(relative).not.toHaveBeenCalled();
  });

  it("rechecks unchanged PATH entries when either runtime root moves", () => {
    configureBundledGit(resources);
    vi.stubEnv("PWRAGENT_HOME", agentRoot);
    const bundledBin = path.join(resources, "git", "bin");
    const managedBin = path.join(agentRoot, "runtimes", "git", "versions", "selected", "bin");
    const source = { PATH: [bundledBin, managedBin].join(path.delimiter) };
    const commandDirectory = path.dirname(installed);
    expect(customGitEnvironment(source, installed).PATH).toBe(commandDirectory);

    configureBundledGit(path.join(fixture, "OtherResources"));
    expect(customGitEnvironment(source, installed).PATH)
      .toBe([commandDirectory, bundledBin].join(path.delimiter));

    vi.stubEnv("PWRAGENT_HOME", path.join(fixture, "other-pwragent"));
    expect(customGitEnvironment(source, installed).PATH)
      .toBe([commandDirectory, bundledBin, managedBin].join(path.delimiter));
  });

  it("reads a rewritten generated system config even when PATH is reused", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "git-env-config-"));
    try {
      configureBundledGit(resources);
      vi.stubEnv("PWRAGENT_HOME", directory);
      const generated = path.join(directory, "generated.gitconfig");
      const source = { PATH: path.dirname(installed), GIT_CONFIG_SYSTEM: generated };
      for (const included of ["first.gitconfig", "second.gitconfig"]) {
        writeFileSync(generated, `# Written by PwrGit: generated\n[include]\n\tpath = ${included}\n`);
        expect(customGitEnvironment(source, installed).GIT_CONFIG_SYSTEM).toBe(path.join(directory, included));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves relative PATH entries against the current working directory", () => {
    configureBundledGit(resources);
    vi.stubEnv("PWRAGENT_HOME", agentRoot);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(resources);
    const source = { PATH: path.join("git", "bin") };
    expect(customGitEnvironment(source, installed).PATH).toBe(path.dirname(installed));
    cwd.mockReturnValue(fixture);
    expect(customGitEnvironment(source, installed).PATH)
      .toBe([path.dirname(installed), source.PATH].join(path.delimiter));
  });

  it.skipIf(process.platform !== "win32")("resolves drive-rooted PATH entries against the current drive", () => {
    configureBundledGit(resources);
    vi.stubEnv("PWRAGENT_HOME", agentRoot);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("C:\\");
    const source = { PATH: "\\git-env-fixture\\Resources\\git\\bin" };
    expect(customGitEnvironment(source, installed).PATH).toBe(path.dirname(installed));
    cwd.mockReturnValue("D:\\");
    expect(customGitEnvironment(source, installed).PATH)
      .toBe([path.dirname(installed), source.PATH].join(path.delimiter));
  });
});
