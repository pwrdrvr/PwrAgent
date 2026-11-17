import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import fc from "fast-check";
import { afterEach, expect, it } from "vitest";
import { ensureRuntime, inventory, platformPath } from "./electron-runtime-cache.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const roots = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const execAsync = promisify(execFile);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(version = "44.10.1", bytes = randomBytes(1024 * 1024)) {
  const root = mkdtempSync(join(tmpdir(), "pwragent-electron-cache-"));
  roots.push(root);
  const payload = join(root, "payload");
  mkdirSync(join(payload, "Electron.app/Contents/MacOS"), { recursive: true });
  for (const executable of ["Electron.app/Contents/MacOS/Electron", "electron", "electron.exe"]) {
    writeFileSync(join(payload, executable), bytes, { mode: 0o755 });
  }
  writeFileSync(join(payload, "version"), version);
  writeFileSync(join(payload, "electron.d.ts"), "// fixture types\n");
  const zip = join(root, "electron.zip");
  if (process.platform === "win32") {
    const quote = (value) => `'${value.replace(/'/g, "''")}'`;
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path ${quote(join(payload, "*"))} -DestinationPath ${quote(zip)}`]);
  } else {
    execFileSync("zip", ["-q", "-r", zip, "."], { cwd: payload });
  }
  return { root, zip, version, bytes };
}

function prepareInstall({ root, zip, version }, name, { platform = "darwin", arch = "arm64" } = {}) {
  const target = join(root, name);
  const electron = join(target, "node_modules/electron");
  mkdirSync(join(electron, "node_modules/@electron/get"), { recursive: true });
  // Copy the actual entry point so its createRequire resolves our disposable
  // package. No production dependency or user's cache is changed by the test.
  cpSync(join(here, "ensure-electron-runtime.mjs"), join(target, "install.mjs"));
  const helper = join(here, "electron-runtime-cache.mjs");
  try { cpSync(helper, join(target, "electron-runtime-cache.mjs")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  writeFileSync(join(electron, "package.json"), JSON.stringify({ name: "electron", version }));
  writeFileSync(join(electron, "checksums.json"), JSON.stringify({
    [`electron-v${version}-${platform}-${arch}.zip`]: hash(readFileSync(zip)),
  }));
  writeFileSync(join(electron, "node_modules/@electron/get/index.js"),
    `exports.downloadArtifact = async (options) => {
      require("fs").appendFileSync(${JSON.stringify(join(root, "requests.jsonl"))}, JSON.stringify(options) + "\\n");
      return ${JSON.stringify(zip)};
    };\n`);
  const options = {
    env: { ...process.env, PWRAGENT_HOME: join(root, "home"), npm_config_platform: platform, npm_config_arch: arch },
    stdio: "pipe",
  };
  return {
    electron,
    binary: join(electron, "dist", platformPath(platform)),
    run: () => execAsync(process.execPath, [join(target, "install.mjs")], options),
    runSync: () => execFileSync(process.execPath, [join(target, "install.mjs")], options),
  };
}

function installAt(setup, name) {
  const install = prepareInstall(setup, name);
  install.runSync();
  return install.binary;
}

it("runs the production entry point for the native host and reuses the same cache across project layouts", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  const host = { platform: process.platform, arch: process.arch };
  const installs = ["pwragent/apps/desktop", "pwrgit/app", "pwrsnap/desktop"].map((name) => prepareInstall(setup, name, host));
  const results = await Promise.allSettled(installs.map((install) => install.run()));
  for (const result of results) expect(result.status, result.reason?.stderr).toBe("fulfilled");
  for (const install of installs) expect(readFileSync(install.binary)).toEqual(setup.bytes);
  const cache = join(setup.root, "home/cache/electron-runtime/v1");
  const keys = readdirSync(cache).filter((name) => /^[a-f0-9]{64}$/.test(name));
  expect(keys).toHaveLength(1);
  const { identity } = JSON.parse(readFileSync(join(cache, keys[0], "runtime.json"), "utf8"));
  expect(identity).toMatchObject({ version: setup.version, ...host });
  const requests = readFileSync(join(setup.root, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(requests).toHaveLength(3);
  for (const request of requests) expect(request).toMatchObject({ version: setup.version, ...host });
}, 60_000);

it.skipIf(process.platform !== "darwin")("APFS oracle: repeated extraction shares blocks with independent writable files", () => {
  const setup = fixture();
  const probe = join(setup.root, "private-size");
  execFileSync("clang", [join(here, "fixtures/apfs-private-size.c"), "-o", probe]);
  const first = installAt(setup, "first");
  const second = installAt(setup, "second");
  const metadata = () => execFileSync(probe, [first, second], { encoding: "utf8" }).trim().split("\n").map(JSON.parse);
  expect(hash(readFileSync(first))).toBe(hash(readFileSync(second)));
  const [a, b] = metadata();
  expect(a.inode).not.toBe(b.inode);
  expect(a.cloneId).not.toBe("0");
  expect(a.cloneId).toBe(b.cloneId);
  expect(a.privateBytes + b.privateBytes).toBe(0);
  const original = hash(readFileSync(first));
  writeFileSync(second, randomBytes(1024 * 1024));
  expect(hash(readFileSync(first))).toBe(original);
  expect(metadata()[1].privateBytes).toBeGreaterThan(0);
}, 30_000);

function optionsFor(setup, electronDir = join(setup.root, "package"), overrides = {}) {
  mkdirSync(electronDir, { recursive: true });
  return {
    electronDir, version: setup.version, platform: "darwin", arch: "arm64",
    cacheRoot: join(setup.root, "cache"), expectedChecksum: hash(readFileSync(setup.zip)),
    download: async () => setup.zip, log: () => {}, ...overrides,
  };
}

it("property: cache entries partition every target dimension and archive identity", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.tuple(fc.constantFrom("darwin", "mas", "linux", "win32"), fc.constantFrom("arm64", "x64")), {
      minLength: 2, maxLength: 8, selector: JSON.stringify,
    }),
    async (targets) => {
      const cacheRoot = mkdtempSync(join(setup.root, "partition-"));
      for (const [platform, arch] of targets) {
        const opts = optionsFor(setup, join(cacheRoot, `package-${platform}-${arch}`), { cacheRoot, platform, arch });
        await ensureRuntime(opts);
        expect(readFileSync(join(opts.electronDir, "dist", platformPath(platform)))).toEqual(setup.bytes);
      }
      const manifests = readdirSync(cacheRoot).filter((name) => /^[a-f0-9]{64}$/.test(name))
        .map((name) => JSON.parse(readFileSync(join(cacheRoot, name, "runtime.json"), "utf8")));
      expect(manifests.map(({ identity }) => [identity.platform, identity.arch]).sort()).toEqual([...targets].sort());
    },
  ), { numRuns: 6 });
}, 60_000);

// Start a real installer, wait until it holds the lock, then kill it. Process
// identity, rather than elapsed time, is what allows a successor to recover.
async function killedLockOwner(root, electronDir) {
  const ready = join(mkdtempSync(join(root, "owner-")), "ready");
  const script = `
    import { ensureRuntime } from ${JSON.stringify(pathToFileURL(join(here, "electron-runtime-cache.mjs")).href)};
    import { writeFileSync } from "node:fs";
    await ensureRuntime({
      electronDir: ${JSON.stringify(electronDir)}, version: "44.10.1", platform: "darwin", arch: "arm64",
      cacheRoot: ${JSON.stringify(join(root, "home/cache/electron-runtime/v1"))},
      download: async () => {
        writeFileSync(${JSON.stringify(ready)}, "ready");
        await new Promise(() => { setInterval(() => {}, 1000); });
      },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(ready) && Date.now() < deadline && child.exitCode === null) await setTimeout(20);
    expect(existsSync(ready)).toBe(true); // Witness that the owner actually holds the lock.
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
}

it("recovers an OS-confirmed dead installer while concurrent successors preserve the new owner", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  const install = prepareInstall(setup, "interrupted");
  await killedLockOwner(setup.root, install.electron);
  const results = await Promise.allSettled([install.run(), install.run(), install.run()]);
  for (const result of results) expect(result.status, result.reason?.stderr).toBe("fulfilled");
  expect(readFileSync(install.binary)).toEqual(setup.bytes);
  expect(existsSync(join(install.electron, ".pwragent-runtime-lock"))).toBe(false);
}, 60_000);

// The rule: after an owner dies, every waiting installer gets the lock, one
// at a time, and none fails because another installer was recovering the same
// dead lock. The operating system is the oracle. Windows answers EPERM for a
// file or directory that another process is deleting at that instant; on
// windows-latest the pre-fix lock failed 20 of 150 runs of the test above.
// Each racer holds the lock only to journal its turn, so the lock changes
// hands as fast as it can and removals collide on every handover.
it("property: racing installers each recover a dead owner's lock and hold it alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "pwragent-electron-cache-"));
  roots.push(root);
  const racer = `
    import { ensureRuntime } from ${JSON.stringify(pathToFileURL(join(here, "electron-runtime-cache.mjs")).href)};
    import { appendFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    for await (const line of createInterface({ input: process.stdin })) {
      const { electronDir, journal, id, at } = JSON.parse(line);
      while (Date.now() < at) { /* Start every racer at its generated instant. */ }
      let outcome;
      try {
        await ensureRuntime({
          electronDir, version: "44.10.1", platform: "darwin", arch: "arm64",
          cacheRoot: ${JSON.stringify(join(root, "unused-cache"))}, log: () => {},
          download: async () => {
            appendFileSync(journal, "enter " + id + "\\n");
            await new Promise((resolveTurn) => { setImmediate(resolveTurn); });
            appendFileSync(journal, "exit " + id + "\\n");
            throw Object.assign(new Error("turn taken"), { code: "TURN_TAKEN" });
          },
        });
        outcome = "installed without taking a turn";
      } catch (error) {
        outcome = error.code === "TURN_TAKEN" ? "turn taken" : String(error.stack);
      }
      process.stdout.write(JSON.stringify(outcome) + "\\n");
    }
  `;
  const racers = Array.from({ length: 6 }, () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", racer], { stdio: ["pipe", "pipe", "inherit"] });
    return { child, replies: createInterface({ input: child.stdout })[Symbol.asyncIterator]() };
  });
  try {
    await fc.assert(fc.asyncProperty(
      // One start offset, in milliseconds, for each racing installer.
      fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 3, maxLength: racers.length }),
      async (offsets) => {
        const electronDir = mkdtempSync(join(root, "package-"));
        const journal = join(electronDir, "journal");
        await killedLockOwner(root, electronDir);
        const at = Date.now() + 20;
        const racing = racers.slice(0, offsets.length);
        racing.forEach(({ child }, id) => child.stdin.write(`${JSON.stringify({ electronDir, journal, id, at: at + offsets[id] })}\n`));
        const outcomes = [];
        for (const { replies } of racing) outcomes.push(JSON.parse((await replies.next()).value));
        expect(outcomes).toEqual(offsets.map(() => "turn taken"));
        // A turn that another racer entered before it ended is two owners.
        const turns = readFileSync(journal, "utf8").trim().split("\n");
        const order = turns.filter((turn) => turn.startsWith("enter ")).map((turn) => turn.slice("enter ".length));
        expect(turns).toEqual(order.flatMap((id) => [`enter ${id}`, `exit ${id}`]));
        expect([...order].sort()).toEqual(offsets.map((_, id) => String(id)));
        expect(existsSync(join(electronDir, ".pwragent-runtime-lock"))).toBe(false);
      },
    ), { numRuns: 30, endOnFailure: true }); // A race does not shrink: a replay is a new race.
  } finally {
    for (const { child } of racers) child.kill("SIGKILL");
  }
}, 120_000);

it("property: any changed cached payload is rejected and rebuilt from the verified archive", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  const mutations = process.platform === "win32" ? ["bytes", "add", "remove"] : ["bytes", "mode", "add", "remove", "link"];
  await fc.assert(fc.asyncProperty(fc.constantFrom(...mutations), fc.uint8Array({ minLength: 1, maxLength: 1024 }), async (kind, data) => {
    const cacheRoot = mkdtempSync(join(setup.root, "tamper-"));
    const a = optionsFor(setup, join(cacheRoot, "a"), { cacheRoot });
    await ensureRuntime(a);
    const key = readdirSync(cacheRoot).find((name) => /^[a-f0-9]{64}$/.test(name));
    const dist = join(cacheRoot, key, "dist");
    const file = join(dist, "Electron.app/Contents/MacOS/Electron");
    if (kind === "bytes") writeFileSync(file, data);
    if (kind === "mode") chmodSync(file, 0o600);
    if (kind === "add") writeFileSync(join(dist, "unexpected"), data);
    if (kind === "remove") rmSync(file);
    if (kind === "link") { rmSync(file); symlinkSync("../../../electron", file); }
    const corrupted = await inventory(dist);
    const b = optionsFor(setup, join(cacheRoot, "b"), { cacheRoot });
    await ensureRuntime(b);
    expect(await inventory(join(b.electronDir, "dist"))).toEqual(await inventory(join(a.electronDir, "dist")));
    expect(await inventory(dist)).toEqual(corrupted); // Preserve corrupt cache for diagnosis.
    expect(lstatSync(join(b.electronDir, "dist/Electron.app/Contents/MacOS/Electron")).isFile()).toBe(true);
  }), { numRuns: 12 });
}, 60_000);

it("revalidates target changes, keeps installed runtimes usable offline, and repairs incomplete installs", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  const opts = optionsFor(setup);
  await ensureRuntime(opts);
  const before = lstatSync(join(opts.electronDir, "dist/electron"));
  await ensureRuntime({ ...opts, download: () => { throw new Error("offline"); } });
  expect(lstatSync(join(opts.electronDir, "dist/electron")).ino).toBe(before.ino);
  let downloads = 0;
  await ensureRuntime({ ...opts, arch: "x64", download: async () => { downloads++; return setup.zip; } });
  expect(downloads).toBe(1);
  writeFileSync(join(opts.electronDir, "dist/electron"), "incomplete");
  await ensureRuntime({ ...opts, arch: "x64" });
  expect(readFileSync(join(opts.electronDir, "dist/electron"))).toEqual(setup.bytes);
  expect(readFileSync(join(opts.electronDir, "electron.d.ts"), "utf8")).toBe("// fixture types\n");
  rmSync(join(opts.electronDir, "electron.d.ts"));
  await ensureRuntime({ ...opts, arch: "x64" });
  expect(readFileSync(join(opts.electronDir, "electron.d.ts"), "utf8")).toBe("// fixture types\n");
});

it("separates versions and archive digests, rejecting unverified artifacts without damaging an install", async () => {
  const first = fixture("44.9.3", randomBytes(8192));
  const second = fixture("44.10.1", randomBytes(8192));
  const third = fixture("44.10.1", randomBytes(8192));
  const opts = optionsFor(first);
  await ensureRuntime(opts);
  const before = await inventory(join(opts.electronDir, "dist"));
  await expect(ensureRuntime({ ...opts, version: second.version, download: async () => second.zip })).rejects.toThrow("checksum mismatch");
  expect(await inventory(join(opts.electronDir, "dist"))).toEqual(before);
  await ensureRuntime(optionsFor(second, opts.electronDir, { cacheRoot: opts.cacheRoot }));
  await ensureRuntime(optionsFor(third, opts.electronDir, { cacheRoot: opts.cacheRoot }));
  expect(readFileSync(join(opts.electronDir, "dist/version"), "utf8")).toBe(second.version);
  expect(readFileSync(join(opts.electronDir, "dist/electron"))).toEqual(third.bytes);
  expect(readdirSync(opts.cacheRoot).filter((name) => /^[a-f0-9]{64}$/.test(name))).toHaveLength(3);
});

it("uses isolated extraction when the cache is unavailable and releases the lock after errors", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  const cacheRoot = join(setup.root, "not-a-directory");
  writeFileSync(cacheRoot, "user data");
  const opts = optionsFor(setup, undefined, { cacheRoot });
  await expect(ensureRuntime({ ...opts, download: () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
  expect(existsSync(join(opts.electronDir, ".pwragent-runtime-lock"))).toBe(false);
  await ensureRuntime(opts);
  expect(readFileSync(join(opts.electronDir, "dist/electron"))).toEqual(setup.bytes);
  expect(readFileSync(cacheRoot, "utf8")).toBe("user data");
});

it("property: denied external ZIP-cache writes fall back to owned worktree paths", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  await fc.assert(fc.asyncProperty(fc.constantFrom("EACCES", "EPERM", "EROFS"), async (code) => {
    const electronDir = mkdtempSync(join(setup.root, "restricted-package-"));
    const calls = [];
    const opts = optionsFor(setup, electronDir, {
      download: async (options) => {
        calls.push(options);
        if (calls.length === 1) throw Object.assign(new Error("External ZIP cache is unwritable"), { code });
        return setup.zip;
      },
    });
    await ensureRuntime(opts);
    expect(calls).toHaveLength(2);
    expect(dirname(calls[0].tempDirectory)).toBe(electronDir);
    expect(calls[1].tempDirectory).toBe(calls[0].tempDirectory);
    expect(calls[1].cacheRoot).toBe(join(calls[0].tempDirectory, "cache"));
    expect(existsSync(calls[0].tempDirectory)).toBe(false);
    expect(readFileSync(join(electronDir, "dist/electron"))).toEqual(setup.bytes);
  }), { numRuns: 6 });
}, 60_000);

it("does not retry network failures as cache permission failures", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  const calls = [];
  const opts = optionsFor(setup, undefined, {
    download: async (options) => {
      calls.push(options);
      throw Object.assign(new Error("Network failed"), { code: "ECONNRESET" });
    },
  });
  await expect(ensureRuntime(opts)).rejects.toThrow("Network failed");
  expect(calls).toHaveLength(1);
  expect(existsSync(calls[0].tempDirectory)).toBe(false);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("real @electron/get installs with both external caches write-denied", async () => {
  const setup = fixture("44.10.1", randomBytes(8192));
  const require = createRequire(import.meta.url);
  const { downloadArtifact } = createRequire(require.resolve("electron/package.json"))("@electron/get");
  const zipCache = join(setup.root, "external-zip-cache");
  const extractionCache = join(setup.root, "external-extraction-cache");
  for (const path of [zipCache, extractionCache]) { mkdirSync(path); chmodSync(path, 0o555); }
  const denied = [];
  const calls = [];
  const opts = optionsFor(setup, join(setup.root, "worktree/node_modules/electron"), {
    cacheRoot: extractionCache,
    download: async (options) => {
      calls.push(options);
      try {
        return await downloadArtifact({
          version: setup.version, artifactName: "electron", platform: "darwin", arch: "arm64",
          checksums: { [`electron-v${setup.version}-darwin-arm64.zip`]: hash(readFileSync(setup.zip)) },
          cacheRoot: zipCache,
          // Real checksum/cache handling; replace only HTTP with a local ZIP.
          downloader: { download: async (_url, destination) => { copyFileSync(setup.zip, destination); } },
          ...options,
        });
      } catch (error) { denied.push(error.code); throw error; }
    },
  });
  try {
    await ensureRuntime(opts);
    expect(denied).toEqual(["EACCES"]);
    expect(calls).toHaveLength(2);
    expect(dirname(calls[0].tempDirectory)).toBe(opts.electronDir);
    expect(calls[1].cacheRoot).toBe(join(calls[0].tempDirectory, "cache"));
    expect(existsSync(calls[0].tempDirectory)).toBe(false);
    expect(readFileSync(join(opts.electronDir, "dist/electron"))).toEqual(setup.bytes);
    expect(readdirSync(zipCache)).toEqual([]);
    expect(readdirSync(extractionCache)).toEqual([]);
  } finally {
    for (const path of [zipCache, extractionCache]) chmodSync(path, 0o755);
  }
}, 30_000);

it("concurrent processes publish one shared cache and serialize writes to the same package", async () => {
  const setup = fixture();
  const installs = ["one", "two", "three"].map((name) => prepareInstall(setup, name));
  const results = await Promise.allSettled([...installs.map((install) => install.run()), installs[0].run(), installs[0].run()]);
  for (const result of results) expect(result.status, result.reason?.stderr).toBe("fulfilled");
  for (const install of installs) {
    expect(readFileSync(install.binary)).toEqual(setup.bytes);
    expect(existsSync(join(install.electron, ".pwragent-runtime-lock"))).toBe(false);
  }
  const requests = readFileSync(join(setup.root, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  expect(requests).toHaveLength(3);
  expect(requests.every((request) => request.version === setup.version && request.platform === "darwin" && request.arch === "arm64")).toBe(true);
  if (process.platform === "darwin") {
    const probe = join(setup.root, "private-size");
    execFileSync("clang", [join(here, "fixtures/apfs-private-size.c"), "-o", probe]);
    const metadata = execFileSync(probe, installs.map((install) => install.binary), { encoding: "utf8" }).trim().split("\n").map(JSON.parse);
    expect(new Set(metadata.map(({ inode }) => inode)).size).toBe(3);
    expect(new Set(metadata.map(({ cloneId }) => cloneId)).size).toBe(1);
    expect(metadata.reduce((sum, { privateBytes }) => sum + privateBytes, 0)).toBe(0);
  }
}, 60_000);
