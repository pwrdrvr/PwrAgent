import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureManagedCodexRuntime,
  isManagedCodexTagEligible,
  managedCodexAssetPlatform,
  MANAGED_CODEX_MINIMUM_SIGNED_TAG,
  MANAGED_CODEX_RELEASES_FEED_URL,
  MANAGED_CODEX_RELEASES_URL,
  selectManagedCodexRelease,
  selectManagedCodexReleaseFromFeed,
} from "../codex-managed-runtime";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (entry) =>
      await rm(entry, { force: true, recursive: true }),
    ),
  );
});

describe("managed Codex release selection", () => {
  it("selects the newest complete eligible release for the platform", () => {
    const selected = selectManagedCodexRelease([
      release("pwragent-v0.200.0-pwragent.2", []),
      release("pwragent-v0.200.0-pwragent.1", [
        asset("SHA256SUMS"),
        asset("pwragent-codex-0.200.0-pwragent.1-macos-aarch64.tar.gz"),
      ]),
    ], "macos-aarch64");

    expect(selected).toMatchObject({
      tag: "pwragent-v0.200.0-pwragent.1",
      archive: {
        name: "pwragent-codex-0.200.0-pwragent.1-macos-aarch64.tar.gz",
      },
    });
  });

  it("maps every published downstream Codex target", () => {
    expect(managedCodexAssetPlatform("darwin", "arm64")).toBe(
      "macos-aarch64",
    );
    expect(managedCodexAssetPlatform("darwin", "x64")).toBe(
      "macos-x86_64",
    );
    expect(managedCodexAssetPlatform("linux", "arm64")).toBe(
      "linux-aarch64",
    );
    expect(managedCodexAssetPlatform("linux", "x64")).toBe(
      "linux-x86_64",
    );
    expect(managedCodexAssetPlatform("win32", "x64")).toBe(
      "windows-x86_64",
    );
    expect(managedCodexAssetPlatform("win32", "arm64")).toBeUndefined();
  });

  it("derives immutable asset URLs from the public Atom feed", () => {
    const selected = selectManagedCodexReleaseFromFeed(
      '<link href="https://github.com/pwrdrvr/codex/releases/tag/pwragent-v0.200.0-pwragent.1"/>',
      "windows-x86_64",
    );

    expect(selected).toMatchObject({
      tag: "pwragent-v0.200.0-pwragent.1",
      archive: {
        name: "pwragent-codex-0.200.0-pwragent.1-windows-x86_64.zip",
        url: expect.stringContaining(
          "/pwragent-v0.200.0-pwragent.1/pwragent-codex-0.200.0-pwragent.1-windows-x86_64.zip",
        ),
      },
    });
  });

  it("rejects downstream tags before the managed-runtime floor", () => {
    expect(MANAGED_CODEX_MINIMUM_SIGNED_TAG).toBe(
      "pwragent-v0.146.0-pwragent.1",
    );
    expect(isManagedCodexTagEligible("pwragent-v0.145.0-pwragent.9")).toBe(
      false,
    );
    expect(isManagedCodexTagEligible("pwragent-v0.146.0-pwragent.1")).toBe(
      true,
    );
    expect(isManagedCodexTagEligible("pwragent-v0.200.0-pwragent.1")).toBe(
      true,
    );
    expect(isManagedCodexTagEligible("pwragent-v0.200.0")).toBe(false);
  });
});

describe("ensureManagedCodexRuntime", () => {
  it("downloads, verifies, installs, and reuses a fresh cached bundle", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v0.200.0-pwragent.1";
    const version = "0.200.0-pwragent.1";
    const archiveName = `pwragent-codex-${version}-linux-x86_64.tar.gz`;
    const archive = Buffer.from("verified codex archive bytes");
    const digest = createHash("sha256").update(archive).digest("hex");
    const fetchMock = releaseFetch({ archive, archiveName, digest, tag });
    const extractArchive = vi.fn(
      async (_archivePath: string, targetDir: string) => {
        await writeFakeBundle(targetDir, "linux");
      },
    );

    const installed = await ensureManagedCodexRuntime({
      arch: "x64",
      checkMode: "force",
      extractArchive,
      fetch: fetchMock as typeof globalThis.fetch,
      now: () => 1_000,
      platform: "linux",
      probeVersion: versionProbe(version),
      rootDir,
    });

    expect(installed).toMatchObject({
      command: path.join(rootDir, "versions", tag, "codex"),
      appServerCommand: path.join(
        rootDir,
        "versions",
        tag,
        "codex-app-server",
      ),
      codeModeHostCommand: path.join(
        rootDir,
        "versions",
        tag,
        "codex-code-mode-host",
      ),
      metadata: { checkedAt: 1_000, sha256: digest, tag, version },
    });
    expect(extractArchive).toHaveBeenCalledOnce();
    const callsAfterInstall = fetchMock.mock.calls.length;

    const cached = await ensureManagedCodexRuntime({
      arch: "x64",
      checkMode: "ttl",
      fetch: fetchMock as typeof globalThis.fetch,
      now: () => 1_001,
      platform: "linux",
      probeVersion: versionProbe(version),
      rootDir,
    });

    expect(cached.command).toBe(installed.command);
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterInstall);
    expect(JSON.parse(
      await readFile(path.join(rootDir, "managed-release.json"), "utf8"),
    )).toMatchObject({ sha256: digest, tag, version });
  });

  it("uses the verified cache when a forced update check is offline", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v0.146.0-pwragent.1";
    const version = "0.146.0-pwragent.1";
    await writeManagedCache(rootDir, { tag, version });

    const runtime = await ensureManagedCodexRuntime({
      arch: "x64",
      checkMode: "force",
      fetch: vi.fn(async () => new Response("offline", { status: 503 })),
      platform: "linux",
      probeVersion: versionProbe(version),
      rootDir,
    });

    expect(runtime.command).toBe(path.join(rootDir, "versions", tag, "codex"));
    expect(runtime.metadata.tag).toBe(tag);
  });

  it("fails a first install instead of falling back to an arbitrary Codex", async () => {
    const rootDir = await temporaryRoot();

    await expect(ensureManagedCodexRuntime({
      arch: "x64",
      checkMode: "force",
      fetch: vi.fn(async () => new Response("offline", { status: 503 })),
      platform: "linux",
      rootDir,
    })).rejects.toThrow("GitHub release check failed with HTTP 503");
  });

  it("uses the release feed when the unauthenticated API is limited", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v0.201.0-pwragent.1";
    const version = "0.201.0-pwragent.1";
    const archiveName = `pwragent-codex-${version}-linux-x86_64.tar.gz`;
    const archive = Buffer.from("feed codex archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === MANAGED_CODEX_RELEASES_URL) {
        return new Response("limited", { status: 403 });
      }
      if (url === MANAGED_CODEX_RELEASES_FEED_URL) {
        return new Response(
          `<link href="https://github.com/pwrdrvr/codex/releases/tag/${tag}"/>`,
        );
      }
      if (url.endsWith("/SHA256SUMS")) {
        return new Response(`${digest}  ${archiveName}\n`);
      }
      if (url.endsWith(`/${archiveName}`)) {
        return new Response(archive.toString("utf8"));
      }
      return new Response("missing", { status: 404 });
    });

    const runtime = await ensureManagedCodexRuntime({
      arch: "x64",
      checkMode: "force",
      extractArchive: async (_archivePath, targetDir) => {
        await writeFakeBundle(targetDir, "linux");
      },
      fetch: fetchMock as typeof globalThis.fetch,
      platform: "linux",
      probeVersion: versionProbe(version),
      rootDir,
    });

    expect(runtime.metadata.tag).toBe(tag);
    expect(fetchMock).toHaveBeenCalledWith(
      MANAGED_CODEX_RELEASES_FEED_URL,
      expect.any(Object),
    );
  });

  it("verifies every executable against the packaged PwrAgent signer", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v0.200.0-pwragent.1";
    const version = "0.200.0-pwragent.1";
    const archiveName = `pwragent-codex-${version}-macos-aarch64.tar.gz`;
    const archive = Buffer.from("signed codex archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    const verifyPlatformSignature = vi.fn(async () => undefined);

    await ensureManagedCodexRuntime({
      applicationCommand: "/Applications/PwrAgent.app/Contents/MacOS/PwrAgent",
      arch: "arm64",
      checkMode: "force",
      extractArchive: async (_archivePath, targetDir) => {
        await writeFakeBundle(targetDir, "darwin");
      },
      fetch: releaseFetch({
        archive,
        archiveName,
        digest,
        tag,
      }) as typeof globalThis.fetch,
      platform: "darwin",
      probeVersion: versionProbe(version),
      requirePlatformSignature: true,
      rootDir,
      verifyPlatformSignature,
    });

    expect(verifyPlatformSignature).toHaveBeenCalledTimes(3);
    expect(verifyPlatformSignature).toHaveBeenCalledWith(
      expect.stringMatching(/codex-app-server$/u),
      "/Applications/PwrAgent.app/Contents/MacOS/PwrAgent",
      "darwin",
    );
  });
});

function asset(name: string, digest?: string, size?: number) {
  return {
    browser_download_url:
      `https://github.com/pwrdrvr/codex/releases/download/test/${name}`,
    ...(digest ? { digest: `sha256:${digest}` } : {}),
    name,
    ...(size !== undefined ? { size } : {}),
  };
}

function release(tag: string, assets: ReturnType<typeof asset>[]) {
  return { assets, draft: false, published_at: "2026-08-28", tag_name: tag };
}

function releaseFetch(params: {
  archive: Buffer;
  archiveName: string;
  digest: string;
  tag: string;
}) {
  const payload = [release(params.tag, [
    asset("SHA256SUMS"),
    asset(params.archiveName, params.digest, params.archive.length),
  ])];
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === MANAGED_CODEX_RELEASES_URL) {
      return Response.json(payload);
    }
    if (url.endsWith("/SHA256SUMS")) {
      return new Response(`${params.digest}  ${params.archiveName}\n`);
    }
    if (url.endsWith(`/${params.archiveName}`)) {
      return new Response(params.archive.toString("utf8"));
    }
    return new Response("missing", { status: 404 });
  });
}

function versionProbe(version: string) {
  return async (command: string): Promise<string> => {
    const name = path.basename(command).replace(/\.exe$/u, "");
    if (name === "codex") return `codex-cli ${version}`;
    return `${name} ${version}`;
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "pwragent-managed-codex-"));
  cleanupPaths.push(root);
  return root;
}

async function writeFakeBundle(
  directory: string,
  platform: NodeJS.Platform,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const suffix = platform === "win32" ? ".exe" : "";
  const executables = [
    `codex${suffix}`,
    `codex-app-server${suffix}`,
    `codex-code-mode-host${suffix}`,
    ...(platform === "win32"
      ? ["codex-windows-sandbox-setup.exe", "codex-command-runner.exe"]
      : []),
  ];
  await Promise.all([
    ...executables.map(async (name) =>
      await writeFile(path.join(directory, name), name),
    ),
    writeFile(path.join(directory, "LICENSE"), "license"),
    writeFile(path.join(directory, "NOTICE"), "notice"),
    writeFile(path.join(directory, "PWRAGENT-BUILD.txt"), "signed=yes"),
  ]);
}

async function writeManagedCache(
  rootDir: string,
  params: { tag: string; version: string },
): Promise<void> {
  const versionRoot = path.join(rootDir, "versions", params.tag);
  await writeFakeBundle(versionRoot, "linux");
  await writeFile(
    path.join(rootDir, "managed-release.json"),
    `${JSON.stringify({
      asset: `pwragent-codex-${params.version}-linux-x86_64.tar.gz`,
      checkedAt: 100,
      installedAt: 100,
      repository: "pwrdrvr/codex",
      schemaVersion: 1,
      sha256: "a".repeat(64),
      tag: params.tag,
      version: params.version,
    })}\n`,
  );
  expect(existsSync(versionRoot)).toBe(true);
}
