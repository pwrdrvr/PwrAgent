import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { extract } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureOpenAiCodexRuntime,
  fetchLatestOpenAiCodexRelease,
  OPENAI_CODEX_CHECK_TTL_MS,
  openAiCodexTarget,
  openAiCodexVersionForCommand,
  readInstalledOpenAiCodexRuntime,
  resetOpenAiCodexRuntimeChecks,
  retainOpenAiCodexCommand,
} from "../codex-openai-runtime";
import {
  appleSilicon,
  appleSiliconTarget,
  makeOpenAiCodexPackage,
  openAiReleaseFetch,
  probeFixtureVersion,
  recordingProgress,
  sha256,
  withTempRoot,
} from "./codex-openai-runtime-fixture";

afterEach(() => {
  resetOpenAiCodexRuntimeChecks();
});

it.each([
  ["darwin", "arm64", "aarch64-apple-darwin"],
  ["darwin", "x64", "x86_64-apple-darwin"],
  ["linux", "arm64", "aarch64-unknown-linux-musl"],
  ["linux", "x64", "x86_64-unknown-linux-musl"],
  ["win32", "arm64", "aarch64-pc-windows-msvc"],
  ["win32", "x64", "x86_64-pc-windows-msvc"],
  ["win32", "ia32", undefined],
  ["freebsd", "x64", undefined],
] as const)("maps %s/%s to OpenAI's release target", (platform, arch, target) => {
  expect(openAiCodexTarget(platform, arch)).toBe(target);
});

it("recognizes only an installed version's own executable", () => {
  const rootDir = path.resolve("/pwragent/agents/codex/openai");
  const at = (...parts: string[]) => path.join(rootDir, "versions", ...parts);
  expect(openAiCodexVersionForCommand(at("0.172.0", "bin", "codex"), { rootDir })).toBe("0.172.0");
  expect(openAiCodexVersionForCommand(at("0.172.0", "bin", "codex.exe"), { rootDir })).toBe("0.172.0");
  expect(openAiCodexVersionForCommand(at("0.172.0", "bin", "codex-exec-server"), { rootDir })).toBeUndefined();
  expect(openAiCodexVersionForCommand(at("0.172.0"), { rootDir })).toBeUndefined();
  expect(openAiCodexVersionForCommand(at("latest", "bin", "codex"), { rootDir })).toBeUndefined();
  // PwrAgent's own build lives one level up and is not this install.
  expect(openAiCodexVersionForCommand(
    path.resolve("/pwragent/agents/codex/versions/pwragent-v0.172.0-pwragent.1/codex"),
    { rootDir },
  )).toBeUndefined();
  expect(openAiCodexVersionForCommand("/opt/homebrew/bin/codex", { rootDir })).toBeUndefined();
  expect(openAiCodexVersionForCommand(undefined, { rootDir })).toBeUndefined();
});

it("resolves the latest release and its checksum the way OpenAI's installer does", async () => {
  const archive = Buffer.from("archive");
  const fetch = openAiReleaseFetch({ latest: () => "0.172.0", archives: new Map([["0.172.0", archive]]) });
  const release = await fetchLatestOpenAiCodexRelease({ ...appleSilicon, fetch });
  expect(release).toMatchObject({
    version: "0.172.0",
    target: "aarch64-apple-darwin",
    archiveName: "codex-package-aarch64-apple-darwin.tar.gz",
    url: "https://github.com/openai/codex/releases/download/rust-v0.172.0/codex-package-aarch64-apple-darwin.tar.gz",
  });
  expect(release.sha256).toMatch(/^[0-9a-f]{64}$/u);
});

it("refuses a prerelease npm tag", async () => {
  const fetch = openAiReleaseFetch({ latest: () => "0.173.0-alpha.1", archives: new Map() });
  await expect(fetchLatestOpenAiCodexRelease({ ...appleSilicon, fetch })).rejects.toThrow("stable");
});

it("never contacts OpenAI for a platform it publishes nothing for", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(fetchLatestOpenAiCodexRelease({ platform: "freebsd", arch: "x64", fetch }))
    .rejects.toThrow("does not publish");
  expect(fetch).not.toHaveBeenCalled();
});

describe.skipIf(process.platform === "win32")("installing OpenAI's Codex", () => {
  it("installs, records, and reuses a verified release without the network", async () => {
    await withTempRoot(async (scratch) => {
      const rootDir = path.join(scratch, "openai");
      const archives = new Map([["0.172.0", await makeOpenAiCodexPackage(scratch, "0.172.0")]]);
      const fetch = openAiReleaseFetch({ latest: () => "0.172.0", archives });
      const progress = recordingProgress();
      const installed = await ensureOpenAiCodexRuntime({
        ...appleSilicon, rootDir, checkMode: "force", fetch, progress, probeVersion: probeFixtureVersion,
      });
      expect(installed?.command).toBe(path.join(rootDir, "versions", "0.172.0", "bin", "codex"));
      expect(progress.phases).toEqual(["checking", "downloading", "verifying", "unpacking", "activating", "ready"]);
      expect(await readFile(installed!.command, "utf8")).toBe("codex 0.172.0\n");
      expect(await readdir(rootDir)).toEqual(expect.arrayContaining(["openai-release.json", "versions"]));
      expect((await readdir(rootDir)).filter((name) => name.startsWith(".install-"))).toEqual([]);

      fetch.mockClear();
      const reused = await ensureOpenAiCodexRuntime({ ...appleSilicon, rootDir, checkMode: "ttl", fetch });
      expect(reused?.command).toBe(installed?.command);
      expect(fetch).not.toHaveBeenCalled();
      expect(await readdir(installed!.versionRoot)).toContain(`.pwragent-use-${process.pid}`);
    });
  });

  it("never installs a first copy on a routine check", async () => {
    await withTempRoot(async (scratch) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      expect(await ensureOpenAiCodexRuntime({
        ...appleSilicon, rootDir: path.join(scratch, "openai"), checkMode: "ttl", fetch,
      })).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["a checksum OpenAI did not publish", undefined, "0.172.0", "Checksum mismatch"],
    ["a package manifest for another release", "manifest-version", undefined, "does not match"],
    ["a package without its rg", "missing-rg", undefined, "incomplete"],
    ["a link out of the package", "symlink", undefined, "unsafe entry"],
  ] as const)("installs nothing from %s", async (_label, fault, corruptChecksumFor, message) => {
    await withTempRoot(async (scratch) => {
      const rootDir = path.join(scratch, "openai");
      const archives = new Map([["0.172.0", await makeOpenAiCodexPackage(scratch, "0.172.0", fault)]]);
      const fetch = openAiReleaseFetch({
        latest: () => "0.172.0",
        archives,
        ...(corruptChecksumFor ? { corruptChecksumFor } : {}),
      });
      await expect(ensureOpenAiCodexRuntime({
        ...appleSilicon, rootDir, checkMode: "force", fetch,
        progress: recordingProgress(), probeVersion: probeFixtureVersion,
      })).rejects.toThrow(message);
      expect(await readInstalledOpenAiCodexRuntime({ ...appleSilicon, rootDir })).toBeUndefined();
      expect((await readdir(rootDir)).filter((name) => name !== "versions")).toEqual([]);
    });
  });

  it("installs nothing when the binary reports another version", async () => {
    await withTempRoot(async (scratch) => {
      const rootDir = path.join(scratch, "openai");
      const archives = new Map([["0.172.0", await makeOpenAiCodexPackage(scratch, "0.172.0")]]);
      await expect(ensureOpenAiCodexRuntime({
        ...appleSilicon, rootDir, checkMode: "force",
        fetch: openAiReleaseFetch({ latest: () => "0.172.0", archives }),
        progress: recordingProgress(),
        probeVersion: async () => "codex-cli 0.171.0\n",
      })).rejects.toThrow("expected \"codex-cli 0.172.0\"");
      expect(await readInstalledOpenAiCodexRuntime({ ...appleSilicon, rootDir })).toBeUndefined();
    });
  });

  it("refuses a latest release below the recommended minimum when nothing is installed", async () => {
    await withTempRoot(async (scratch) => {
      const fetch = openAiReleaseFetch({
        latest: () => "0.150.0",
        archives: new Map([["0.150.0", await makeOpenAiCodexPackage(scratch, "0.150.0")]]),
      });
      await expect(ensureOpenAiCodexRuntime({
        ...appleSilicon, rootDir: path.join(scratch, "openai"), checkMode: "force", fetch,
        progress: recordingProgress(), probeVersion: probeFixtureVersion,
      })).rejects.toThrow("older than");
      const downloads = fetch.mock.calls.filter(([url]) => String(url).endsWith(".tar.gz"));
      expect(downloads).toEqual([]);
    });
  });

  it("updates once a day in the background and keeps the old version while it is in use", async () => {
    await withTempRoot(async (scratch) => {
      const rootDir = path.join(scratch, "openai");
      const archives = new Map([
        ["0.170.0", await makeOpenAiCodexPackage(scratch, "0.170.0")],
        ["0.172.0", await makeOpenAiCodexPackage(scratch, "0.172.0")],
      ]);
      let latest = "0.170.0";
      const fetch = openAiReleaseFetch({ latest: () => latest, archives });
      let now = 1_000;
      const base = {
        ...appleSilicon, rootDir, fetch, now: () => now,
        probeVersion: probeFixtureVersion, progress: recordingProgress(),
      };
      const first = await ensureOpenAiCodexRuntime({ ...base, checkMode: "force" });

      latest = "0.172.0";
      now += OPENAI_CODEX_CHECK_TTL_MS - 1;
      fetch.mockClear();
      expect((await ensureOpenAiCodexRuntime({ ...base, checkMode: "ttl" }))?.version).toBe("0.170.0");
      expect(fetch).not.toHaveBeenCalled();

      now += 1;
      // A stale check answers at once with the installed copy, then updates.
      expect((await ensureOpenAiCodexRuntime({ ...base, checkMode: "ttl" }))?.version).toBe("0.170.0");
      await vi.waitFor(async () => {
        expect((await readInstalledOpenAiCodexRuntime(base))?.version).toBe("0.172.0");
      });
      // This process marked 0.170.0 in use, so it stays for the app server running it.
      expect(await readdir(path.join(rootDir, "versions"))).toEqual(expect.arrayContaining(["0.170.0", "0.172.0"]));
      expect(await readFile(first!.command, "utf8")).toBe("codex 0.170.0\n");
    });
  });

  it("checks at once when a PwrAgent update raised the minimum above the installed copy", async () => {
    await withTempRoot(async (scratch) => {
      // An install from before the minimum moved: written the way an older
      // PwrAgent left it, because today's installer would refuse 0.150.0.
      const rootDir = path.join(scratch, "openai");
      const old = await makeOpenAiCodexPackage(scratch, "0.150.0");
      const versionRoot = path.join(rootDir, "versions", "0.150.0");
      await mkdir(versionRoot, { recursive: true });
      await writeFile(path.join(scratch, "old.tar.gz"), old);
      await extract({ file: path.join(scratch, "old.tar.gz"), cwd: versionRoot });
      const record = { version: "0.150.0", target: appleSiliconTarget, sha256: sha256(old) };
      await writeFile(path.join(versionRoot, ".pwragent-install.json"), JSON.stringify(record));
      const now = 5_000;
      await writeFile(path.join(rootDir, "openai-release.json"), JSON.stringify({
        schemaVersion: 1, ...record, installedAt: now, checkedAt: now,
      }));
      const archives = new Map([["0.172.0", await makeOpenAiCodexPackage(scratch, "0.172.0")]]);
      const base = {
        ...appleSilicon, rootDir, now: () => now + 1,
        fetch: openAiReleaseFetch({ latest: () => "0.172.0", archives }),
        probeVersion: probeFixtureVersion, progress: recordingProgress(),
      };
      expect((await ensureOpenAiCodexRuntime({ ...base, checkMode: "ttl" }))?.version).toBe("0.150.0");
      await vi.waitFor(async () => {
        expect((await readInstalledOpenAiCodexRuntime(base))?.version).toBe("0.172.0");
      });
    });
  });

  it("never downgrades when npm moves back", async () => {
    await withTempRoot(async (scratch) => {
      const rootDir = path.join(scratch, "openai");
      const archives = new Map([
        ["0.170.0", await makeOpenAiCodexPackage(scratch, "0.170.0")],
        ["0.172.0", await makeOpenAiCodexPackage(scratch, "0.172.0")],
      ]);
      let latest = "0.172.0";
      const fetch = openAiReleaseFetch({ latest: () => latest, archives });
      const base = { ...appleSilicon, rootDir, fetch, probeVersion: probeFixtureVersion, progress: recordingProgress() };
      await ensureOpenAiCodexRuntime({ ...base, checkMode: "force" });
      latest = "0.170.0";
      fetch.mockClear();
      expect((await ensureOpenAiCodexRuntime({ ...base, checkMode: "force" }))?.version).toBe("0.172.0");
      expect(fetch.mock.calls.filter(([url]) => String(url).endsWith(".tar.gz"))).toEqual([]);
    });
  });

  it("keeps using the installed copy when a check fails, and backs off", async () => {
    await withTempRoot(async (scratch) => {
      const rootDir = path.join(scratch, "openai");
      const archives = new Map([["0.170.0", await makeOpenAiCodexPackage(scratch, "0.170.0")]]);
      const working = openAiReleaseFetch({ latest: () => "0.170.0", archives });
      await ensureOpenAiCodexRuntime({
        ...appleSilicon, rootDir, checkMode: "force", fetch: working,
        probeVersion: probeFixtureVersion, progress: recordingProgress(),
      });
      const offline = vi.fn<typeof globalThis.fetch>(async () => { throw new Error("offline"); });
      const progress = recordingProgress();
      const kept = await ensureOpenAiCodexRuntime({
        ...appleSilicon, rootDir, checkMode: "force", fetch: offline, progress,
      });
      expect(kept?.version).toBe("0.170.0");
      expect(progress.phases).toEqual(["checking", "failed"]);
    });
  });

  it("prunes versions no live PwrAgent uses", async () => {
    await withTempRoot(async (scratch) => {
      const rootDir = path.join(scratch, "openai");
      const versions = path.join(rootDir, "versions");
      for (const [name, pid] of [["0.160.0", 111], ["0.161.0", 222], ["not-a-version", 333]] as const) {
        await mkdir(path.join(versions, name), { recursive: true });
        await writeFile(path.join(versions, name, `.pwragent-use-${pid}`), "0\n");
      }
      const archives = new Map([["0.172.0", await makeOpenAiCodexPackage(scratch, "0.172.0")]]);
      await ensureOpenAiCodexRuntime({
        ...appleSilicon, rootDir, checkMode: "force",
        fetch: openAiReleaseFetch({ latest: () => "0.172.0", archives }),
        probeVersion: probeFixtureVersion, progress: recordingProgress(),
        isProcessAlive: (pid) => pid === 222,
      });
      expect((await readdir(versions)).sort()).toEqual(["0.161.0", "0.172.0", "not-a-version"]);
    });
  });

  it("retains a cached selection only while its version is intact", async () => {
    await withTempRoot(async (scratch) => {
      const rootDir = path.join(scratch, "openai");
      const archives = new Map([["0.172.0", await makeOpenAiCodexPackage(scratch, "0.172.0")]]);
      const installed = await ensureOpenAiCodexRuntime({
        ...appleSilicon, rootDir, checkMode: "force",
        fetch: openAiReleaseFetch({ latest: () => "0.172.0", archives }),
        probeVersion: probeFixtureVersion, progress: recordingProgress(),
      });
      await expect(retainOpenAiCodexCommand(installed!.command, { ...appleSilicon, rootDir })).resolves.toBeUndefined();
      await expect(retainOpenAiCodexCommand("/opt/homebrew/bin/codex", { ...appleSilicon, rootDir })).resolves.toBeUndefined();
      await writeFile(path.join(installed!.versionRoot, "codex-package.json"), "{}");
      await expect(retainOpenAiCodexCommand(installed!.command, { ...appleSilicon, rootDir })).rejects.toThrow();
    });
  });
});
