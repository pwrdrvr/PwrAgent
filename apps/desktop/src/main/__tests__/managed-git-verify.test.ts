import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  agreedSha256,
  compareManagedGitVersions,
  ManagedGitNeedsAppUpdateError,
  ManagedGitTrustError,
  managedGitPlatformKey,
  parseCustomGitCatalog,
  selectManagedGitReleases,
  unsafeArchiveMember,
  verifyManagedGitPayload,
  type CustomGitPin,
} from "../managed-git-verify";
import {
  buildRelease,
  FIXTURE_CONSUMER,
  githubRelease,
  makeRoot,
  sealPayload,
  sha256,
  writePayload,
} from "./helpers/managed-git-fixture";

const bundledCatalogPath = fileURLToPath(new URL("../../../custom-git-runtime.json", import.meta.url));
const bundled = JSON.parse(readFileSync(bundledCatalogPath, "utf8"));
const parse = (catalog: unknown, platform: NodeJS.Platform = "darwin", arch = "arm64", extra: { expectedVersion?: string } = {}) =>
  parseCustomGitCatalog(JSON.stringify(catalog), {
    platform,
    arch,
    consumerSha256: bundled.consumer_sha256,
    ...extra,
  });
const clone = () => structuredClone(bundled);

describe("release catalog rules", () => {
  it("accepts the pinned catalog for every platform it ships", () => {
    expect(parse(bundled, "darwin", "arm64").key).toBe("darwin-universal");
    expect(parse(bundled, "darwin", "x64").key).toBe("darwin-universal");
    expect(parse(bundled, "linux", "x64").key).toBe("linux-x64");
    expect(parse(bundled, "linux", "arm64").key).toBe("linux-arm64");
  });

  it("offers nothing on Windows, which keeps Dugite's MinGit", () => {
    expect(managedGitPlatformKey("win32", "x64")).toBeUndefined();
    expect(() => parse(bundled, "win32", "x64")).toThrow(ManagedGitTrustError);
  });

  it("treats a catalog for a different verifier as needing a newer app, never as installable", () => {
    const catalog = clone();
    catalog.consumer_sha256 = "f".repeat(64);
    expect(() => parse(catalog)).toThrow(ManagedGitNeedsAppUpdateError);
  });

  it("rejects a catalog that is not for the release it came from", () => {
    expect(() => parse(bundled, "darwin", "arm64", { expectedVersion: "2.56.0-dev-pwrgit.99" })).toThrow(/not 2\.56\.0-dev-pwrgit\.99/);
  });

  it.each([
    ["a query on the archive URL", (c: any) => { c.assets["darwin-universal"].url += "?x=1"; }],
    ["another repository", (c: any) => { c.assets["darwin-universal"].url = c.assets["darwin-universal"].url.replace("huntharo/git", "git/git"); }],
    ["another release's URL", (c: any) => { c.assets["darwin-universal"].url = c.assets["darwin-universal"].url.replace(`v${c.version}`, "v2.56.0-dev-pwrgit.1"); }],
    ["a nested path", (c: any) => { c.assets["darwin-universal"].url = c.assets["darwin-universal"].url.replace(/\/([^/]+)$/u, "/x/$1"); }],
    ["an unnotarized macOS build", (c: any) => { c.assets["darwin-universal"].notarized = false; }],
    ["another team's macOS build", (c: any) => { c.assets["darwin-universal"].team_id = "ABCDE12345"; }],
    ["a malformed version", (c: any) => { c.version = "2.56.0"; }],
    ["a short source revision", (c: any) => { c.source_revision = "abc"; }],
    ["a malformed archive hash", (c: any) => { c.assets["darwin-universal"].sha256 = "xyz"; }],
    ["schema 2", (c: any) => { c.schema = 2; }],
  ])("rejects %s", (_name, mutate) => {
    const catalog = clone();
    mutate(catalog);
    expect(() => parse(catalog)).toThrow(ManagedGitTrustError);
  });

  it("requires the Linux CA bundle at ssl/cacert.pem", () => {
    const catalog = clone();
    catalog.assets["linux-x64"].ca_bundle.path = "etc/ssl/cert.pem";
    expect(() => parse(catalog, "linux", "x64")).toThrow(/ssl\/cacert\.pem/);
    delete catalog.assets["linux-x64"].ca_bundle;
    expect(() => parse(catalog, "linux", "x64")).toThrow(/ssl\/cacert\.pem/);
  });
});

// The fixtures build POSIX tar archives; Windows has no PwrDrvr Git runtime.
describe.skipIf(process.platform === "win32")("release selection", () => {
  const releaseFor = (version: string) => githubRelease(buildRelease(version));

  it("finds prereleases, skips drafts and anything not newer than the bundle, and orders by build number", () => {
    const list = [
      githubRelease(buildRelease("2.56.0-dev-pwrgit.10"), { publishedAt: "2026-01-01T00:00:00Z" }),
      releaseFor("2.56.0-dev-pwrgit.9"),
      githubRelease(buildRelease("2.56.0-dev-pwrgit.11"), { draft: true }),
      releaseFor("2.56.0-dev-pwrgit.4"),
      releaseFor("2.56.0-dev-pwrgit.3"),
      { tag_name: "v2.57.0", draft: false, assets: [] },
      { tag_name: "v2.56.0-dev-pwrgit.12-rc1", draft: false, assets: [] },
    ];
    expect(selectManagedGitReleases(list, "2.56.0-dev-pwrgit.4").map((r) => r.version))
      .toEqual(["2.56.0-dev-pwrgit.10", "2.56.0-dev-pwrgit.9"]);
  });

  it("drops a release missing its catalog or checksums, or with an asset served from elsewhere", () => {
    const base = buildRelease("2.56.0-dev-pwrgit.5");
    const noSums = githubRelease(base);
    (noSums.assets as any[]).splice(1, 1);
    const foreign = githubRelease(base);
    (foreign.assets as any[])[0].browser_download_url = "https://example.com/runtime-manifest.json";
    expect(selectManagedGitReleases([noSums], "2.56.0-dev-pwrgit.4")).toEqual([]);
    expect(selectManagedGitReleases([foreign], "2.56.0-dev-pwrgit.4")).toEqual([]);
  });

  it("orders any versions by base version, then build number, never by text", () => {
    const version = fc.tuple(fc.nat(3), fc.nat(60), fc.nat(3), fc.nat(40))
      .map(([a, b, c, n]) => `${a}.${b}.${c}-dev-pwrgit.${n}`);
    fc.assert(fc.property(version, version, (left, right) => {
      const l = left.split(/[.-]/u).filter((part) => /^\d+$/u.test(part)).map(Number);
      const r = right.split(/[.-]/u).filter((part) => /^\d+$/u.test(part)).map(Number);
      const model = l.findIndex((value, index) => value !== r[index]);
      const expected = model === -1 ? 0 : Math.sign(l[model] - r[model]);
      expect(Math.sign(compareManagedGitVersions(left, right))).toBe(expected);
    }));
  });
});

describe("published hash agreement", () => {
  const hash = fc.stringMatching(/^[0-9a-f]{64}$/u);

  it("accepts only when SHA256SUMS, the catalog and GitHub's digest all agree; a missing digest is allowed", () => {
    fc.assert(fc.property(hash, fc.option(hash, { nil: undefined }), fc.option(hash, { nil: undefined }), (listed, catalog, digest) => {
      const sums = `${listed}  pwrgit.tar.gz\n${"0".repeat(64)}  other`;
      const agree = (catalog === undefined || catalog === listed) && (digest === undefined || digest === listed);
      if (agree) expect(agreedSha256("pwrgit.tar.gz", sums, { catalog, githubDigest: digest })).toBe(listed);
      else expect(() => agreedSha256("pwrgit.tar.gz", sums, { catalog, githubDigest: digest })).toThrow(ManagedGitTrustError);
    }));
  });

  it("rejects a file SHA256SUMS lists twice or not at all", () => {
    const h = "a".repeat(64);
    expect(() => agreedSha256("x", `${h}  x\n${h}  x`, {})).toThrow(/twice/);
    expect(() => agreedSha256("x", `${h}  y`, {})).toThrow(/does not list/);
  });
});

describe("archive member paths", () => {
  it("flags every absolute or parent-escaping name, and nothing else", () => {
    const segment = fc.constantFrom("bin", "git", "..", ".", "libexec", "a..b", "...");
    fc.assert(fc.property(fc.boolean(), fc.array(segment, { minLength: 1, maxLength: 5 }), (absolute, parts) => {
      const name = `${absolute ? "/" : ""}${parts.join("/")}`;
      expect(unsafeArchiveMember(name)).toBe(absolute || parts.includes(".."));
    }));
    expect(unsafeArchiveMember("C:/Windows/evil")).toBe(true);
    expect(unsafeArchiveMember("..\\evil")).toBe(true);
  });
});

describe("macOS signatures", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const MACH_O = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);

  function universal(): { root: string; pin: CustomGitPin } {
    const root = makeRoot();
    roots.push(root);
    const version = "2.56.0-dev-pwrgit.9";
    const revision = "b".repeat(40);
    writePayload(root, version, revision);
    writeFileSync(path.join(root, "bin", "git"), MACH_O, { mode: 0o755 });
    writeFileSync(path.join(root, "libexec", "git-core", "git-lfs"), MACH_O, { mode: 0o755 });
    writeFileSync(path.join(root, "pwrgit-build.json"), JSON.stringify({
      version, source_revision: revision, primary_sha1: "SHA1_DC", architecture: "universal",
      notarized: true, signing: "Developer ID Application: PwrDrvr LLC (T44CNHC4UH)",
    }));
    const inventorySha256 = sealPayload(root);
    return {
      root,
      pin: {
        key: "darwin-universal",
        catalog: { schema: 1, version, source_revision: revision, consumer_sha256: FIXTURE_CONSUMER, assets: {} },
        asset: { url: "", sha256: sha256("x"), inventory_sha256: inventorySha256, team_id: "T44CNHC4UH", notarized: true },
      },
    };
  }

  it("checks every Mach-O for both slices and a strict PwrDrvr team signature", async () => {
    const { root, pin } = universal();
    const calls: string[][] = [];
    await verifyManagedGitPayload(root, pin, {
      probe: false,
      run: async (command, args) => {
        calls.push([command, ...args]);
        return command.endsWith("lipo") ? "x86_64 arm64" : "";
      },
    });
    const codesign = calls.filter(([command]) => command.endsWith("codesign"));
    expect(codesign).toHaveLength(2);
    for (const call of codesign) {
      expect(call).toEqual(expect.arrayContaining([
        "--verify", "--all-architectures", "--strict", "--test-requirement",
        '=anchor apple generic and certificate leaf[subject.OU] = "T44CNHC4UH"',
      ]));
    }
  });

  it("rejects an unsigned or foreign-team helper, and a single-architecture one", async () => {
    const { root, pin } = universal();
    await expect(verifyManagedGitPayload(root, pin, {
      probe: false,
      run: async (command, args) => {
        if (command.endsWith("lipo")) return "arm64 x86_64";
        if (args.at(-1)?.endsWith("git-lfs")) throw new Error("test-requirement: code failed to satisfy specified code requirement(s)");
        return "";
      },
    })).rejects.toThrow(/git-lfs is not signed by PwrDrvr/);
    await expect(verifyManagedGitPayload(root, pin, {
      probe: false,
      run: async (command) => (command.endsWith("lipo") ? "arm64" : ""),
    })).rejects.toThrow(/Missing universal Git slice/);
  });

  it("rejects a build record that does not claim the notarized PwrDrvr signature", async () => {
    const { root, pin } = universal();
    const build = JSON.parse(readFileSync(path.join(root, "pwrgit-build.json"), "utf8"));
    build.signing = "-";
    writeFileSync(path.join(root, "pwrgit-build.json"), JSON.stringify(build));
    const resealed = { ...pin, asset: { ...pin.asset, inventory_sha256: sealPayload(root) } };
    await expect(verifyManagedGitPayload(root, resealed, { probe: false, run: async () => "arm64 x86_64" }))
      .rejects.toThrow(/notarized PwrDrvr Git/);
  });
});
