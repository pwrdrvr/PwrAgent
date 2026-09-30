import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PwrSuiteInstallerPhase,
  PwrSuiteInstallerState,
} from "../../shared/pwrsuite-installer";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/nonexistent") },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

const {
  PwrSuiteInstallerService,
  installerAssetPatterns,
  selectInstallerAsset,
} = await import("../mcp-connections/pwrsuite-installer-service");

const INSTALLER_BYTES = Buffer.from("pretend this is a PwrGit disk image");
const INSTALLER_SHA256 = createHash("sha256").update(INSTALLER_BYTES).digest("hex");
const DOWNLOAD_PREFIX = "https://github.com/pwrdrvr/PwrGit/releases/download/v0.25.0";

function asset(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    size: INSTALLER_BYTES.length,
    digest: `sha256:${INSTALLER_SHA256}`,
    browser_download_url: `${DOWNLOAD_PREFIX}/${name}`,
    ...overrides,
  };
}

const release = {
  tag_name: "v0.25.0",
  assets: [
    asset("PwrGit.dmg"),
    asset("PwrGit-0.25.0-universal.dmg"),
    asset("PwrGit-0.25.0-arm64.dmg"),
    asset("PwrGit-0.25.0-windows-x64-setup.exe"),
    asset("PwrGit-0.25.0-arm64-mac.zip"),
  ],
};

function releaseFetch(
  body: () => BodyInit = () => new Uint8Array(INSTALLER_BYTES),
  releaseBody: unknown = release,
) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify(releaseBody), { status: 200 });
    }
    return new Response(body(), { status: 200 });
  });
}

function waitForPhase(
  service: InstanceType<typeof PwrSuiteInstallerService>,
  phase: PwrSuiteInstallerPhase,
): Promise<PwrSuiteInstallerState> {
  return new Promise((resolve) => {
    const unsubscribe = service.subscribe((state) => {
      if (state.phase === phase) {
        unsubscribe();
        resolve(state);
      }
    });
  });
}

describe("installer asset selection", () => {
  const select = (platform: NodeJS.Platform, arch: string) => {
    const target = installerAssetPatterns("PwrGit", platform, arch);
    return target ? selectInstallerAsset("pwrgit", release, target) : undefined;
  };

  it("picks the Apple silicon dmg on arm64, the universal one on Intel, and the setup on Windows", () => {
    expect(select("darwin", "arm64")).toMatchObject({
      platform: "mac",
      version: "0.25.0",
      assetName: "PwrGit-0.25.0-arm64.dmg",
      sha256: INSTALLER_SHA256,
    });
    expect(select("darwin", "x64")?.assetName).toBe("PwrGit-0.25.0-universal.dmg");
    expect(select("win32", "x64")?.assetName).toBe(
      "PwrGit-0.25.0-windows-x64-setup.exe",
    );
    expect(select("win32", "arm64")?.platform).toBe("windows");
  });

  it("offers nothing on Linux, where neither app ships", () => {
    expect(installerAssetPatterns("PwrGit", "linux", "x64")).toBeUndefined();
  });

  it("falls back to the universal dmg when a release has no arm64 build", () => {
    const target = installerAssetPatterns("PwrGit", "darwin", "arm64")!;
    const withoutArm = {
      ...release,
      assets: release.assets.filter((entry) => !entry.name.includes("arm64")),
    };
    expect(selectInstallerAsset("pwrgit", withoutArm, target)?.assetName).toBe(
      "PwrGit-0.25.0-universal.dmg",
    );
  });

  it("refuses an asset served from anywhere but the app's own releases, or without a digest", () => {
    const target = installerAssetPatterns("PwrGit", "win32", "x64")!;
    const name = "PwrGit-0.25.0-windows-x64-setup.exe";
    for (const override of [
      { browser_download_url: `https://example.com/${name}` },
      { browser_download_url: `https://github.com/pwrdrvr/PwrSnap/releases/download/v1/${name}` },
      { digest: null },
      { digest: "sha1:abc" },
      { size: 0 },
    ]) {
      expect(
        selectInstallerAsset("pwrgit", { ...release, assets: [asset(name, override)] }, target),
      ).toBeUndefined();
    }
  });
});

describe("PwrSuiteInstallerService", () => {
  let downloads: string;

  beforeEach(async () => {
    downloads = await mkdtemp(join(tmpdir(), "pwrsuite-installer-"));
  });

  afterEach(async () => {
    await rm(downloads, { recursive: true, force: true });
  });

  function createService(
    fetchFn: ReturnType<typeof releaseFetch>,
    overrides: Partial<ConstructorParameters<typeof PwrSuiteInstallerService>[0]> = {},
  ) {
    return new PwrSuiteInstallerService({
      fetchFn: fetchFn as unknown as typeof fetch,
      downloadsDir: () => downloads,
      platform: "darwin",
      arch: "arm64",
      ...overrides,
    });
  }

  it("answers at once, then publishes the offer, and reads GitHub once", async () => {
    const fetchFn = releaseFetch();
    const service = createService(fetchFn);
    const offered = new Promise<PwrSuiteInstallerState>((resolve) => {
      service.subscribe((state) => {
        if (state.offer) resolve(state);
      });
    });

    expect(service.readState("pwrgit")).toEqual({
      app: "pwrgit",
      platform: "mac",
      phase: "idle",
    });
    const expected = {
      app: "pwrgit",
      platform: "mac",
      phase: "idle",
      offer: {
        platform: "mac",
        version: "0.25.0",
        assetName: "PwrGit-0.25.0-arm64.dmg",
        sizeBytes: INSTALLER_BYTES.length,
      },
    };
    await expect(offered).resolves.toEqual(expected);
    expect(service.readState("pwrgit")).toEqual(expected);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("does not ask GitHub again right after a failed read", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 503 }));
    const service = createService(fetchFn as never);

    service.readState("pwrgit");
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
    // Let the failed read settle before asking again.
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.readState("pwrgit");

    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("asks GitHub for nothing on Linux", async () => {
    const fetchFn = releaseFetch();
    const service = createService(fetchFn, { platform: "linux" });

    expect(service.readState("pwrsnap")).toEqual({
      app: "pwrsnap",
      phase: "idle",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("downloads, verifies, and names the installer in Downloads", async () => {
    const service = createService(releaseFetch());
    const phases: PwrSuiteInstallerPhase[] = [];
    service.subscribe((state) => phases.push(state.phase));
    const ready = waitForPhase(service, "ready");

    await expect(service.start("pwrgit")).resolves.toMatchObject({
      phase: "downloading",
      totalBytes: INSTALLER_BYTES.length,
    });
    await expect(ready).resolves.toMatchObject({
      phase: "ready",
      fileName: "PwrGit-0.25.0-arm64.dmg",
    });

    expect(phases.filter((phase, index) => phase !== phases[index - 1])).toEqual([
      "downloading",
      "verifying",
      "ready",
    ]);
    expect(await readdir(downloads)).toEqual(["PwrGit-0.25.0-arm64.dmg"]);
    expect(await readFile(join(downloads, "PwrGit-0.25.0-arm64.dmg"))).toEqual(
      INSTALLER_BYTES,
    );
  });

  it("opens and reveals only the installer it downloaded", async () => {
    const openPath = vi.fn(async () => "");
    const showItemInFolder = vi.fn();
    const service = createService(releaseFetch(), { openPath, showItemInFolder });

    await expect(service.openInstaller("pwrgit")).resolves.toMatchObject({
      opened: false,
    });
    const ready = waitForPhase(service, "ready");
    await service.start("pwrgit");
    await ready;

    await expect(service.openInstaller("pwrgit")).resolves.toEqual({ opened: true });
    expect(service.revealInstaller("pwrgit")).toEqual({ opened: true });
    const path = join(downloads, "PwrGit-0.25.0-arm64.dmg");
    expect(openPath).toHaveBeenCalledWith(path);
    expect(showItemInFolder).toHaveBeenCalledWith(path);
  });

  it("deletes a download that does not match the release digest", async () => {
    const service = createService(
      releaseFetch(() => new Uint8Array(Buffer.from("tampered bytes, same length!!!!!!!!"))),
    );
    const failed = waitForPhase(service, "failed");

    await service.start("pwrgit");

    await expect(failed).resolves.toMatchObject({
      error: "The download didn't verify",
    });
    expect(await readdir(downloads)).toEqual([]);
  });

  it("returns to idle and removes the partial file on cancel", async () => {
    let sentFirstChunk!: () => void;
    const firstChunk = new Promise<void>((resolve) => {
      sentFirstChunk = resolve;
    });
    const stalled = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(INSTALLER_BYTES.subarray(0, 8)));
          sentFirstChunk();
        },
      });
    const service = createService(releaseFetch(stalled));
    const idle = waitForPhase(service, "idle");

    await service.start("pwrgit");
    await firstChunk;
    service.cancel("pwrgit");

    await expect(idle).resolves.toEqual({
      app: "pwrgit",
      platform: "mac",
      phase: "idle",
      offer: expect.objectContaining({ assetName: "PwrGit-0.25.0-arm64.dmg" }),
    });
    expect(await readdir(downloads)).toEqual([]);
  });

  it("runs one download when Start arrives twice while GitHub answers", async () => {
    const fetchFn = releaseFetch();
    const service = createService(fetchFn);
    const ready = waitForPhase(service, "ready");

    const [first, second] = await Promise.all([
      service.start("pwrgit"),
      service.start("pwrgit"),
    ]);
    await ready;

    expect(first.phase).toBe("downloading");
    expect(second.phase).toBe("downloading");
    const installerFetches = fetchFn.mock.calls.filter(
      ([input]) => !String(input).startsWith("https://api.github.com/"),
    );
    expect(installerFetches).toHaveLength(1);
    expect(await readdir(downloads)).toEqual(["PwrGit-0.25.0-arm64.dmg"]);
  });

  it("stops a download canceled while the release is still being read", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith("https://api.github.com/")) {
        await answered;
        return new Response(JSON.stringify(release), { status: 200 });
      }
      return new Response(new Uint8Array(INSTALLER_BYTES), { status: 200 });
    });
    const service = createService(fetchFn as never);

    const started = service.start("pwrgit");
    service.cancel("pwrgit");
    answer();

    await expect(started).resolves.toMatchObject({ phase: "idle" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("downloads from a recent answer when GitHub stops answering", async () => {
    let apiUp = true;
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith("https://api.github.com/")) {
        if (!apiUp) throw new TypeError("fetch failed");
        return new Response(JSON.stringify(release), { status: 200 });
      }
      return new Response(new Uint8Array(INSTALLER_BYTES), { status: 200 });
    });
    const service = createService(fetchFn as never);
    const offered = new Promise<void>((resolve) => {
      service.subscribe((state) => {
        if (state.offer) resolve();
      });
    });
    service.readState("pwrgit");
    await offered;
    apiUp = false;
    const ready = waitForPhase(service, "ready");

    await expect(service.start("pwrgit")).resolves.toMatchObject({
      phase: "downloading",
    });
    await expect(ready).resolves.toMatchObject({ phase: "ready" });
  });

  it("does not ask GitHub again right after a release with no installer here", async () => {
    const fetchFn = releaseFetch(undefined, { tag_name: "v0.25.0", assets: [] });
    const service = createService(fetchFn);

    service.readState("pwrgit");
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    service.readState("pwrgit");

    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("gives a short reason when GitHub cannot be reached", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const service = createService(fetchFn as never);

    await expect(service.start("pwrgit")).resolves.toMatchObject({
      phase: "failed",
      error: "Couldn't reach GitHub",
    });
  });
});
