import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { create } from "tar";
import { describe, expect, it, vi } from "vitest";
import { AcpStdioJsonRpcTransport } from "../acp/acp-stdio-transport";
import {
  installManagedAntigravityRuntime,
  readManagedAntigravityStatus,
  type ManagedAntigravityRuntime,
} from "../acp/antigravity-managed-runtime";
import { pruneAntigravityRuntime, withAntigravityRuntimeLock } from "../acp/antigravity-runtime-retention";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";

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

async function makeArchive(
  directory: string,
  entries = ["antigravity"],
  contents = fixtureBinary,
): Promise<Buffer<ArrayBuffer>> {
  const archive = path.join(directory, "fixture.tar.gz");
  await writeFile(path.join(directory, "antigravity"), contents);
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
  it("collects abandoned staging and bounds unused releases while preserving every profile selection", async () => {
    await withRuntimeRoot(async (directory) => {
      const archive = await makeArchive(directory);
      await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("direct", "alias", "clear", "keep"), {
        minLength: 4, maxLength: 8,
      }), async (choices) => {
        const home = await mkdtemp(path.join(directory, "retention-"));
        vi.stubEnv("PWRAGENT_HOME", home);
        try {
          const root = path.join(home, "agents", "antigravity");
          const abandoned = ".install-2147483647-abcdEF";
          const busy = `.install-${process.pid}-abcdEF`;
          const ownerless = ".install-abcdEF";
          for (const name of [abandoned, busy, ownerless]) {
            await mkdir(path.join(root, name), { recursive: true });
          }
          const profiles = ["default", "inactive"].map((profile) => path.join(home, "profiles", profile));
          await Promise.all(profiles.map((profile) => mkdir(profile, { recursive: true })));
          const selections: Array<string | undefined> = [];
          const install = (index: number) => installManagedAntigravityRuntime({
            ...appleSilicon, fetch: releaseFetch(archive, `1.5.${index}`), verify: async () => {},
          });
          let active = await install(0);
          for (const [index, choice] of choices.entries()) {
            const profile = index % profiles.length;
            if (choice !== "keep") {
              selections[profile] = choice === "clear" ? undefined : active.command;
              let chosen = selections[profile];
              if (choice === "alias") {
                chosen = path.join(home, `alias-${index}`);
                await symlink(active.command, chosen);
              }
              await writeFile(path.join(profiles[profile], "config.toml"),
                `[acp_agents.antigravity]\ncli_path = ${JSON.stringify(chosen ?? "")}\n`);
            }
            const previous = active;
            active = await install(index + 1);
            const retained = new Set([active.command, previous.command, ...selections.filter((command) => command !== undefined)]);
            const releases = await readdir(path.join(root, "versions"));
            expect(new Set(releases.map((name) => path.join(root, "versions", name, "agy")))).toEqual(retained);
            expect((await readdir(root)).filter((name) => name.startsWith(".install-")).sort()).toEqual([busy, ownerless].sort());
          }
        } finally {
          vi.unstubAllEnvs();
          await rm(home, { recursive: true, force: true });
        }
      }), { numRuns: 20 });
    });
  });

  it("keeps aliased releases until every ACP child releases its hold", async () => {
    await withRuntimeRoot(async (directory) => {
      const archive = await makeArchive(directory);
      vi.stubEnv("PWRAGENT_HOME", directory);
      try {
        const install = (index: number) => installManagedAntigravityRuntime({
          ...appleSilicon, fetch: releaseFetch(archive, `1.5.${index}`), verify: async () => {},
        });
        const held = await install(0);
        const alias = path.join(directory, "agy-alias");
        await symlink(held.command, alias);
        const heldPath = await realpath(held.command);
        const started = vi.fn((command: string) => {
          expect(command).toBe(heldPath);
          return spawn(process.execPath, ["-e", "process.stdin.resume()"], { detached: true });
        });
        const transports = [0, 1].map(() => new AcpStdioJsonRpcTransport({
          launchDescriptor: {
            backendId: "acp:antigravity", registryId: "antigravity", distributionKind: "local",
            command: alias, args: [], env: {},
          },
          spawn: started,
        }));
        try {
          await Promise.all([...transports.map((transport) => transport.connect()), transports[0].connect()]);
          expect(started).toHaveBeenCalledTimes(2);
          const owner = started.mock.results[0].value?.pid;
          expect(owner).toBeTypeOf("number");
          const root = path.join(directory, "agents", "antigravity");
          const busy = path.join(root, `.install-${owner}-abcdef`);
          await mkdir(busy);
          const current = await install(1);
          await rm(alias);
          await symlink(current.command, alias);
          await install(2);
          expect(await readFile(held.command, "utf8")).toBe(fixtureBinary);
          expect(await readdir(busy)).toEqual([]);
          await transports[0].close();
          await install(3);
          expect(await readFile(held.command, "utf8")).toBe(fixtureBinary);
          await expect(readdir(busy)).rejects.toMatchObject({ code: "ENOENT" });
          await transports[1].close();
          await install(4);
          await expect(readFile(held.command)).rejects.toMatchObject({ code: "ENOENT" });

          // A cached automatic selection can recover, while a saved exact
          // path must never silently change to a different binary.
          for (const automatic of [false, true]) {
            const start = vi.fn(() => spawn(process.execPath, ["-e", "process.stdin.resume()"], { detached: true }));
            const transport = new AcpStdioJsonRpcTransport({
              launchDescriptor: {
                backendId: "acp:antigravity", registryId: "antigravity", distributionKind: "local",
                command: held.command, args: [], env: {},
                ...(automatic ? { managedAntigravityFallback: true } : {}),
              },
              spawn: (command) => {
                expect(command).toContain(automatic ? "1.5.4-" : "1.5.0-");
                return start();
              },
            });
            try {
              await transport.connect();
              expect(start).toHaveBeenCalledOnce();
            } finally {
              await transport.close();
            }
          }
        } finally {
          await Promise.allSettled(transports.map((transport) => transport.close()));
        }
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("rejects a managed selection whose publication lost the race with pruning", async () => {
    await withRuntimeRoot(async (directory) => {
      const archive = await makeArchive(directory);
      vi.stubEnv("PWRAGENT_HOME", directory);
      try {
        const store = new DesktopConfigStore({
          configPath: path.join(directory, "profiles", "default", "config.toml"),
        });
        const root = path.join(directory, "agents", "antigravity");
        const install = (index: number) => installManagedAntigravityRuntime({
          ...appleSilicon, fetch: releaseFetch(archive, `1.5.${index}`), verify: async () => {},
        });
        const { command } = await install(0);
        const alias = path.join(directory, "older-agy");
        await symlink(command, alias);
        const select = (cliPath: string) => store.write({ acpAgents: { antigravity: { cliPath } } }, ["providers"]);
        await select(alias);
        const previous = await install(1);
        const active = await install(2);
        expect(await readFile(command, "utf8")).toBe(fixtureBinary);
        await select("");
        const attemptedSelection = Promise.withResolvers<unknown>();
        await withAntigravityRuntimeLock(root, async (assertLocked) => {
          attemptedSelection.resolve(select(alias).catch((error: unknown) => error));
          await pruneAntigravityRuntime(root, active.command, previous.command, assertLocked);
        });
        expect(await attemptedSelection.promise).toMatchObject({
          message: "The selected managed Antigravity release is no longer installed.",
        });
        for (const cliPath of [command, alias]) {
          await expect(select(cliPath)).rejects.toThrow("no longer installed");
        }
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("activates a release that enforces the ACP v1 initialize client schema", async () => {
    await withRuntimeRoot(async (directory) => {
      const archive = await makeArchive(directory);
      const version = "1.5.14";
      const request = vi.spyOn(AcpStdioJsonRpcTransport.prototype, "request").mockImplementation(async (method, params) => {
        expect(method).toBe("initialize");
        expect(params?.protocolVersion).toBe(1);
        const info = params?.clientInfo as { name?: string; version?: string } | undefined;
        if (info && (typeof info.name !== "string" || typeof info.version !== "string")) {
          throw new Error("ACP error -32602: invalid client implementation information");
        }
        return { protocolVersion: 1, agentInfo: { name: "Antigravity ACP Server", version } };
      });
      try {
        const { version: installed } = await installManagedAntigravityRuntime({
          ...appleSilicon, rootDir: path.join(directory, "managed"), fetch: releaseFetch(archive, version),
        });
        expect(installed).toBe(version);
        expect(request).toHaveBeenCalledOnce();
      } finally {
        request.mockRestore();
      }
    });
  });

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

  async function raceReleases(
    directory: string,
    first: { archive: Buffer<ArrayBuffer>; version: string },
    second: { archive: Buffer<ArrayBuffer>; version: string },
    firstFinishesLast: boolean,
  ): Promise<void> {
    const rootDir = await mkdtemp(path.join(directory, "installs-"));
    // Two lexical paths bypass the process-local guard while sharing the same
    // activation files, as independently running owners do.
    const alias = path.join(directory, "alias");
    await symlink(rootDir, alias);
    try {
      const releases = [first, second];
      const entered = releases.map(() => Promise.withResolvers<void>());
      const finish = releases.map(() => Promise.withResolvers<void>());
      const installs = releases.map(({ archive, version }, index) =>
        installManagedAntigravityRuntime({
          ...appleSilicon,
          rootDir: path.join(index === 0 ? rootDir : alias, "managed"),
          fetch: releaseFetch(archive, version),
          verify: async (command) => {
            entered[index].resolve();
            await finish[index].promise;
            expect(await readFile(command)).not.toHaveLength(0);
          },
        }),
      );
      try {
        await Promise.race([Promise.all(entered.map(({ promise }) => promise)), ...installs]);
        const earlier = firstFinishesLast ? 1 : 0;
        finish[earlier].resolve();
        const earlierRuntime = await installs[earlier];
        finish[1 - earlier].resolve();
        const laterRuntime = await installs[1 - earlier];
        const active = await readManagedAntigravityStatus({ ...appleSilicon, rootDir: path.join(rootDir, "managed") });
        const expectedRuntime = first.version === second.version || firstFinishesLast ? earlierRuntime : laterRuntime;
        expect(active).toMatchObject({ status: "installed", runtime: { version: second.version } });
        if (active.status !== "installed") throw new Error("Expected an active runtime");
        expect(await realpath(active.runtime.command)).toBe(await realpath(expectedRuntime.command));
        expect(await realpath(laterRuntime.command)).toBe(await realpath(active.runtime.command));
      } finally {
        for (const gate of finish) gate.resolve();
        await Promise.allSettled(installs);
      }
    } finally {
      await rm(alias, { force: true });
      await rm(rootDir, { recursive: true, force: true });
    }
  }

  it("keeps 1.5.15 active when a slower installer finishes verifying 1.5.14", async () => {
    await withRuntimeRoot(async (directory) => {
      const archive = await makeArchive(directory);
      await raceReleases(directory, { archive, version: "1.5.14" }, { archive, version: "1.5.15" }, true);
    });
  });

  it("keeps a concurrent activation of the same version when the staged digest differs", async () => {
    await withRuntimeRoot(async (directory) => {
      const original = await makeArchive(directory);
      const rebuilt = await makeArchive(directory, ["antigravity"], "rebuilt executable");
      await raceReleases(directory, { archive: original, version: "1.5.14" }, { archive: rebuilt, version: "1.5.14" }, true);
    });
  });

  it("allows a later explicit reinstall of a rebuilt release with the same version", async () => {
    await withRuntimeRoot(async (directory) => {
      const options = { ...appleSilicon, rootDir: path.join(directory, "managed"), verify: async () => {} };
      const original = await makeArchive(directory);
      const previous = await installManagedAntigravityRuntime({ ...options, fetch: releaseFetch(original, "1.5.14") });
      const rebuilt = await makeArchive(directory, ["antigravity"], "rebuilt executable");
      const active = await installManagedAntigravityRuntime({ ...options, fetch: releaseFetch(rebuilt, "1.5.14") });
      expect(await readFile(active.command, "utf8")).toBe("rebuilt executable");
      expect(await readFile(previous.command, "utf8")).toBe(fixtureBinary);
      expect(await readManagedAntigravityStatus(options)).toEqual({ status: "installed", runtime: active });
    });
  });

  it("preserves the newest verified version regardless of verification order", async () => {
    await withRuntimeRoot(async (directory) => {
      const archive = await makeArchive(directory);
      await fc.assert(fc.asyncProperty(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        fc.boolean(),
        async (patch, gap, firstFinishesLast) => {
          await raceReleases(directory, { archive, version: `1.5.${patch}` }, { archive, version: `1.5.${patch + gap}` }, firstFinishesLast);
        },
      ), { numRuns: 25 });
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
