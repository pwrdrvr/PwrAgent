import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lock } from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelManagedGitInstall,
  checkManagedGitReleases,
  forgetManagedGitResolution,
  installManagedGit,
  listManagedGitGenerations,
  ManagedGitBusyError,
  ManagedGitUnavailableError,
  onManagedGitVerificationFailed,
  pruneManagedGitGenerations,
  readManagedGitCheck,
  removeManagedGitGeneration,
  removeManagedGitInUseMarkers,
  resolveManagedGitRuntime,
  setManagedGitBackgroundVerifyDelay,
  verifyManagedGitGeneration,
  type ManagedGitOptions,
} from "../managed-git-runtime";
import type { ManagedRuntimeProgressReporter } from "../managed-runtime-progress";
import {
  buildRelease,
  fakeGithub,
  FIXTURE_BUNDLED_VERSION,
  FIXTURE_CONSUMER,
  githubRelease,
  makeRoot,
  type FakeGithub,
} from "./helpers/managed-git-fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  setManagedGitBackgroundVerifyDelay(20_000);
});

function recorder(): ManagedRuntimeProgressReporter & { phases: string[] } {
  const phases: string[] = [];
  return {
    phases,
    checking: () => void phases.push("checking"),
    downloading: () => {
      phases.push("downloading");
      return () => undefined;
    },
    verifying: () => void phases.push("verifying"),
    unpacking: () => void phases.push("unpacking"),
    activating: () => void phases.push("activating"),
    ready: () => void phases.push("ready"),
    idle: () => void phases.push("idle"),
    failed: () => void phases.push("failed"),
  };
}

function setup(gh: FakeGithub) {
  const rootDir = makeRoot();
  roots.push(rootDir);
  const progress = recorder();
  const options: ManagedGitOptions = {
    rootDir,
    platform: "linux",
    arch: "x64",
    consumerSha256: FIXTURE_CONSUMER,
    bundledVersion: FIXTURE_BUNDLED_VERSION,
    fetch: gh.fetch,
    fetchReleases: gh.fetchReleases,
    verify: { probe: false, requireSigned: false },
    progress,
  };
  return { rootDir, options, progress };
}

/** Everything left under the root that is not a finished install. */
function leftovers(rootDir: string): string[] {
  const found: string[] = [];
  for (const dir of ["versions", "archives"]) {
    try {
      for (const name of readdirSync(path.join(rootDir, dir))) {
        if (name.startsWith(".")) found.push(`${dir}/${name}`);
      }
    } catch {
      // Not created.
    }
  }
  return found;
}

// No PwrDrvr Git runtime ships for Windows, which keeps Dugite's MinGit; the
// fixtures build POSIX tar archives with modes and symlinks.
const posixDescribe = describe.skipIf(process.platform === "win32");

posixDescribe("downloading a PwrDrvr Git release", () => {
  it("installs the newest release into its own immutable directory, unchanged", async () => {
    const r5 = buildRelease("2.56.0-dev-pwrgit.5");
    const r6 = buildRelease("2.56.0-dev-pwrgit.6");
    const gh = fakeGithub([r5, r6]);
    const { rootDir, options, progress } = setup(gh);
    const check = await checkManagedGitReleases({ ...options, manual: true });
    expect(check?.tracks.prerelease.available?.version).toBe("2.56.0-dev-pwrgit.6");
    const installed = await installManagedGit({ ...options, tag: r6.tag });
    expect(installed.generation).toBe(`2.56.0-dev-pwrgit.6-${r6.revision.slice(0, 7)}`);
    expect(installed.root).toBe(path.join(rootDir, "versions", installed.generation, "linux-x64"));
    expect(progress.phases).toEqual(["checking", "downloading", "verifying", "unpacking", "activating", "ready"]);
    // The installed bytes are exactly the sealed release.
    await expect(verifyManagedGitGeneration(installed.generation, options)).resolves.toMatchObject({ version: "2.56.0-dev-pwrgit.6" });
    expect((await listManagedGitGenerations(options)).map((g) => g.version)).toEqual(["2.56.0-dev-pwrgit.6"]);
    expect(leftovers(rootDir)).toEqual([]);
  });

  it("rejects an archive whose bytes differ from the published checksum, leaving nothing behind", async () => {
    const bad = buildRelease("2.56.0-dev-pwrgit.5", {
      mutate: { archive: (bytes) => Buffer.concat([bytes.subarray(0, -1), Buffer.from([bytes.at(-1)! ^ 1])]) },
    });
    const gh = fakeGithub([bad], [githubRelease(bad, { digests: { [bad.archiveName]: null } })]);
    const { rootDir, options, progress } = setup(gh);
    await expect(installManagedGit({ ...options, tag: bad.tag })).rejects.toThrow(/Checksum mismatch/);
    expect(await listManagedGitGenerations(options)).toEqual([]);
    expect(leftovers(rootDir)).toEqual([]);
    expect(readdirSync(path.join(rootDir, "archives"))).toEqual([]);
    expect(progress.phases.at(-1)).toBe("failed");
  });

  it("rejects a release whose GitHub digest disagrees with SHA256SUMS, and accepts one with no digest", async () => {
    const release = buildRelease("2.56.0-dev-pwrgit.5");
    const disagree = fakeGithub([release], [githubRelease(release, { digests: { [release.archiveName]: "0".repeat(64) } })]);
    const a = setup(disagree);
    const check = await checkManagedGitReleases({ ...a.options, manual: true });
    expect(check?.tracks.prerelease.available).toBeUndefined();
    expect(check?.tracks.prerelease.error).toMatch(/digest and SHA256SUMS disagree/);
    await expect(installManagedGit({ ...a.options, tag: release.tag })).rejects.toThrow(/disagree/);

    const missing = fakeGithub([release], [githubRelease(release, { digests: { [release.archiveName]: null, "runtime-manifest.json": null } })]);
    const b = setup(missing);
    await expect(installManagedGit({ ...b.options, tag: release.tag })).resolves.toMatchObject({ version: "2.56.0-dev-pwrgit.5" });
  });

  it("offers the newest release this build can verify and names the one that needs a newer PwrAgent", async () => {
    const newer = buildRelease("2.56.0-dev-pwrgit.6", { consumer: "e".repeat(64) });
    const usable = buildRelease("2.56.0-dev-pwrgit.5");
    const { options } = setup(fakeGithub([newer, usable]));
    const check = await checkManagedGitReleases({ ...options, manual: true });
    expect(check?.tracks.prerelease.needsAppUpdate).toEqual({ version: "2.56.0-dev-pwrgit.6" });
    expect(check?.tracks.prerelease.available?.version).toBe("2.56.0-dev-pwrgit.5");
    await expect(installManagedGit({ ...options, tag: newer.tag })).rejects.toThrow(/needs a newer PwrAgent/);
  });

  it("rejects a catalog that names a different version than its release", async () => {
    const release = buildRelease("2.56.0-dev-pwrgit.6", { mutate: { catalog: (c) => { c.version = "2.56.0-dev-pwrgit.5"; } } });
    const { options } = setup(fakeGithub([release]));
    const check = await checkManagedGitReleases({ ...options, manual: true });
    expect(check?.tracks.prerelease.available).toBeUndefined();
  });

  it("refuses an archive with an absolute member before extracting anything", async () => {
    const outside = path.join(makeRoot("pwragent-outside-"), "planted");
    roots.push(path.dirname(outside));
    writeFileSync(outside, "original");
    const release = buildRelease("2.56.0-dev-pwrgit.5", { mutate: { absoluteMembers: () => [outside] } });
    writeFileSync(outside, "untouched");
    const { rootDir, options } = setup(fakeGithub([release]));
    await expect(installManagedGit({ ...options, tag: release.tag })).rejects.toThrow(/Unsafe path/);
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(leftovers(rootDir)).toEqual([]);
  });

  it("rejects a payload changed after the release was sealed", async () => {
    const release = buildRelease("2.56.0-dev-pwrgit.5", {
      mutate: { afterSeal: (root) => writeFileSync(path.join(root, "bin", "git"), "#!/bin/sh\necho evil\n") },
    });
    const { rootDir, options } = setup(fakeGithub([release]));
    await expect(installManagedGit({ ...options, tag: release.tag })).rejects.toThrow(/changed after the release was sealed: bin\/git/);
    expect(await listManagedGitGenerations(options)).toEqual([]);
    expect(leftovers(rootDir)).toEqual([]);
  });

  it("reinstalls offline from the verified release files and cached archive, downloading nothing", async () => {
    const release = buildRelease("2.56.0-dev-pwrgit.5");
    const gh = fakeGithub([release]);
    const { options } = setup(gh);
    const first = await installManagedGit({ ...options, tag: release.tag });
    await removeManagedGitGeneration(first.generation, new Set(), options);
    gh.offline = true;
    gh.calls.length = 0;
    const again = await installManagedGit({ ...options, tag: release.tag });
    expect(again.generation).toBe(first.generation);
    expect(gh.calls.filter((url) => url.endsWith(".tar.gz"))).toEqual([]);
  });

  it("does not reuse a cached archive whose bytes changed", async () => {
    const release = buildRelease("2.56.0-dev-pwrgit.5");
    const gh = fakeGithub([release]);
    const { rootDir, options } = setup(gh);
    const first = await installManagedGit({ ...options, tag: release.tag });
    await removeManagedGitGeneration(first.generation, new Set(), options);
    const [cached] = readdirSync(path.join(rootDir, "archives"));
    writeFileSync(path.join(rootDir, "archives", cached), "corrupt");
    gh.calls.length = 0;
    await installManagedGit({ ...options, tag: release.tag });
    expect(gh.calls.filter((url) => url.endsWith(".tar.gz"))).toHaveLength(1);
  });
});

posixDescribe("build tracks", () => {
  const FLAGS = [true, false, undefined, "false"] as const;
  let pool: ReturnType<typeof buildRelease>[] | undefined;
  const releases = () => (pool ??= ["5", "6", "7", "8"].map((n) => buildRelease(`2.56.0-dev-pwrgit.${n}`)));
  const listed = (flags: readonly unknown[]) =>
    releases().map((release, index) => githubRelease(release, { prerelease: flags[index] }));
  const sumsFetched = (gh: FakeGithub) =>
    gh.calls.filter((url) => url.endsWith("/SHA256SUMS")).map((url) => /dev-pwrgit\.(\d+)\//u.exec(url)?.[1]).sort();

  it("answers both tracks in one check, and reads only the releases a track still needs", async () => {
    // Oracle: Prerelease is the newest release, Latest the newest whose flag
    // is exactly false. Every assignment of four flags to four releases.
    for (let mask = 0; mask < FLAGS.length ** 4; mask += 1) {
      const flags = [0, 1, 2, 3].map((index) => FLAGS[Math.floor(mask / FLAGS.length ** index) % FLAGS.length]);
      const gh = fakeGithub(releases(), listed(flags));
      const { options } = setup(gh);
      const check = await checkManagedGitReleases({ ...options, manual: true });
      const versions = releases().map((release) => release.tag.slice(1));
      const promoted = versions.filter((_, index) => flags[index] === false);
      const newestPromoted = promoted.at(-1);
      const label = JSON.stringify(flags);
      expect(check?.tracks.prerelease.available?.version, label).toBe(versions.at(-1));
      expect(check?.tracks.latest.available?.version, label).toBe(newestPromoted);
      expect(check?.tracks.latest.error, label).toBeUndefined();
      // Never an older prerelease while looking for a promoted build.
      const expected = [...new Set([versions.at(-1), newestPromoted].filter(Boolean))]
        .map((version) => version!.split(".").at(-1))
        .sort();
      expect(sumsFetched(gh), label).toEqual(expected);
    }
  });

  it("offers nothing on Latest while every release is a prerelease, and says no error", async () => {
    const gh = fakeGithub(releases());
    const { options } = setup(gh);
    const check = await checkManagedGitReleases({ ...options, manual: true });
    expect(check?.tracks.latest).toEqual({});
    expect(check?.tracks.prerelease.available?.version).toBe("2.56.0-dev-pwrgit.8");
    expect(check?.error).toBeUndefined();
  });

  it("keeps needs-a-newer-PwrAgent on the track it belongs to", async () => {
    const newer = buildRelease("2.56.0-dev-pwrgit.6", { consumer: "e".repeat(64) });
    const usable = buildRelease("2.56.0-dev-pwrgit.5");
    const { options } = setup(fakeGithub([newer, usable], [
      githubRelease(newer, { prerelease: true }),
      githubRelease(usable, { prerelease: false }),
    ]));
    const check = await checkManagedGitReleases({ ...options, manual: true });
    expect(check?.tracks.latest).toMatchObject({ available: { version: "2.56.0-dev-pwrgit.5" } });
    expect(check?.tracks.latest.needsAppUpdate).toBeUndefined();
    expect(check?.tracks.prerelease).toMatchObject({
      available: { version: "2.56.0-dev-pwrgit.5" },
      needsAppUpdate: { version: "2.56.0-dev-pwrgit.6" },
    });
  });

  it("drops a check saved before tracks existed", async () => {
    const { rootDir, options } = setup(fakeGithub(releases()));
    await checkManagedGitReleases({ ...options, manual: true });
    const file = path.join(rootDir, "managed-release.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const { tracks, ...rest } = saved as { tracks: { prerelease: { available: unknown } } };
    writeFileSync(file, JSON.stringify({ ...rest, schemaVersion: 1, available: tracks.prerelease.available }));
    await expect(readManagedGitCheck(options)).resolves.toBeUndefined();
    // The next check refills it.
    await checkManagedGitReleases({ ...options, manual: true });
    await expect(readManagedGitCheck(options)).resolves.toMatchObject({ schemaVersion: 2 });
  });
});

posixDescribe("cancelling and concurrent installs", () => {
  async function untilDownloading(progress: { phases: string[] }): Promise<void> {
    for (let i = 0; i < 200 && !progress.phases.includes("downloading"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("cancels a download, removes its partial file, and leaves the next install working", async () => {
    const release = buildRelease("2.56.0-dev-pwrgit.5");
    const gh = fakeGithub([release]);
    gh.stallArchives = true;
    const { rootDir, options, progress } = setup(gh);
    const running = installManagedGit({ ...options, tag: release.tag });
    await untilDownloading(progress);
    expect(cancelManagedGitInstall(options)).toBe(true);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(progress.phases.at(-1)).toBe("idle");
    expect(leftovers(rootDir)).toEqual([]);
    expect(await listManagedGitGenerations(options)).toEqual([]);
    gh.stallArchives = false;
    await expect(installManagedGit({ ...options, tag: release.tag })).resolves.toBeDefined();
  });

  it("joins a second request for the same release and refuses a different one while it runs", async () => {
    const r5 = buildRelease("2.56.0-dev-pwrgit.5");
    const r6 = buildRelease("2.56.0-dev-pwrgit.6");
    const gh = fakeGithub([r5, r6]);
    const { options } = setup(gh);
    const [a, b] = await Promise.all([
      installManagedGit({ ...options, tag: r5.tag }),
      installManagedGit({ ...options, tag: r5.tag }),
    ]);
    expect(a.generation).toBe(b.generation);
    expect(gh.calls.filter((url) => url.endsWith(r5.archiveName))).toHaveLength(1);

    gh.stallArchives = true;
    const running = installManagedGit({ ...options, tag: r6.tag });
    await expect(installManagedGit({ ...options, tag: r5.tag })).rejects.toBeInstanceOf(ManagedGitBusyError);
    cancelManagedGitInstall(options);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses a tag that is not a PwrDrvr Git release before reading anything", async () => {
    const { rootDir, options } = setup(fakeGithub([buildRelease("2.56.0-dev-pwrgit.5")]));
    let asked = false;
    const guarded: ManagedGitOptions = {
      ...options,
      fetchReleases: async () => {
        asked = true;
        throw new Error("offline");
      },
    };
    for (const tag of ["../../escape", "v2.56.0-dev-pwrgit.5/../../x", "2.56.0-dev-pwrgit.5", ""]) {
      await expect(installManagedGit({ ...guarded, tag })).rejects.toThrow(/Not a PwrDrvr Git release/);
    }
    expect(asked).toBe(false);
    expect(existsSync(path.join(rootDir, "releases"))).toBe(false);
  });

  it("refuses while another process holds the install lock", async () => {
    const release = buildRelease("2.56.0-dev-pwrgit.5");
    const { rootDir, options } = setup(fakeGithub([release]));
    const release_ = await lock(path.join(rootDir, "install"), { realpath: false });
    try {
      await expect(installManagedGit({ ...options, tag: release.tag })).rejects.toBeInstanceOf(ManagedGitBusyError);
    } finally {
      await release_();
    }
    await expect(installManagedGit({ ...options, tag: release.tag })).resolves.toBeDefined();
  });
});

posixDescribe("running a chosen release", () => {
  it("resolves the payload root, and fails closed once its sealed list changes", async () => {
    const release = buildRelease("2.56.0-dev-pwrgit.5");
    const { options } = setup(fakeGithub([release]));
    const installed = await installManagedGit({ ...options, tag: release.tag });
    expect(resolveManagedGitRuntime(installed.generation, options)).toEqual({
      root: installed.root,
      executable: path.join(installed.root, "bin", "git"),
    });
    forgetManagedGitResolution(installed.generation);
    writeFileSync(path.join(installed.root, "runtime-files.json"), "{}");
    expect(() => resolveManagedGitRuntime(installed.generation, options)).toThrow(ManagedGitUnavailableError);
    // Remembered: every later command fails the same way, never another Git.
    expect(() => resolveManagedGitRuntime(installed.generation, options)).toThrow(/sealed file list changed/);
    forgetManagedGitResolution(installed.generation);
  });

  it("re-verifies in the background and stops using a release whose files changed", async () => {
    setManagedGitBackgroundVerifyDelay(0);
    const release = buildRelease("2.56.0-dev-pwrgit.5");
    const { options } = setup(fakeGithub([release]));
    const installed = await installManagedGit({ ...options, tag: release.tag });
    forgetManagedGitResolution(installed.generation);
    const rejected = new Promise<string>((resolve) => {
      const stop = onManagedGitVerificationFailed((generation, error) => {
        stop();
        resolve(`${generation}: ${error.message}`);
      });
    });
    // The cheap first check passes; only the full one hashes every file.
    writeFileSync(path.join(installed.root, "bin", "git"), "#!/bin/sh\necho changed\n");
    expect(resolveManagedGitRuntime(installed.generation, options).root).toBe(installed.root);
    expect(await rejected).toMatch(/bin\/git/);
    expect(() => resolveManagedGitRuntime(installed.generation, options)).toThrow(ManagedGitUnavailableError);
    forgetManagedGitResolution(installed.generation);
  });

  it("removes this process's in-use marker on exit, so a reused PID cannot pin the release", async () => {
    const release = buildRelease("2.56.0-dev-pwrgit.5");
    const { options } = setup(fakeGithub([release]));
    const installed = await installManagedGit({ ...options, tag: release.tag });
    forgetManagedGitResolution(installed.generation);
    resolveManagedGitRuntime(installed.generation, options);
    const marker = path.join(path.dirname(installed.root), `.pwragent-use-${process.pid}`);
    expect(existsSync(marker)).toBe(true);
    removeManagedGitInUseMarkers();
    expect(existsSync(marker)).toBe(false);
    forgetManagedGitResolution(installed.generation);
  });

  it("is unavailable when the release is not installed", () => {
    const { options } = setup(fakeGithub([]));
    expect(() => resolveManagedGitRuntime("2.56.0-dev-pwrgit.7-abcdef0", options)).toThrow(/not installed/);
    forgetManagedGitResolution();
  });
});

posixDescribe("pruning and removal", () => {
  it("keeps the newest release, every release a profile names, and every release a live process ran", async () => {
    const releases = ["5", "6", "7", "8"].map((n) => buildRelease(`2.56.0-dev-pwrgit.${n}`));
    const { rootDir, options } = setup(fakeGithub(releases));
    const installed = [];
    for (const release of releases) installed.push(await installManagedGit({ ...options, tag: release.tag }));
    const [g5, g6, g7, g8] = installed.map((entry) => entry.generation);
    const livePid = process.pid + 100_000;
    writeFileSync(path.join(rootDir, "versions", g6, `.pwragent-use-${livePid}`), "");
    const removed = await pruneManagedGitGenerations(new Set([g5]), {
      ...options,
      isProcessAlive: (pid) => pid === livePid,
    });
    expect(removed).toEqual([g7]);
    expect((await listManagedGitGenerations(options)).map((g) => g.generation).sort()).toEqual([g5, g6, g8].sort());
    // The removed release's archive went with it.
    expect(readdirSync(path.join(rootDir, "archives"))).toHaveLength(3);
  });

  it("never prunes or removes while another window holds the install lock", async () => {
    const releases = ["5", "6"].map((n) => buildRelease(`2.56.0-dev-pwrgit.${n}`));
    const { rootDir, options } = setup(fakeGithub(releases));
    const installed = [];
    for (const release of releases) installed.push(await installManagedGit({ ...options, tag: release.tag }));
    const older = installed[0]!.generation;
    const unlock = await lock(path.join(rootDir, "install"), { realpath: false });
    try {
      await expect(pruneManagedGitGenerations(new Set(), options)).resolves.toEqual([]);
      await expect(removeManagedGitGeneration(older, new Set(), options)).rejects.toBeInstanceOf(ManagedGitBusyError);
      expect(existsSync(path.join(rootDir, "versions", older))).toBe(true);
    } finally {
      await unlock();
    }
    await expect(pruneManagedGitGenerations(new Set(), options)).resolves.toEqual([older]);
  });

  it("refuses to remove a release a profile still names or another process runs", async () => {
    const release = buildRelease("2.56.0-dev-pwrgit.5");
    const { rootDir, options } = setup(fakeGithub([release]));
    const { generation } = await installManagedGit({ ...options, tag: release.tag });
    await expect(removeManagedGitGeneration(generation, new Set([generation]), options)).rejects.toThrow(/profile still uses/);
    writeFileSync(path.join(rootDir, "versions", generation, ".pwragent-use-424242"), "");
    await expect(removeManagedGitGeneration(generation, new Set(), { ...options, isProcessAlive: () => true }))
      .rejects.toThrow(/still using/);
    await removeManagedGitGeneration(generation, new Set(), { ...options, isProcessAlive: () => false });
    expect(existsSync(path.join(rootDir, "versions", generation))).toBe(false);
  });
});
