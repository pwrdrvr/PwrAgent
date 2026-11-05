import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const FIXTURE_CONSUMER = "c".repeat(64);
export const FIXTURE_BUNDLED_VERSION = "2.56.0-dev-pwrgit.4";
const DOWNLOAD = "https://github.com/huntharo/git/releases/download/";

export const sha256 = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

export type FixtureRelease = {
  version: string;
  revision: string;
  tag: string;
  archiveName: string;
  archive: Buffer;
  catalog: Buffer;
  sums: string;
  inventorySha256: string;
};

export type ReleaseMutation = {
  /** Change the payload before it is sealed and archived. */
  payload?: (root: string) => void;
  /** Change the payload after the inventory is sealed. */
  afterSeal?: (root: string) => void;
  /** Change the catalog object before it is serialized. */
  catalog?: (catalog: Record<string, any>) => void;
  /** Absolute paths added to the archive as absolute members. */
  absoluteMembers?: (staging: string) => string[];
  /** Replace the archive bytes after the catalog pins the originals. */
  archive?: (bytes: Buffer) => Buffer;
};

export function makeRoot(prefix = "pwragent-managed-git-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A sealed linux-x64 payload laid out like the real runtime. */
export function writePayload(root: string, version: string, revision: string): void {
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(path.join(root, "libexec", "git-core"), { recursive: true });
  mkdirSync(path.join(root, "ssl"), { recursive: true });
  mkdirSync(path.join(root, "share", "git-core", "templates"), { recursive: true });
  writeFileSync(path.join(root, "bin", "git"), "#!/bin/sh\necho git\n");
  chmodSync(path.join(root, "bin", "git"), 0o755);
  writeFileSync(path.join(root, "libexec", "git-core", "git-lfs"), "#!/bin/sh\necho lfs\n");
  chmodSync(path.join(root, "libexec", "git-core", "git-lfs"), 0o755);
  symlinkSync("../libexec/git-core/git-lfs", path.join(root, "bin", "git-lfs"));
  writeFileSync(path.join(root, "ssl", "cacert.pem"), "-----BEGIN CERTIFICATE-----\n");
  writeFileSync(path.join(root, "share", "git-core", "templates", "description"), "template\n");
  writeFileSync(path.join(root, "COPYING"), "GPL-2.0-only\n");
  writeFileSync(path.join(root, "pwrgit-build.json"), JSON.stringify({
    version,
    source_revision: revision,
    primary_sha1: "SHA1_DC",
    architecture: "x64",
    lfs_version: "3.7.1",
  }));
}

/** The inventory `stage-runtime.mjs` checks: bytes, mode and link per entry. */
export function sealPayload(root: string): string {
  const inventory: Record<string, { sha256?: string; mode?: number; link?: string }> = {};
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (rel === "runtime-files.json") continue;
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) inventory[rel] = { link: readlinkSync(file) };
      else if (stat.isDirectory()) visit(file);
      else inventory[rel] = { sha256: sha256(readFileSync(file)), mode: stat.mode & 0o7777 };
    }
  };
  visit(root);
  const bytes = JSON.stringify(inventory);
  writeFileSync(path.join(root, "runtime-files.json"), bytes);
  return sha256(bytes);
}

export function buildRelease(
  version: string,
  options: { mutate?: ReleaseMutation; revision?: string; consumer?: string } = {},
): FixtureRelease {
  const revision = options.revision ?? sha256(version).slice(0, 40);
  const tag = `v${version}`;
  const archiveName = `pwrgit-${version}-${revision.slice(0, 7)}-linux-x64.tar.gz`;
  const staging = makeRoot("pwragent-managed-git-release-");
  try {
    const payload = path.join(staging, "payload");
    mkdirSync(payload);
    writePayload(payload, version, revision);
    options.mutate?.payload?.(payload);
    const inventorySha256 = sealPayload(payload);
    options.mutate?.afterSeal?.(payload);
    const archivePath = path.join(staging, archiveName);
    const absolute = options.mutate?.absoluteMembers?.(staging) ?? [];
    // BSD tar reads options only before the first operand.
    execFileSync("tar", [
      ...(absolute.length > 0 ? ["-P"] : []),
      "-czf", archivePath, "-C", payload, ".",
      ...absolute,
    ]);
    let archive: Buffer = readFileSync(archivePath);
    const archiveSha256 = sha256(archive);
    if (options.mutate?.archive) archive = options.mutate.archive(archive);
    const catalogObject: Record<string, any> = {
      schema: 1,
      version,
      source_revision: revision,
      consumer_sha256: options.consumer ?? FIXTURE_CONSUMER,
      assets: {
        "linux-x64": {
          url: `${DOWNLOAD}${tag}/${archiveName}`,
          sha256: archiveSha256,
          inventory_sha256: inventorySha256,
          signing: "unsigned",
          notarized: false,
          ca_bundle: { path: "ssl/cacert.pem", sha256: sha256("-----BEGIN CERTIFICATE-----\n") },
        },
      },
    };
    options.mutate?.catalog?.(catalogObject);
    const catalog = Buffer.from(JSON.stringify(catalogObject, null, 2));
    const sums = [
      `${sha256(catalog)}  runtime-manifest.json`,
      `${archiveSha256}  ${archiveName}`,
    ].join("\n");
    return { version, revision, tag, archiveName, archive, catalog, sums, inventorySha256 };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function githubRelease(
  release: FixtureRelease,
  options: {
    digests?: Partial<Record<string, string | null>>;
    draft?: boolean;
    /** GitHub's flag; huntharo/git publishes every build as a prerelease first. */
    prerelease?: unknown;
    publishedAt?: string;
  } = {},
): Record<string, unknown> {
  const asset = (name: string, bytes: Buffer | string) => {
    const digest = options.digests?.[name];
    return {
      name,
      browser_download_url: `${DOWNLOAD}${release.tag}/${name}`,
      size: Buffer.byteLength(bytes),
      ...(digest === null ? {} : { digest: `sha256:${digest ?? sha256(bytes)}` }),
    };
  };
  return {
    tag_name: release.tag,
    draft: options.draft ?? false,
    prerelease: "prerelease" in options ? options.prerelease : true,
    published_at: options.publishedAt ?? "2026-11-05T15:33:24Z",
    assets: [
      asset("runtime-manifest.json", release.catalog),
      asset("SHA256SUMS", release.sums),
      asset(release.archiveName, release.archive),
    ],
  };
}

export type FakeGithub = {
  fetch: typeof globalThis.fetch;
  fetchReleases: (url: string, init: RequestInit, options: { manual: boolean }) => Promise<Response>;
  calls: string[];
  offline: boolean;
  /** Hold archive downloads open until released, to test cancellation. */
  stallArchives: boolean;
};

/** GitHub's release list and downloads, served from memory. */
export function fakeGithub(
  releases: FixtureRelease[],
  listOverrides?: Array<Record<string, unknown>>,
): FakeGithub {
  const files = new Map<string, Buffer>();
  for (const release of releases) {
    files.set(`${DOWNLOAD}${release.tag}/runtime-manifest.json`, release.catalog);
    files.set(`${DOWNLOAD}${release.tag}/SHA256SUMS`, Buffer.from(release.sums));
    files.set(`${DOWNLOAD}${release.tag}/${release.archiveName}`, release.archive);
  }
  const state: FakeGithub = {
    calls: [],
    offline: false,
    stallArchives: false,
    fetchReleases: async (url) => {
      state.calls.push(url);
      if (state.offline) throw new TypeError("fetch failed");
      return new Response(JSON.stringify(listOverrides ?? releases.map((release) => githubRelease(release))), {
        headers: { "Content-Type": "application/json" },
      });
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      state.calls.push(url);
      if (state.offline) throw new TypeError("fetch failed");
      const bytes = files.get(url);
      if (!bytes) return new Response("missing", { status: 404 });
      if (state.stallArchives && url.endsWith(".tar.gz")) {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes.subarray(0, 16)));
            signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        });
        return new Response(body, { headers: { "content-length": String(bytes.length) } });
      }
      return new Response(new Uint8Array(bytes), { headers: { "content-length": String(bytes.length) } });
    }) as typeof globalThis.fetch,
  };
  return state;
}
