import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureManagedGrokRuntime,
  managedGrokAssetPlatform,
  MANAGED_GROK_RELEASES_FEED_URL,
  MANAGED_GROK_RELEASES_URL,
  selectManagedGrokRelease,
  selectManagedGrokReleaseFromFeed,
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
  it("selects the newest complete PwrAgent prerelease for the platform", () => {
    const selected = selectManagedGrokRelease([
      release("pwragent-v2.0.0-pwragent.2", []),
      release("pwragent-v2.0.0-pwragent.1", [
        asset("SHA256SUMS"),
        asset("pwragent-grok-2.0.0-pwragent.1-macos-universal.tar.gz"),
      ]),
    ], "macos-universal");

    expect(selected).toMatchObject({
      tag: "pwragent-v2.0.0-pwragent.1",
      archive: {
        name: "pwragent-grok-2.0.0-pwragent.1-macos-universal.tar.gz",
      },
    });
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
      '<link href="https://github.com/pwrdrvr/grok-build/releases/tag/pwragent-v1.0.4-pwragent.1"/>',
      "windows-x86_64",
    );

    expect(selected).toMatchObject({
      tag: "pwragent-v1.0.4-pwragent.1",
      archive: {
        name: "pwragent-grok-1.0.4-pwragent.1-windows-x86_64.zip",
        url: expect.stringContaining(
          "/pwragent-v1.0.4-pwragent.1/pwragent-grok-1.0.4-pwragent.1-windows-x86_64.zip",
        ),
      },
    });
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
    const tag = "pwragent-v1.0.0-pwragent.1";
    const commandDir = path.join(rootDir, "versions", tag);
    await mkdir(commandDir, { recursive: true });
    await writeFile(path.join(commandDir, "grok"), "cached");
    await writeFile(
      path.join(rootDir, "managed-release.json"),
      `${JSON.stringify({
        asset: "pwragent-grok-1.0.0-pwragent.1-linux-x86_64.tar.gz",
        checkedAt: 100,
        installedAt: 100,
        repository: "pwrdrvr/grok-build",
        schemaVersion: 1,
        sha256: "a".repeat(64),
        tag,
      })}\n`,
    );

    const runtime = await ensureManagedGrokRuntime({
      arch: "x64",
      checkMode: "force",
      fetch: vi.fn(async () => new Response("offline", { status: 503 })),
      platform: "linux",
      rootDir,
    });

    expect(runtime?.command).toBe(path.join(commandDir, "grok"));
    expect(runtime?.metadata.tag).toBe(tag);
  });

  it("uses the public release feed when the unauthenticated API is limited", async () => {
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
    expect(fetchMock).toHaveBeenCalledWith(
      MANAGED_GROK_RELEASES_FEED_URL,
      expect.any(Object),
    );
  });
});

function release(tag: string, assets: ReturnType<typeof asset>[]) {
  return {
    assets,
    draft: false,
    prerelease: true,
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

async function writeFakeBundle(targetDir: string): Promise<void> {
  await Promise.all([
    writeFile(path.join(targetDir, "grok"), "fake executable"),
    writeFile(path.join(targetDir, "LICENSE"), "license"),
    writeFile(path.join(targetDir, "THIRD-PARTY-NOTICES"), "notices"),
    writeFile(path.join(targetDir, "SOURCE_REV"), "source"),
    writeFile(path.join(targetDir, "PWRAGENT-BUILD.txt"), "build"),
  ]);
}
