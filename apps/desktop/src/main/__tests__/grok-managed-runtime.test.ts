import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import {
  ensureManagedGrokRuntime,
  isManagedGrokTagEligible,
  managedGrokAssetPlatform,
  MANAGED_GROK_MINIMUM_SIGNED_TAG,
  MANAGED_GROK_RELEASES_FEED_URL,
  MANAGED_GROK_RELEASES_URL,
  selectManagedGrokRelease,
  selectManagedGrokReleaseFromFeed,
  resolveActiveManagedGrokCommand,
  selectManagedGrokReleaseSlots,
  setManagedGrokSignatureRejectionReporter,
} from "../acp/grok-managed-runtime";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((entry) =>
      rm(entry, { force: true, recursive: true }),
    ),
  );
});

describe("managed Grok release selection", () => {
  it("selects the newest complete PwrAgent build for the platform", () => {
    const selected = selectManagedGrokRelease([
      release("pwragent-v2.0.0-pwragent.2", []),
      release("pwragent-v2.0.0-pwragent.1", [
        asset("SHA256SUMS"),
        asset("pwragent-grok-2.0.0-pwragent.1-macos-universal.tar.gz"),
      ]),
    ], "macos-universal", "latest");

    expect(selected).toMatchObject({
      tag: "pwragent-v2.0.0-pwragent.1",
      archive: {
        name: "pwragent-grok-2.0.0-pwragent.1-macos-universal.tar.gz",
      },
    });
  });

  it("keeps a build published for testing off the Latest track", () => {
    const releases = [
      release("pwragent-v2.1.0-pwragent.1", [
        asset("SHA256SUMS"),
        asset("pwragent-grok-2.1.0-pwragent.1-macos-universal.tar.gz"),
      ], { prerelease: true }),
      release("pwragent-v2.0.0-pwragent.1", [
        asset("SHA256SUMS"),
        asset("pwragent-grok-2.0.0-pwragent.1-macos-universal.tar.gz"),
      ]),
    ];

    expect(selectManagedGrokReleaseSlots(releases, "macos-universal")).toMatchObject({
      latest: { tag: "pwragent-v2.0.0-pwragent.1" },
      prerelease: { tag: "pwragent-v2.1.0-pwragent.1" },
    });
  });

  it("gives both tracks the same build once the newest one is promoted", () => {
    // The state the control exists for: nothing is under test right now, so
    // the tracks agree — and Prerelease has to stay selectable anyway, or an
    // operator cannot be on it when the next test build lands.
    const releases = [
      release("pwragent-v2.1.0-pwragent.2", [
        asset("SHA256SUMS"),
        asset("pwragent-grok-2.1.0-pwragent.2-macos-universal.tar.gz"),
      ]),
      release("pwragent-v2.1.0-pwragent.1", [
        asset("SHA256SUMS"),
        asset("pwragent-grok-2.1.0-pwragent.1-macos-universal.tar.gz"),
      ], { prerelease: true }),
    ];

    const slots = selectManagedGrokReleaseSlots(releases, "macos-universal");
    expect(slots.latest?.tag).toBe("pwragent-v2.1.0-pwragent.2");
    expect(slots.prerelease?.tag).toBe("pwragent-v2.1.0-pwragent.2");
  });

  it("orders by precedence, not by the order GitHub returned", () => {
    // A promotion is published against a release that already existed, so the
    // newest entry in the response is not the newest build.
    const releases = [
      release("pwragent-v2.0.0-pwragent.1", [
        asset("SHA256SUMS"),
        asset("pwragent-grok-2.0.0-pwragent.1-linux-x86_64.tar.gz"),
      ]),
      release("pwragent-v2.10.0-pwragent.1", [
        asset("SHA256SUMS"),
        asset("pwragent-grok-2.10.0-pwragent.1-linux-x86_64.tar.gz"),
      ]),
    ];

    expect(
      selectManagedGrokRelease(releases, "linux-x86_64", "latest")?.tag,
    ).toBe("pwragent-v2.10.0-pwragent.1");
  });

  it("refuses to serve the Latest track from the unlabeled Atom feed", () => {
    // The feed carries tags, not release records, so it cannot tell a promoted
    // build from one published for testing. Answering the Latest track from it
    // would hand over exactly the build the operator opted out of.
    const feed =
      '<link href="https://github.com/pwrdrvr/grok-build/releases/tag/pwragent-v1.0.4-pwragent.2"/>';
    expect(
      selectManagedGrokReleaseFromFeed(feed, "linux-x86_64", "latest"),
    ).toBeUndefined();
    expect(
      selectManagedGrokReleaseFromFeed(feed, "linux-x86_64", "prerelease"),
    ).toMatchObject({ tag: "pwragent-v1.0.4-pwragent.2" });
  });

  it("maps every currently published desktop target", () => {
    expect(managedGrokAssetPlatform("darwin", "arm64")).toBe("macos-universal");
    expect(managedGrokAssetPlatform("darwin", "x64")).toBe("macos-universal");
    expect(managedGrokAssetPlatform("linux", "x64")).toBe("linux-x86_64");
    expect(managedGrokAssetPlatform("linux", "arm64")).toBe("linux-aarch64");
    expect(managedGrokAssetPlatform("win32", "x64")).toBe("windows-x86_64");
    expect(managedGrokAssetPlatform("win32", "arm64")).toBeUndefined();
  });

  it("derives public asset URLs from the ordered Atom feed", () => {
    const selected = selectManagedGrokReleaseFromFeed(
      '<link href="https://github.com/pwrdrvr/grok-build/releases/tag/pwragent-v1.0.4-pwragent.2"/>',
      "windows-x86_64",
      "prerelease",
    );

    expect(selected).toMatchObject({
      tag: "pwragent-v1.0.4-pwragent.2",
      archive: {
        name: "pwragent-grok-1.0.4-pwragent.2-windows-x86_64.zip",
        url: expect.stringContaining(
          "/pwragent-v1.0.4-pwragent.2/pwragent-grok-1.0.4-pwragent.2-windows-x86_64.zip",
        ),
      },
    });
  });

  it("rejects every downstream build before the first signed tag", () => {
    expect(MANAGED_GROK_MINIMUM_SIGNED_TAG).toBe(
      "pwragent-v1.0.4-pwragent.2",
    );
    expect(isManagedGrokTagEligible("pwragent-v1.0.4-pwragent.1")).toBe(false);
    expect(isManagedGrokTagEligible("pwragent-v1.0.4-pwragent.2")).toBe(true);
    expect(isManagedGrokTagEligible("pwragent-v1.0.4-pwragent.10")).toBe(true);
    expect(isManagedGrokTagEligible("pwragent-v1.0.5-pwragent.1")).toBe(true);
    expect(isManagedGrokTagEligible("pwragent-v1.0.4")).toBe(false);

    expect(selectManagedGrokRelease([
      release("pwragent-v1.0.4-pwragent.1", [
        asset("SHA256SUMS"),
        asset("pwragent-grok-1.0.4-pwragent.1-linux-x86_64.tar.gz"),
      ]),
    ], "linux-x86_64", "prerelease")).toBeUndefined();
    expect(selectManagedGrokReleaseFromFeed(
      '<link href="https://github.com/pwrdrvr/grok-build/releases/tag/pwragent-v1.0.4-pwragent.1"/>',
      "linux-x86_64",
      "prerelease",
    )).toBeUndefined();
  });
});

describe("ensureManagedGrokRuntime", () => {
  it("downloads, verifies, installs, and reuses a fresh cached runtime", async () => {
    const rootDir = await temporaryRoot();
    const archiveName = "pwragent-grok-2.0.0-pwragent.1-linux-x86_64.tar.gz";
    const archive = Buffer.from("verified archive bytes");
    const digest = createHash("sha256").update(archive).digest("hex");
    const releasePayload = [release("pwragent-v2.0.0-pwragent.1", [
      asset("SHA256SUMS"),
      asset(archiveName, digest, archive.length),
    ])];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === MANAGED_GROK_RELEASES_URL) {
        return Response.json(releasePayload);
      }
      if (url.endsWith("/SHA256SUMS")) {
        return new Response(`${digest}  ${archiveName}\n`);
      }
      if (url.endsWith(`/${archiveName}`)) {
        return new Response(archive);
      }
      return new Response("missing", { status: 404 });
    });
    const extractArchive = vi.fn(async (_archivePath: string, targetDir: string) => {
      await writeFakeBundle(targetDir);
    });

    const installed = await ensureManagedGrokRuntime({
      arch: "x64",
      checkMode: "ttl",
      extractArchive,
      fetch: fetchMock as typeof globalThis.fetch,
      now: () => 1_000,
      platform: "linux",
      probeVersion: async () => "grok 2.0.0-test",
      rootDir,
    });

    expect(installed).toMatchObject({
      command: path.join(
        rootDir,
        "versions",
        "pwragent-v2.0.0-pwragent.1",
        "grok",
      ),
      metadata: { sha256: digest, checkedAt: 1_000 },
    });
    expect(extractArchive).toHaveBeenCalledTimes(1);
    const callsAfterInstall = fetchMock.mock.calls.length;

    const cached = await ensureManagedGrokRuntime({
      arch: "x64",
      checkMode: "ttl",
      fetch: fetchMock as typeof globalThis.fetch,
      now: () => 1_001,
      platform: "linux",
      probeVersion: async () => "grok 2.0.0-test",
      rootDir,
    });

    expect(cached?.command).toBe(installed?.command);
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterInstall);
    expect(JSON.parse(
      await readFile(path.join(rootDir, "managed-release.json"), "utf8"),
    )).toMatchObject({ tag: "pwragent-v2.0.0-pwragent.1", sha256: digest });
  });

  it("falls back to the last verified runtime when a forced check is offline", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v1.0.4-pwragent.2";
    const commandDir = path.join(rootDir, "versions", tag);
    await mkdir(commandDir, { recursive: true });
    await writeFakeBundle(commandDir);
    await writeFile(
      path.join(rootDir, "managed-release.json"),
      `${JSON.stringify({
        asset: "pwragent-grok-1.0.4-pwragent.2-linux-x86_64.tar.gz",
        checkedAt: 100,
        installedAt: 100,
        repository: "pwrdrvr/grok-build",
        schemaVersion: 1,
        sha256: "a".repeat(64),
        tag,
      })}\n`,
    );

    expect(resolveActiveManagedGrokCommand(rootDir)).toBeUndefined();

    const runtime = await ensureManagedGrokRuntime({
      arch: "x64",
      checkMode: "force",
      fetch: vi.fn(async () => new Response("offline", { status: 503 })),
      platform: "linux",
      probeVersion: async () => "grok 1.0.4-pwragent.2",
      rootDir,
    });

    expect(runtime?.command).toBe(path.join(commandDir, "grok"));
    expect(runtime?.metadata.tag).toBe(tag);
    expect(resolveActiveManagedGrokCommand(rootDir)).toBe(
      path.join(commandDir, "grok"),
    );
  });

  it("uses the public release feed on Prerelease when the API is limited", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v2.1.0-pwragent.1";
    const archiveName = "pwragent-grok-2.1.0-pwragent.1-linux-x86_64.tar.gz";
    const archive = Buffer.from("feed archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === MANAGED_GROK_RELEASES_URL) {
        return new Response("limited", { status: 403 });
      }
      if (url === MANAGED_GROK_RELEASES_FEED_URL) {
        return new Response(
          `<link href="https://github.com/pwrdrvr/grok-build/releases/tag/${tag}"/>`,
        );
      }
      if (url.endsWith("/SHA256SUMS")) {
        return new Response(`${digest}  ${archiveName}\n`);
      }
      if (url.endsWith(`/${archiveName}`)) {
        return new Response(archive);
      }
      return new Response("missing", { status: 404 });
    });

    const runtime = await ensureManagedGrokRuntime({
      arch: "x64",
      channel: "prerelease",
      checkMode: "force",
      extractArchive: async (_archivePath, targetDir) => {
        await writeFakeBundle(targetDir);
      },
      fetch: fetchMock as typeof globalThis.fetch,
      platform: "linux",
      probeVersion: async () => "grok 2.1.0-test",
      rootDir,
    });

    expect(runtime?.metadata.tag).toBe(tag);
    expect(runtime?.metadata.channel).toBe("prerelease");
    expect(fetchMock).toHaveBeenCalledWith(
      MANAGED_GROK_RELEASES_FEED_URL,
      expect.any(Object),
    );
  });

  it("re-checks when the fresh cache was installed for the other track", async () => {
    // The managed root is machine-wide. A profile on Prerelease rewrites the
    // record a profile on Latest reads next, and the fresh `checkedAt` alone
    // would hand Latest the build it exists to avoid.
    const rootDir = await temporaryRoot();
    const cachedTag = "pwragent-v2.1.0-pwragent.1";
    await writeManagedCache(rootDir, {
      asset: "pwragent-grok-2.1.0-pwragent.1-linux-x86_64.tar.gz",
      channel: "prerelease",
      tag: cachedTag,
    });
    const archiveName = "pwragent-grok-2.0.0-pwragent.1-linux-x86_64.tar.gz";
    const archive = Buffer.from("promoted archive bytes");
    const digest = createHash("sha256").update(archive).digest("hex");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === MANAGED_GROK_RELEASES_URL) {
        return Response.json([
          release("pwragent-v2.1.0-pwragent.1", [
            asset("SHA256SUMS"),
            asset("pwragent-grok-2.1.0-pwragent.1-linux-x86_64.tar.gz"),
          ], { prerelease: true }),
          release("pwragent-v2.0.0-pwragent.1", [
            asset("SHA256SUMS"),
            asset(archiveName, digest, archive.length),
          ]),
        ]);
      }
      if (url.endsWith("/SHA256SUMS")) {
        return new Response(`${digest}  ${archiveName}\n`);
      }
      if (url.endsWith(`/${archiveName}`)) {
        return new Response(archive);
      }
      return new Response("missing", { status: 404 });
    });

    const runtime = await ensureManagedGrokRuntime({
      arch: "x64",
      channel: "latest",
      // A TTL check against a record written moments ago: the short-circuit
      // this test exists to defeat.
      checkMode: "ttl",
      extractArchive: async (_archivePath, targetDir) => {
        await writeFakeBundle(targetDir);
      },
      fetch: fetchMock as typeof globalThis.fetch,
      now: () => 200,
      platform: "linux",
      probeVersion: async () => "grok 2.0.0-test",
      rootDir,
    });

    expect(runtime?.metadata.tag).toBe("pwragent-v2.0.0-pwragent.1");
    expect(runtime?.metadata.channel).toBe("latest");
    // Both tracks are recorded, so the pane can name each one.
    expect(runtime?.metadata.prereleaseTag).toBe("pwragent-v2.1.0-pwragent.1");
  });

  it("keeps the cached build on Latest when only the feed answers", async () => {
    // The feed cannot say which builds are promoted, so the Latest track has
    // no usable answer this cycle. Installing the newest tag anyway would put
    // an untested build on the track that exists to avoid them.
    const rootDir = await temporaryRoot();
    const cachedTag = "pwragent-v1.0.4-pwragent.2";
    await writeManagedCache(rootDir, {
      asset: "pwragent-grok-1.0.4-pwragent.2-linux-x86_64.tar.gz",
      tag: cachedTag,
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === MANAGED_GROK_RELEASES_URL) {
        return new Response("limited", { status: 403 });
      }
      if (url === MANAGED_GROK_RELEASES_FEED_URL) {
        return new Response(
          '<link href="https://github.com/pwrdrvr/grok-build/releases/tag/pwragent-v2.1.0-pwragent.1"/>',
        );
      }
      return new Response("missing", { status: 404 });
    });

    const runtime = await ensureManagedGrokRuntime({
      arch: "x64",
      channel: "latest",
      checkMode: "force",
      fetch: fetchMock as typeof globalThis.fetch,
      platform: "linux",
      probeVersion: async () => "grok 1.0.4-pwragent.2",
      rootDir,
    });

    expect(runtime?.metadata.tag).toBe(cachedTag);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("pwragent-v2.1.0-pwragent.1"),
      expect.anything(),
    );
  });

  it("revalidates a fresh packaged cache against the running app signer", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v1.0.4-pwragent.2";
    await writeManagedCache(rootDir, {
      asset: "pwragent-grok-1.0.4-pwragent.2-macos-universal.tar.gz",
      tag,
    });
    const verifyPlatformSignature = vi.fn(async () => undefined);

    const runtime = await ensureManagedGrokRuntime({
      applicationCommand: "/Applications/PwrAgent.app/Contents/MacOS/PwrAgent",
      arch: "arm64",
      checkMode: "ttl",
      now: () => 101,
      platform: "darwin",
      probeVersion: async () => "grok 1.0.4-pwragent.2",
      requirePlatformSignature: true,
      rootDir,
      verifyPlatformSignature,
    });

    expect(runtime?.metadata.tag).toBe(tag);
    expect(verifyPlatformSignature).toHaveBeenCalledWith(
      path.join(rootDir, "versions", tag, "grok"),
      "/Applications/PwrAgent.app/Contents/MacOS/PwrAgent",
      "darwin",
    );
  });

  it("rejects a packaged cache when signer revalidation fails", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v1.0.4-pwragent.2";
    await writeManagedCache(rootDir, {
      asset: "pwragent-grok-1.0.4-pwragent.2-macos-universal.tar.gz",
      tag,
    });

    const runtime = await ensureManagedGrokRuntime({
      arch: "arm64",
      checkMode: "ttl",
      fetch: vi.fn(async () => new Response("offline", { status: 503 })),
      platform: "darwin",
      probeVersion: async () => "grok 1.0.4-pwragent.2",
      requirePlatformSignature: true,
      rootDir,
      verifyPlatformSignature: async () => {
        throw new Error("signer mismatch");
      },
    });

    expect(runtime).toBeUndefined();
  });

  // A bundle signed by someone else is the one managed-runtime failure the
  // operator has to hear about, and the copy on disk is not ours to keep.
  it("deletes a signer-rejected installed copy and reports it", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v1.0.4-pwragent.2";
    await writeManagedCache(rootDir, {
      asset: "pwragent-grok-1.0.4-pwragent.2-macos-universal.tar.gz",
      tag,
    });
    const versionRoot = path.join(rootDir, "versions", tag);
    const rejections: unknown[] = [];
    setManagedGrokSignatureRejectionReporter((event) => {
      rejections.push(event);
    });

    try {
      const runtime = await ensureManagedGrokRuntime({
        arch: "arm64",
        checkMode: "ttl",
        fetch: vi.fn(async () => new Response("offline", { status: 503 })),
        platform: "darwin",
        probeVersion: async () => "grok 1.0.4-pwragent.2",
        requirePlatformSignature: true,
        rootDir,
        verifyPlatformSignature: async () => {
          throw new Error("signer mismatch");
        },
      });

      expect(runtime).toBeUndefined();
      expect(existsSync(versionRoot)).toBe(false);
      expect(rejections).toEqual([
        {
          detail: expect.stringContaining("signer mismatch"),
          directory: versionRoot,
          occurredAt: expect.any(Number),
          removed: true,
          stage: "installed",
          tag,
        },
      ]);
    } finally {
      setManagedGrokSignatureRejectionReporter(undefined);
    }
  });

  // An ordinary failure must not delete an installed runtime: a missing
  // probe or an unreadable file resolves by reinstalling, not by wiping a
  // bundle that may still be the correct one.
  it("keeps an installed copy when validation fails for another reason", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v1.0.4-pwragent.2";
    await writeManagedCache(rootDir, {
      asset: "pwragent-grok-1.0.4-pwragent.2-macos-universal.tar.gz",
      tag,
    });
    const versionRoot = path.join(rootDir, "versions", tag);
    const rejections: unknown[] = [];
    setManagedGrokSignatureRejectionReporter((event) => {
      rejections.push(event);
    });

    try {
      const runtime = await ensureManagedGrokRuntime({
        arch: "arm64",
        checkMode: "ttl",
        fetch: vi.fn(async () => new Response("offline", { status: 503 })),
        platform: "darwin",
        probeVersion: async () => "unrecognized runtime banner",
        requirePlatformSignature: true,
        rootDir,
        verifyPlatformSignature: async () => undefined,
      });

      expect(runtime).toBeUndefined();
      expect(existsSync(versionRoot)).toBe(true);
      expect(rejections).toEqual([]);
    } finally {
      setManagedGrokSignatureRejectionReporter(undefined);
    }
  });

  it("replaces a same-tag cache built for another architecture", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v2.0.0-pwragent.1";
    const archiveName = "pwragent-grok-2.0.0-pwragent.1-linux-x86_64.tar.gz";
    const archive = Buffer.from("x64 archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    await writeManagedCache(rootDir, {
      asset: "pwragent-grok-2.0.0-pwragent.1-linux-aarch64.tar.gz",
      commandContents: "wrong architecture",
      tag,
    });

    const runtime = await ensureManagedGrokRuntime({
      arch: "x64",
      checkMode: "force",
      extractArchive: async (_archivePath, targetDir) => {
        await writeFakeBundle(targetDir, "grok", "correct architecture");
      },
      fetch: releaseFetch(tag, archiveName, archive, digest),
      platform: "linux",
      probeVersion: async () => "grok 2.0.0-pwragent.1",
      rootDir,
    });

    expect(runtime?.metadata.asset).toBe(archiveName);
    expect(await readFile(runtime?.command ?? "", "utf8")).toBe(
      "correct architecture",
    );
  });

  it("atomically repairs a broken existing same-tag directory", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v2.0.0-pwragent.1";
    const archiveName = "pwragent-grok-2.0.0-pwragent.1-linux-x86_64.tar.gz";
    const archive = Buffer.from("repair archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    await writeManagedCache(rootDir, { asset: archiveName, tag });
    await rm(path.join(rootDir, "versions", tag, "grok"));

    const runtime = await ensureManagedGrokRuntime({
      arch: "x64",
      checkMode: "force",
      extractArchive: async (_archivePath, targetDir) => {
        await writeFakeBundle(targetDir, "grok", "repaired executable");
      },
      fetch: releaseFetch(tag, archiveName, archive, digest),
      platform: "linux",
      probeVersion: async () => "grok 2.0.0-pwragent.1",
      rootDir,
    });

    expect(await readFile(runtime?.command ?? "", "utf8")).toBe(
      "repaired executable",
    );
  });

  it("prunes superseded versions except live and rolling-upgrade caches", async () => {
    const rootDir = await temporaryRoot();
    const versionsRoot = path.join(rootDir, "versions");
    const activeTag = "pwragent-v1.0.4-pwragent.2";
    const prunedTag = "pwragent-v1.0.5-pwragent.1";
    const compatibilityTag = "pwragent-v1.0.6-pwragent.1";
    for (const tag of [activeTag, prunedTag, compatibilityTag]) {
      const versionRoot = path.join(versionsRoot, tag);
      await mkdir(versionRoot, { recursive: true });
      await writeFakeBundle(versionRoot);
    }
    await writeFile(
      path.join(versionsRoot, activeTag, ".pwragent-use-424242"),
      "active\n",
    );
    const tag = "pwragent-v2.0.0-pwragent.1";
    const archiveName = "pwragent-grok-2.0.0-pwragent.1-linux-x86_64.tar.gz";
    const archive = Buffer.from("current archive");
    const digest = createHash("sha256").update(archive).digest("hex");

    await ensureManagedGrokRuntime({
      arch: "x64",
      checkMode: "force",
      extractArchive: async (_archivePath, targetDir) => {
        await writeFakeBundle(targetDir);
      },
      fetch: releaseFetch(tag, archiveName, archive, digest),
      isProcessAlive: (pid) => pid === 424242,
      platform: "linux",
      probeVersion: async () => "grok 2.0.0-pwragent.1",
      rootDir,
    });

    const installedTags = (await readdir(versionsRoot)).sort();
    expect(installedTags).toEqual([
      activeTag,
      compatibilityTag,
      tag,
    ].sort());
  });
});

function release(
  tag: string,
  assets: ReturnType<typeof asset>[],
  options: { prerelease?: boolean } = {},
) {
  return {
    assets,
    draft: false,
    prerelease: options.prerelease === true,
    published_at: "2026-08-15T00:00:00Z",
    tag_name: tag,
  };
}

function asset(name: string, digest?: string, size?: number) {
  return {
    browser_download_url:
      `https://github.com/pwrdrvr/grok-build/releases/download/test/${name}`,
    ...(digest ? { digest: `sha256:${digest}` } : {}),
    name,
    ...(size !== undefined ? { size } : {}),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pwragent-managed-grok-test-"));
  cleanupPaths.push(root);
  return root;
}

async function writeFakeBundle(
  targetDir: string,
  executable = "grok",
  commandContents = "fake executable",
): Promise<void> {
  await Promise.all([
    writeFile(path.join(targetDir, executable), commandContents),
    writeFile(path.join(targetDir, "LICENSE"), "license"),
    writeFile(path.join(targetDir, "THIRD-PARTY-NOTICES"), "notices"),
    writeFile(path.join(targetDir, "SOURCE_REV"), "source"),
    writeFile(path.join(targetDir, "PWRAGENT-BUILD.txt"), "build"),
  ]);
}

async function writeManagedCache(
  rootDir: string,
  options: {
    asset: string;
    channel?: string;
    commandContents?: string;
    tag: string;
  },
): Promise<void> {
  const versionRoot = path.join(rootDir, "versions", options.tag);
  await mkdir(versionRoot, { recursive: true });
  await writeFakeBundle(
    versionRoot,
    options.asset.includes("windows-") ? "grok.exe" : "grok",
    options.commandContents,
  );
  await writeFile(
    path.join(rootDir, "managed-release.json"),
    `${JSON.stringify({
      asset: options.asset,
      ...(options.channel ? { channel: options.channel } : {}),
      checkedAt: 100,
      installedAt: 100,
      repository: "pwrdrvr/grok-build",
      schemaVersion: 1,
      sha256: "a".repeat(64),
      tag: options.tag,
    })}\n`,
  );
}

function releaseFetch(
  tag: string,
  archiveName: string,
  archive: Buffer,
  digest: string,
): typeof globalThis.fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === MANAGED_GROK_RELEASES_URL) {
      return Response.json([release(tag, [
        asset("SHA256SUMS"),
        asset(archiveName, digest, archive.length),
      ])]);
    }
    if (url.endsWith("/SHA256SUMS")) {
      return new Response(`${digest}  ${archiveName}\n`);
    }
    if (url.endsWith(`/${archiveName}`)) {
      return new Response(archive.toString("utf8"));
    }
    return new Response("missing", { status: 404 });
  }) as typeof globalThis.fetch;
}
