import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { create } from "tar";
import { describe, expect, it, vi } from "vitest";
import {
  installManagedAntigravityRuntime,
  readManagedAntigravityStatus,
  type ManagedAntigravityRuntime,
} from "../acp/antigravity-managed-runtime";

const appleSilicon = { platform: "darwin", arch: "arm64" } as const;
const manifestUrl = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json";
const archiveBase = "https://storage.googleapis.com/antigravity-public/antigravity-cli";
const fixtureBinary = "placeholder executable";

async function withRuntimeRoot(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "antigravity-runtime-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function makeArchive(directory: string, entries = ["antigravity"]): Promise<Buffer<ArrayBuffer>> {
  const archive = path.join(directory, "fixture.tar.gz");
  await writeFile(path.join(directory, "antigravity"), fixtureBinary);
  await create({ cwd: directory, gzip: true, file: archive }, entries);
  return await readFile(archive);
}

function releaseFetch(
  archive: Buffer<ArrayBuffer>,
  version: string,
  fault?: "checksum" | "url" | "download",
) {
  const url = `${archiveBase}/${version}-42/darwin-arm/cli_mac_arm64.tar.gz`;
  const sha512 = createHash("sha512").update(archive).digest("hex");
  return vi.fn<typeof globalThis.fetch>(async (request, init) => {
    expect(init?.redirect).toBe("error");
    if (request === manifestUrl) {
      return Response.json({
        version,
        url: fault === "url" ? `${url}?redirect=true` : url,
        sha512: fault === "checksum" ? "0".repeat(128) : sha512,
      });
    }
    expect(request).toBe(url);
    return fault === "download" ? new Response(null, { status: 503 }) : new Response(archive);
  });
}

it("keeps unsupported platforms off the release feed", async () => {
  const options = { platform: "darwin", arch: "x64", fetch: vi.fn<typeof globalThis.fetch>() } as const;
  expect(await readManagedAntigravityStatus(options)).toEqual({ status: "unsupported" });
  await expect(installManagedAntigravityRuntime(options)).rejects.toThrow("Apple Silicon");
  expect(options.fetch).not.toHaveBeenCalled();
});

describe.skipIf(process.platform === "win32")("managed Antigravity activation", () => {
  it("only publishes successfully verified releases across upgrades, failures and cancellations", async () => {
    await withRuntimeRoot(async (directory) => {
      const archive = await makeArchive(directory);
      const operation = fc.constantFrom("success", "checksum", "url", "download", "verify", "abort");
      await fc.assert(fc.asyncProperty(
        fc.array(operation, { maxLength: 10 }),
        async (operations) => {
          const rootDir = await mkdtemp(path.join(directory, "runs-"));
          const location = { ...appleSilicon, rootDir };
          let published: ManagedAntigravityRuntime | undefined;
          for (const [index, outcome] of ["success" as const, ...operations].entries()) {
            const version = `1.5.${index}`;
            const abort = new AbortController();
            const previous = published;
            const verify = vi.fn(async (command: string, expectedVersion: string) => {
              expect(expectedVersion).toBe(version);
              expect(await readFile(command, "utf8")).toBe(fixtureBinary);
              expect(await readManagedAntigravityStatus(location)).toEqual(previous
                ? { status: "installed", runtime: previous }
                : { status: "not-installed" });
              if (outcome === "verify") throw new Error("ACP validation failed");
              if (outcome === "abort") abort.abort();
            });
            const fault = outcome === "checksum" || outcome === "url" || outcome === "download" ? outcome : undefined;
            const fetch = releaseFetch(archive, version, fault);
            const install = installManagedAntigravityRuntime({ ...location, fetch, verify, signal: abort.signal });
            if (outcome === "success") {
              published = await install;
              expect(published.version).toBe(version);
            } else {
              await expect(install).rejects.toThrow();
            }
            expect(verify).toHaveBeenCalledTimes(fault ? 0 : 1);
            if (outcome === "url") expect(fetch).toHaveBeenCalledTimes(1);
            expect(await readManagedAntigravityStatus(location)).toEqual({ status: "installed", runtime: published });
            if (previous) expect(await readFile(previous.command, "utf8")).toBe(fixtureBinary);
            expect((await readdir(rootDir)).filter((name) => name.startsWith(".install-"))).toEqual([]);
          }
          await rm(rootDir, { force: true, recursive: true });
        },
      ), { numRuns: 25 });
    });
  });

  it("rejects concurrent installs in one process and keeps the old runtime visible during verification", async () => {
    await withRuntimeRoot(async (directory) => {
      const archive = await makeArchive(directory);
      const location = { ...appleSilicon, rootDir: path.join(directory, "managed") };
      const first = await installManagedAntigravityRuntime({
        ...location, fetch: releaseFetch(archive, "1.5.13"), verify: async () => {},
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const options = {
        ...location,
        fetch: releaseFetch(archive, "1.5.14"),
        verify: async () => {
          entered.resolve();
          await release.promise;
        },
      };
      const second = installManagedAntigravityRuntime(options);
      await Promise.race([entered.promise, second]);
      try {
        expect(await readManagedAntigravityStatus(location)).toEqual({ status: "installed", runtime: first });
        await expect(installManagedAntigravityRuntime(options)).rejects.toThrow("already in progress");
      } finally {
        release.resolve();
        await second;
      }
      expect((await readManagedAntigravityStatus(location))).toEqual({ status: "installed", runtime: await second });
    });
  });

  it("rejects a checksummed archive with a symlink or extra file before running ACP", async () => {
    await withRuntimeRoot(async (directory) => {
      await symlink("antigravity", path.join(directory, "extra"));
      const location = { ...appleSilicon, rootDir: path.join(directory, "managed") };
      const verify = vi.fn();
      const extraEntry = await makeArchive(directory, ["antigravity", "extra"]);
      await rm(path.join(directory, "antigravity"));
      await symlink("external", path.join(directory, "antigravity"));
      const linkedEntryPath = path.join(directory, "linked.tar.gz");
      await create({ cwd: directory, gzip: true, file: linkedEntryPath }, ["antigravity"]);
      const linkedEntry = await readFile(linkedEntryPath);
      for (const archive of [extraEntry, linkedEntry]) {
        await expect(installManagedAntigravityRuntime({
          ...location, fetch: releaseFetch(archive, "1.5.14"), verify,
        })).rejects.toThrow("archive layout");
      }
      expect(verify).not.toHaveBeenCalled();
      expect(await readManagedAntigravityStatus(location)).toEqual({ status: "not-installed" });
    });
  });

  it("ignores a runtime pointer escaping the managed release directory", async () => {
    await withRuntimeRoot(async (directory) => {
      const rootDir = path.join(directory, "managed");
      const target = `versions/1.5.14-${"a".repeat(128)}/agy`;
      const external = path.join(directory, "external");
      await mkdir(path.dirname(path.join(external, target)), { recursive: true });
      await writeFile(path.join(external, target), fixtureBinary, { mode: 0o700 });
      await mkdir(rootDir);
      await symlink(path.join(external, "versions"), path.join(rootDir, "versions"));
      await symlink(target, path.join(rootDir, "active"));
      expect(await readManagedAntigravityStatus({ ...appleSilicon, rootDir })).toEqual({ status: "not-installed" });
    });
  });
});
