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
  MANAGED_CODEX_CHECK_TTL_MS,
  MANAGED_CODEX_MINIMUM_SIGNED_TAG,
  MANAGED_CODEX_PUBLICATION_MARKER_NAME,
  MANAGED_CODEX_RELEASES_FEED_URL,
  MANAGED_CODEX_RELEASES_URL,
  MANAGED_CODEX_UPDATE_MANIFEST_NAME,
  MANAGED_CODEX_UPDATE_SIGNATURE_NAME,
  selectManagedCodexRelease,
  selectManagedCodexReleaseFromFeed,
} from "../codex-managed-runtime";

const verifySigstoreMock = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("sigstore", () => ({ verify: verifySigstoreMock }));

const cleanupPaths: string[] = [];

afterEach(async () => {
  verifySigstoreMock.mockClear();
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
        ...publicationAssets(),
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
      "pwragent-v0.149.0-pwragent.1",
    );
    expect(isManagedCodexTagEligible("pwragent-v0.148.0-pwragent.9")).toBe(
      false,
    );
    expect(isManagedCodexTagEligible("pwragent-v0.149.0-pwragent.1")).toBe(
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
    expect(verifySigstoreMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      }),
      expect.objectContaining({
        certificateIssuer: "https://token.actions.githubusercontent.com",
        certificateOIDs: expect.objectContaining({
          "1.3.6.1.4.1.57264.1.2": "push",
          "1.3.6.1.4.1.57264.1.3": "a".repeat(40),
          "1.3.6.1.4.1.57264.1.5": "pwrdrvr/codex",
          "1.3.6.1.4.1.57264.1.6": `refs/tags/${tag}`,
        }),
        ctLogThreshold: 1,
        tlogThreshold: 1,
        tufCachePath: path.join(rootDir, "tuf"),
      }),
    );
    expect(existsSync(path.join(rootDir, "tuf"))).toBe(true);
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

  it("accepts a manifest with supported large sibling artifacts", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v0.200.0-pwragent.1";
    const version = "0.200.0-pwragent.1";
    const archiveName = `pwragent-codex-${version}-macos-aarch64.tar.gz`;
    const archive = Buffer.from("small selected archive");
    const digest = createHash("sha256").update(archive).digest("hex");

    const runtime = await ensureManagedCodexRuntime({
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
        unselectedArtifactSize: 636_579_696,
      }) as typeof globalThis.fetch,
      platform: "darwin",
      probeVersion: versionProbe(version),
      rootDir,
    });

    expect(runtime.metadata.tag).toBe(tag);
  });

  it("uses the verified cache when a forced update check is offline", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v0.149.0-pwragent.1";
    const version = "0.149.0-pwragent.1";
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

  it("serves a stale verified cache while its update check runs", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v0.149.0-pwragent.1";
    const version = "0.149.0-pwragent.1";
    await writeManagedCache(rootDir, { tag, version });
    const controller = new AbortController();
    let fetchAborted = false;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            fetchAborted = true;
            reject(init.signal?.reason);
          }, { once: true });
        }),
    );
    let settled = false;
    const runtimePromise = ensureManagedCodexRuntime({
      arch: "x64",
      checkMode: "ttl",
      fetch: fetchMock as typeof globalThis.fetch,
      now: () => 100 + MANAGED_CODEX_CHECK_TTL_MS,
      platform: "linux",
      probeVersion: versionProbe(version),
      rootDir,
      signal: controller.signal,
    }).then((runtime) => {
      settled = true;
      return runtime;
    });

    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(settled).toBe(true));
      await expect(runtimePromise).resolves.toMatchObject({
        command: path.join(rootDir, "versions", tag, "codex"),
        metadata: { tag },
      });
    } finally {
      controller.abort();
      expect(fetchAborted).toBe(true);
    }
  });

  it("preserves a runtime marked by the current process while pruning", async () => {
    const rootDir = await temporaryRoot();
    const activeTag = "pwragent-v0.200.0-pwragent.1";
    const compatibilityTag = "pwragent-v0.201.0-pwragent.1";
    const currentTag = "pwragent-v0.202.0-pwragent.1";
    const currentVersion = "0.202.0-pwragent.1";
    await writeManagedCache(rootDir, {
      tag: currentTag,
      version: currentVersion,
    });
    const activeRoot = path.join(rootDir, "versions", activeTag);
    await writeFakeBundle(activeRoot, "linux");
    await writeFile(
      path.join(activeRoot, `.pwragent-use-${process.pid}`),
      "active\n",
    );
    await writeFakeBundle(
      path.join(rootDir, "versions", compatibilityTag),
      "linux",
    );

    await ensureManagedCodexRuntime({
      arch: "x64",
      checkMode: "ttl",
      now: () => 101,
      platform: "linux",
      probeVersion: versionProbe(currentVersion),
      rootDir,
    });

    expect(existsSync(activeRoot)).toBe(true);
    expect(existsSync(
      path.join(activeRoot, `.pwragent-use-${process.pid}`),
    )).toBe(true);
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

  it("rejects a completion marker with an expanded schema", async () => {
    const rootDir = await temporaryRoot();
    const tag = "pwragent-v0.200.0-pwragent.1";
    const version = "0.200.0-pwragent.1";
    const archiveName = `pwragent-codex-${version}-linux-x86_64.tar.gz`;
    const archive = Buffer.from("marker schema archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    const validFetch = releaseFetch({ archive, archiveName, digest, tag });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith(`/${MANAGED_CODEX_PUBLICATION_MARKER_NAME}`)) {
        const publication = publicationFixture({
          archive,
          archiveName,
          digest,
          tag,
        });
        return Response.json({
          ...JSON.parse(publication.marker),
          unexpected: true,
        });
      }
      return await validFetch(input);
    });

    await expect(ensureManagedCodexRuntime({
      arch: "x64",
      checkMode: "force",
      extractArchive: vi.fn(),
      fetch: fetchMock as typeof globalThis.fetch,
      platform: "linux",
      rootDir,
    })).rejects.toThrow(
      "managed Codex publication marker has an unsupported schema",
    );
    expect(verifySigstoreMock).not.toHaveBeenCalled();
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
      const publication = publicationFixture({
        archive,
        archiveName,
        digest,
        tag,
      });
      if (url === MANAGED_CODEX_RELEASES_URL) {
        return new Response("limited", { status: 403 });
      }
      if (url === MANAGED_CODEX_RELEASES_FEED_URL) {
        return new Response(
          `<link href="https://github.com/pwrdrvr/codex/releases/tag/${tag}"/>`,
        );
      }
      if (url.endsWith("/SHA256SUMS")) {
        return new Response(publication.checksum);
      }
      if (url.endsWith(`/${MANAGED_CODEX_UPDATE_MANIFEST_NAME}`)) {
        return new Response(publication.manifest);
      }
      if (url.endsWith(`/${MANAGED_CODEX_UPDATE_SIGNATURE_NAME}`)) {
        return new Response(publication.signature);
      }
      if (url.endsWith(`/${MANAGED_CODEX_PUBLICATION_MARKER_NAME}`)) {
        return new Response(publication.marker);
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

function publicationAssets() {
  return [
    asset(MANAGED_CODEX_UPDATE_MANIFEST_NAME),
    asset(MANAGED_CODEX_UPDATE_SIGNATURE_NAME),
    asset(MANAGED_CODEX_PUBLICATION_MARKER_NAME),
  ];
}

function release(tag: string, assets: ReturnType<typeof asset>[]) {
  return { assets, draft: false, published_at: "2026-08-28", tag_name: tag };
}

function releaseFetch(params: {
  archive: Buffer;
  archiveName: string;
  digest: string;
  tag: string;
  unselectedArtifactSize?: number;
}) {
  const publication = publicationFixture(params);
  const payload = [release(params.tag, [
    asset("SHA256SUMS"),
    asset(params.archiveName, params.digest, params.archive.length),
    ...publicationAssets(),
  ])];
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === MANAGED_CODEX_RELEASES_URL) {
      return Response.json(payload);
    }
    if (url.endsWith("/SHA256SUMS")) {
      return new Response(publication.checksum);
    }
    if (url.endsWith(`/${MANAGED_CODEX_UPDATE_MANIFEST_NAME}`)) {
      return new Response(publication.manifest);
    }
    if (url.endsWith(`/${MANAGED_CODEX_UPDATE_SIGNATURE_NAME}`)) {
      return new Response(publication.signature);
    }
    if (url.endsWith(`/${MANAGED_CODEX_PUBLICATION_MARKER_NAME}`)) {
      return new Response(publication.marker);
    }
    if (url.endsWith(`/${params.archiveName}`)) {
      return new Response(params.archive.toString("utf8"));
    }
    return new Response("missing", { status: 404 });
  });
}

function publicationFixture(params: {
  archive: Buffer;
  archiveName: string;
  digest: string;
  tag: string;
  unselectedArtifactSize?: number;
}) {
  const version = params.tag.slice("pwragent-v".length);
  const targets = [
    ["darwin", "arm64", "macos-aarch64", "aarch64-apple-darwin", "tar.gz"],
    ["darwin", "x64", "macos-x86_64", "x86_64-apple-darwin", "tar.gz"],
    ["linux", "arm64", "linux-aarch64", "aarch64-unknown-linux-gnu", "tar.gz"],
    ["linux", "x64", "linux-x86_64", "x86_64-unknown-linux-gnu", "tar.gz"],
    ["win32", "x64", "windows-x86_64", "x86_64-pc-windows-msvc", "zip"],
  ] as const;
  const artifacts = targets.map(
    ([os, arch, platform, target, archiveType]) => {
      const file = `pwragent-codex-${version}-${platform}.${archiveType}`;
      const selected = file === params.archiveName;
      return {
        arch,
        archiveType,
        file,
        os,
        platform,
        sha256: selected
          ? params.digest
          : createHash("sha256").update(file).digest("hex"),
        size: selected
          ? params.archive.length
          : params.unselectedArtifactSize ?? 1,
        target,
      };
    },
  );
  const sourceCommit = "a".repeat(40);
  const manifest = JSON.stringify({
    schemaVersion: 1,
    product: "pwragent-codex",
    version,
    releaseTag: params.tag,
    source: {
      repository: "pwrdrvr/codex",
      commit: sourceCommit,
    },
    capabilities: {
      codeModeOutputReducer: {
        protocolVersion: 1,
        intentContextVersion: 1,
      },
      pwrdrvrTokenMiser: {
        identity: "pwrdrvr.pwragent.token-miser",
        version: 1,
      },
    },
    artifacts,
  });
  const manifestDigest = createHash("sha256").update(manifest).digest("hex");
  const checksum = `${params.digest}  ${params.archiveName}\n`;
  const subjects = [
    ...artifacts.map((artifact) => ({
      name: artifact.file,
      digest: { sha256: artifact.sha256 },
    })),
    {
      name: "SHA256SUMS",
      digest: {
        sha256: createHash("sha256").update(checksum).digest("hex"),
      },
    },
    {
      name: MANAGED_CODEX_UPDATE_MANIFEST_NAME,
      digest: { sha256: manifestDigest },
    },
  ];
  return {
    checksum,
    manifest,
    marker: JSON.stringify({
      complete: true,
      manifest: {
        file: MANAGED_CODEX_UPDATE_MANIFEST_NAME,
        sha256: manifestDigest,
        signatureBundle: MANAGED_CODEX_UPDATE_SIGNATURE_NAME,
        signatureFormat: "sigstore-bundle-v0.3",
      },
      product: "pwragent-codex",
      releaseTag: params.tag,
      schemaVersion: 1,
      sourceCommit,
      version,
    }),
    signature: JSON.stringify({
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {},
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify({
          _type: "https://in-toto.io/Statement/v1",
          subject: subjects,
          predicateType: "https://slsa.dev/provenance/v1",
          predicate: {},
        })).toString("base64"),
        payloadType: "application/vnd.in-toto+json",
        signatures: [],
      },
    }),
  };
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
