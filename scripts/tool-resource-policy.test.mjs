import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { isAncestorPid, MACHINE_TOOL_LOCK, OWNER_ENV, processStartedAt, runResourceCommand } from "./resource-run.mjs";
import { runSqliteWriteTests } from "./run-sqlite-write-report.mjs";
import {
  GIB,
  cappedNodeOptions,
  getToolResourcePolicy,
  readCgroupMemoryLimits,
  resourceCommand,
  resourceEnvironment,
  toolHeapMiB,
} from "./tool-resource-policy.mjs";

const temporaryDirectories = [];
const low = getToolResourcePolicy({ hostMemory: 12 * GIB, constrainedMemory: 0, cgroupLimits: [] });
const high = getToolResourcePolicy({ hostMemory: 32 * GIB, constrainedMemory: 0, cgroupLimits: [] });

// Call the public API from an independent process with a private fixture
// lease. There is no production env override/bypass for the global lane.
async function startFixture(directory, args, { env = process.env, lockPath = path.join(directory, "lock"), policy = low, cwd = directory } = {}) {
  const entry = path.join(directory, `fixture-${Math.random()}.mjs`);
  await writeFile(entry, `import { runResourceCommand } from ${JSON.stringify(new URL("./resource-run.mjs", import.meta.url).href)};
const result = await runResourceCommand(process.execPath, ${JSON.stringify(args)}, {
  policy: ${JSON.stringify(policy)}, lockPath: ${JSON.stringify(lockPath)}, cwd: ${JSON.stringify(cwd)}, log: () => {}, stdio: "ignore",
});
if (result.signal) { setTimeout(() => process.exit(1), 1000); process.kill(process.pid, result.signal); }
else process.exitCode = result.code ?? 1;`);
  const child = spawn(process.execPath, [entry], { env, stdio: "ignore" });
  child.exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return child;
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { return await readFile(file, "utf8"); } catch { await delay(25); }
  }
  throw new Error(`Missing fixture marker: ${file}`);
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "pwragent-resource-policy-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("machine memory policy", () => {
  it.each([8, 12, 15])("limits a %i GiB host", (size) => {
    expect(getToolResourcePolicy({ hostMemory: size * GIB, constrainedMemory: 0, cgroupLimits: [] }).constrained).toBe(true);
  });

  it.each([16, 24, 32])("preserves a %i GiB host", (size) => {
    expect(getToolResourcePolicy({ hostMemory: size * GIB, constrainedMemory: 0, cgroupLimits: [] }).constrained).toBe(false);
  });

  it("uses the lesser of the host and all container limits", () => {
    expect(getToolResourcePolicy({ hostMemory: 32 * GIB, constrainedMemory: 20 * GIB, cgroupLimits: [8 * GIB, 12 * GIB] })).toEqual({
      hostMemory: 32 * GIB, effectiveMemory: 8 * GIB, constrained: true,
    });
    expect(getToolResourcePolicy({ hostMemory: 12 * GIB, constrainedMemory: 32 * GIB, cgroupLimits: [-1, Infinity] }).effectiveMemory).toBe(12 * GIB);
  });

  it("reads parent cgroup v2 limits even when the leaf is unlimited", () => {
    const files = {
      "/proc/self/cgroup": "0::/user.slice/app.slice/tool\n",
      "/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
      "/sys/fs/cgroup/user.slice/app.slice/tool/memory.max": "max",
      "/sys/fs/cgroup/user.slice/app.slice/memory.max": "8589934592",
      "/sys/fs/cgroup/user.slice/memory.max": "12884901888",
      "/sys/fs/cgroup/memory.max": "max",
    };
    expect(readCgroupMemoryLimits((file) => files[file] ?? "", "linux")).toEqual([8 * GIB, 12 * GIB]);
  });

  it("supports namespaced roots and cgroup v1 memory controllers", () => {
    const files = {
      "/proc/self/cgroup": "2:cpu,memory:/\n",
      "/proc/self/mountinfo": "1 0 0:1 /docker/container /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "4294967296",
    };
    expect(readCgroupMemoryLimits((file) => files[file] ?? "", "linux")).toEqual([4 * GIB]);
    expect(readCgroupMemoryLimits(() => { throw new Error("not readable"); }, "linux")).toEqual([]);
    expect(readCgroupMemoryLimits(() => { throw new Error("must not read"); }, "darwin")).toEqual([]);
  });

  it("handles cgroup mounts rooted at an ancestor and escaped mount paths", () => {
    const files = {
      "/proc/self/cgroup": "0::/pod/container\n",
      "/proc/self/mountinfo": "1 0 0:1 /pod /custom\\040cgroup rw - cgroup2 cgroup rw\n",
      "/custom cgroup/container/memory.max": "max",
      "/custom cgroup/memory.max": "8589934592",
    };
    expect(readCgroupMemoryLimits((file) => files[file] ?? "", "linux")).toEqual([8 * GIB]);
  });

  it.each([
    "--max-old-space-size=6144",
    "--max_old_space_size 6144",
    '"--max-old-space-size=6144"',
    "--max-old-space-size-percentage=90 --max-old-space-size=6144",
  ])("replaces conflicting heap settings: %s", (options) => {
    expect(cappedNodeOptions(options)).toBe("--max-old-space-size=2048");
  });

  it("preserves unrelated options and quoted paths", () => {
    expect(cappedNodeOptions('--require "/path with spaces/init.cjs" --trace-warnings --max-old-space-size=6144'))
      .toBe('--require "/path with spaces/init.cjs" --trace-warnings --max-old-space-size=2048');
  });

  it("limits recursive pnpm and test workers only on small machines", () => {
    const args = ["-r", "--if-present", "typecheck"];
    expect(resourceCommand("pnpm", args, low)).toEqual(["--workspace-concurrency=1", ...args]);
    expect(resourceCommand("pnpm", args, high)).toBe(args);
    expect(resourceCommand("vitest", ["run"], low)).toEqual(["run", "--maxWorkers=1", "--maxConcurrency=1", "--no-file-parallelism"]);
    expect(resourceCommand("playwright", ["test"], low)).toEqual(["test", "--workers=1"]);
  });
});

describe("resource command ownership", () => {
  it("keeps the environment and exit status on a large machine", async () => {
    const directory = await fixture();
    const output = path.join(directory, "env.json");
    const env = { ...process.env, NODE_OPTIONS: "--max-old-space-size=6144 --trace-warnings" };
    const result = await runResourceCommand(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env)); process.exitCode = 7`], {
      policy: high, env, lockPath: path.join(directory, "lock"), stdio: "ignore",
      log: () => { throw new Error("Large machine must not report a limit"); },
    });
    expect(result).toEqual({ code: 7, signal: null });
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(env);
    await expect(readFile(path.join(directory, "lock.lock"))).rejects.toThrow();
  });

  it("serializes commands from separate working directories", async () => {
    const directory = await fixture();
    const output = path.join(directory, "events");
    const first = path.join(directory, "first");
    const second = path.join(directory, "second");
    await mkdir(first);
    await mkdir(second);
    const task = (name) => ["-e", `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(output)}, '${name}:start\\n'); setTimeout(() => fs.appendFileSync(${JSON.stringify(output)}, '${name}:end\\n'), 300)`];
    const options = { policy: low, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=6144" }, lockPath: path.join(directory, "lock"), stdio: "ignore", log: () => {} };
    const results = await Promise.all([
      runResourceCommand(process.execPath, task("a"), { ...options, cwd: first }),
      runResourceCommand(process.execPath, task("b"), { ...options, cwd: second }),
    ]);
    expect(results).toEqual([{ code: 0, signal: null }, { code: 0, signal: null }]);
    const events = (await readFile(output, "utf8")).trim().split("\n");
    expect(events).toEqual(events[0] === "a:start"
      ? ["a:start", "a:end", "b:start", "b:end"]
      : ["b:start", "b:end", "a:start", "a:end"]);
  });

  it("recovers an abandoned lock", async () => {
    const directory = await fixture();
    const lockPath = path.join(directory, "lock");
    await mkdir(`${lockPath}.lock`);
    const old = new Date(Date.now() - 60_000);
    await utimes(`${lockPath}.lock`, old, old);
    expect(await runResourceCommand(process.execPath, ["-e", "process.exit(0)"], {
      policy: low, env: {}, lockPath, stdio: "ignore", log: () => {},
    })).toEqual({ code: 0, signal: null });
  });

  it("releases the lock when a command cannot start", async () => {
    const directory = await fixture();
    const options = { policy: low, env: {}, lockPath: path.join(directory, "lock"), stdio: "ignore", log: () => {} };
    const result = await runResourceCommand(path.join(directory, "missing-command"), [], options);
    expect(result.code).not.toBe(0);
    expect(await runResourceCommand(process.execPath, ["-e", "process.exit(0)"], options)).toEqual({ code: 0, signal: null });
  });

  it("allows nested wrappers to finish without reacquiring their parent's lock", async () => {
    const directory = await fixture();
    const nested = path.join(directory, "nested.mjs");
    const lockPath = path.join(directory, "lock");
    await writeFile(nested, `import { runResourceCommand } from ${JSON.stringify(new URL("./resource-run.mjs", import.meta.url).href)};
const result = await runResourceCommand(process.execPath, ["-e", "process.exit(0)"], {
  policy: ${JSON.stringify(low)}, lockPath: ${JSON.stringify(lockPath)}, stdio: "ignore", log: () => {},
});
process.exitCode = result.code ?? 1;`);
    const child = await startFixture(directory, [nested]);
    expect(await child.exited).toEqual({ code: 0, signal: null });
  }, process.platform === "win32" ? 30_000 : 10_000);

  it.skipIf(process.platform === "win32")("cancels a running process group and frees the queue", async () => {
    const directory = await fixture();
    const marker = path.join(directory, "ready");
    const env = { ...process.env };
    delete env[OWNER_ENV];
    const child = await startFixture(directory, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000)`], { env });
    try {
      expect(await waitForFile(marker)).toBe("ready");
      child.kill("SIGTERM");
      expect(await child.exited).toEqual({ code: null, signal: "SIGTERM" });
      expect(await runResourceCommand(process.execPath, ["-e", "process.exit(0)"], {
        policy: low, env, lockPath: path.join(directory, "lock"), stdio: "ignore", log: () => {},
      })).toEqual({ code: 0, signal: null });
    } finally { child.kill("SIGKILL"); await child.exited; }
  }, 15_000);
});

describe("policy boundaries and overrides", () => {
  it.each([16 * GIB - 1, 16 * GIB, 16 * GIB + 1])("uses the strict byte boundary at %i bytes", (bytes) => {
    expect(getToolResourcePolicy({ hostMemory: bytes, constrainedMemory: 0, cgroupLimits: [] }).constrained).toBe(bytes < 16 * GIB);
    expect(getToolResourcePolicy({ hostMemory: 64 * GIB, constrainedMemory: bytes, cgroupLimits: [] }).constrained).toBe(bytes < 16 * GIB);
  });

  it("reads all v1 ancestors and ignores unlimited/sentinel capacities above the host", () => {
    const files = {
      "/proc/self/cgroup": "4:cpu:/other\n2:memory:/parent/child\n",
      "/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n",
      "/sys/fs/cgroup/memory/parent/child/memory.limit_in_bytes": "9223372036854771712",
      "/sys/fs/cgroup/memory/parent/memory.limit_in_bytes": `${8 * GIB}`,
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${10 * GIB}`,
    };
    const limits = readCgroupMemoryLimits((file) => files[file] ?? "", "linux");
    expect(getToolResourcePolicy({ hostMemory: 32 * GIB, constrainedMemory: 0, cgroupLimits: limits }).effectiveMemory).toBe(8 * GIB);
    expect(getToolResourcePolicy({ hostMemory: 4 * GIB, constrainedMemory: 0, cgroupLimits: limits }).effectiveMemory).toBe(4 * GIB);
  });

  it("uses 4 GiB only for full TypeScript and typed ESLint; keeps other tools at 2 GiB", () => {
    expect(toolHeapMiB("tsc", ["--noEmit"], path.join(import.meta.dirname, "../apps/desktop"))).toBe(4096);
    expect(toolHeapMiB("tsc", ["--noEmit"], path.join(import.meta.dirname, "../packages/shared"))).toBe(2048);
    expect(toolHeapMiB("eslint", ["--config", "eslint.typed.config.mjs"])).toBe(4096);
    expect(toolHeapMiB("eslint", ["--config=./eslint.typed.config.mjs"])).toBe(4096);
    expect(toolHeapMiB("eslint", ["--cache"])).toBe(2048);
    expect(toolHeapMiB("vitest", ["run"])).toBe(2048);
    expect(cappedNodeOptions("--trace-warnings --max-old-space-size-percentage 90", 4096))
      .toBe("--trace-warnings --max-old-space-size=4096");
  });

  it("replaces CLI heap overrides without changing script or eval arguments", () => {
    expect(resourceCommand("node", ["--max_old_space_size", "6144", "--trace-warnings", "script.mjs", "--max-old-space-size=7000"], low))
      .toEqual(["--max-old-space-size=2048", "--trace-warnings", "script.mjs", "--max-old-space-size=7000"]);
    expect(resourceCommand("node", ["--max-old-space-size-percentage=90", "-e", "--max-old-space-size=6144"], low))
      .toEqual(["--max-old-space-size=2048", "-e", "--max-old-space-size=6144"]);
    const args = ["--max-old-space-size=6144", "-e", "0"];
    expect(resourceCommand("node", args, high)).toBe(args);
  });

  it("replaces conflicting concurrency instead of appending duplicate options", () => {
    expect(resourceCommand("pnpm", ["-r", "--workspace-concurrency", "10", "typecheck"], low))
      .toEqual(["--workspace-concurrency=1", "-r", "typecheck"]);
    expect(resourceCommand("vitest", ["run", "--maxWorkers", "8", "--minWorkers=4", "--maxConcurrency=9", "--fileParallelism=true"], low))
      .toEqual(["run", "--maxWorkers=1", "--maxConcurrency=1", "--no-file-parallelism"]);
    expect(resourceCommand("playwright", ["test", "-j", "5"], low)).toEqual(["test", "--workers=1"]);
    for (const command of ["pnpm", "vitest", "playwright", "node"]) {
      const args = ["test", "--workers=6"];
      expect(resourceCommand(command, args, high)).toBe(args);
    }
  });

  it("anchors the common lane in the user's home, independently of TMPDIR", () => {
    expect(MACHINE_TOOL_LOCK).toMatch(/[/\\]\.cache[/\\]pwragent-tools-[a-f0-9]{16}[/\\]heavy-tool$/);
  });

  it("rejects unrelated, missing, cyclic and unreadable ancestor chains", () => {
    expect(isAncestorPid(2, 5, (pid) => ({ 5: 3, 3: 2, 2: 1 })[pid])).toBe(true);
    expect(isAncestorPid(6, 5, (pid) => ({ 5: 3, 3: 1, 1: 0 })[pid])).toBe(false);
    expect(isAncestorPid(2, 5, () => 5)).toBe(false);
    expect(isAncestorPid(2, 5, () => { throw new Error("gone"); })).toBe(false);
  });
});

describe("independent process leases", () => {
  it("queues processes in separate worktrees with the same lane", async () => {
    const directory = await fixture();
    const output = path.join(directory, "events");
    const task = (name) => ["-e", `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(output)}, '${name}:start\\n'); setTimeout(() => fs.appendFileSync(${JSON.stringify(output)}, '${name}:end\\n'), 200)`];
    const first = path.join(directory, "first-worktree");
    const second = path.join(directory, "second-worktree");
    await mkdir(first); await mkdir(second);
    const a = await startFixture(directory, task("a"), { cwd: first });
    const b = await startFixture(directory, task("b"), { cwd: second });
    try {
      expect(await Promise.all([a.exited, b.exited])).toEqual([{ code: 0, signal: null }, { code: 0, signal: null }]);
      const events = (await readFile(output, "utf8")).trim().split("\n");
      expect(events).toEqual(events[0] === "a:start" ? ["a:start", "a:end", "b:start", "b:end"] : ["b:start", "b:end", "a:start", "a:end"]);
    } finally { a.kill("SIGKILL"); b.kill("SIGKILL"); }
  }, 15_000);

  it.skipIf(process.platform === "win32")("does not let a waiting cancellation steal or release the holder's lease", async () => {
    const directory = await fixture();
    const marker = path.join(directory, "ready");
    const never = path.join(directory, "must-not-run");
    const a = await startFixture(directory, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000)`]);
    let b;
    try {
      await waitForFile(marker);
      const before = await readFile(path.join(directory, "lock.owner.json"), "utf8");
      b = await startFixture(directory, ["-e", `require('fs').writeFileSync(${JSON.stringify(never)}, 'bad')`]);
      await delay(350);
      b.kill("SIGTERM");
      expect(await b.exited).toEqual({ code: null, signal: "SIGTERM" });
      expect(await readFile(path.join(directory, "lock.owner.json"), "utf8")).toBe(before);
      await expect(readFile(never)).rejects.toThrow();
    } finally { a.kill("SIGTERM"); await a.exited; b?.kill("SIGKILL"); }
  }, 15_000);

  it.skipIf(process.platform === "win32")("recovers a SIGKILL owner and terminates its surviving process group", async () => {
    const directory = await fixture();
    const marker = path.join(directory, "ready");
    const a = await startFixture(directory, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`]);
    try {
      const groupPid = Number(await waitForFile(marker));
      a.kill("SIGKILL");
      await a.exited;
      const old = new Date(Date.now() - 60_000);
      await utimes(path.join(directory, "lock.lock"), old, old);
      const b = await startFixture(directory, ["-e", "process.exit(0)"]);
      expect(await b.exited).toEqual({ code: 0, signal: null });
      // Zombies have exited but can remain visible until the OS parent reaps.
      try {
        const stat = await readFile(`/proc/${groupPid}/stat`, "utf8");
        expect(stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")).toBe(true);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    } finally { a.kill("SIGKILL"); }
  }, 15_000);

  it("rejects forged inherited ownership even when the alleged owner PID is live", async () => {
    const directory = await fixture();
    const marker = path.join(directory, "ready");
    const output = path.join(directory, "second");
    const a = await startFixture(directory, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000)`]);
    let b;
    try {
      await waitForFile(marker);
      const owner = JSON.parse(await readFile(path.join(directory, "lock.owner.json"), "utf8"));
      b = await startFixture(directory, ["-e", `require('fs').writeFileSync(${JSON.stringify(output)}, 'done')`], {
        env: { ...process.env, [OWNER_ENV]: JSON.stringify(owner) },
      });
      await delay(350);
      await expect(readFile(output)).rejects.toThrow();
      a.kill("SIGTERM"); await a.exited;
      expect(await b.exited).toEqual({ code: 0, signal: null });
      expect(await readFile(output, "utf8")).toBe("done");
    } finally { a.kill("SIGKILL"); b?.kill("SIGKILL"); }
  }, 15_000);
});

describe("real runner integration", () => {
  it.each(["-e", "--eval", "-p", "--print", "-pe"])("caps heap flags after the %s expression in actual Node", async (flag) => {
    const directory = await fixture();
    const output = path.join(directory, "heap");
    const baselineFile = path.join(directory, "baseline");
    const program = (file) => `require('fs').writeFileSync(${JSON.stringify(file)}, String(require('v8').getHeapStatistics().heap_size_limit))`;
    expect(await runResourceCommand(process.execPath, [flag, program(output), "--max-old-space-size=6144", "--max-old-space-size-percentage=90"], {
      policy: low, env: { ...process.env, NODE_OPTIONS: "--trace-warnings --max-old-space-size=6144" },
      lockPath: path.join(directory, "lock"), stdio: "ignore", log: () => {},
    })).toEqual({ code: 0, signal: null });
    const baseline = spawn(process.execPath, ["--max-old-space-size=2048", "-e", program(baselineFile)], {
      env: { ...process.env, NODE_OPTIONS: "" }, stdio: "ignore",
    });
    expect(await new Promise((resolve, reject) => { baseline.once("error", reject); baseline.once("close", resolve); })).toBe(0);
    expect(await readFile(output, "utf8")).toBe(await readFile(baselineFile, "utf8"));
  }, 30_000);

  it("enforces the Node heap despite an explicit CLI override", async () => {
    const directory = await fixture();
    const output = path.join(directory, "heap");
    const result = await runResourceCommand(process.execPath, ["--max-old-space-size=6144", "-e",
      `require('fs').writeFileSync(${JSON.stringify(output)}, String(require('v8').getHeapStatistics().heap_size_limit / 1024 ** 2))`], {
      policy: low, env: { ...process.env, NODE_OPTIONS: "--trace-warnings --max-old-space-size=6144" },
      lockPath: path.join(directory, "lock"), stdio: "ignore", log: () => {},
    });
    expect(result).toEqual({ code: 0, signal: null });
    const heap = Number(await readFile(output, "utf8"));
    const baselineFile = path.join(directory, "baseline");
    const baseline = spawn(process.execPath, ["--max-old-space-size=2048", "-e",
      `require('fs').writeFileSync(${JSON.stringify(baselineFile)}, String(require('v8').getHeapStatistics().heap_size_limit / 1024 ** 2))`], {
      env: { ...process.env, NODE_OPTIONS: "" }, stdio: "ignore",
    });
    expect(await new Promise((resolve, reject) => { baseline.once("error", reject); baseline.once("close", resolve); })).toBe(0);
    expect(heap).toBe(Number(await readFile(baselineFile, "utf8")));
  }, 30_000);

  it("keeps pnpm concurrency options before the script name in real recursive execution", async () => {
    const directory = await fixture();
    const workspace = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "resource-fixture", private: true, packageManager: workspace.packageManager }));
    await writeFile(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - leaf-*\n");
    const events = path.join(directory, "events");
    for (const name of ["leaf-a", "leaf-b"]) {
      await mkdir(path.join(directory, name));
      await writeFile(path.join(directory, name, "package.json"), JSON.stringify({
        name: `resource-fixture-${name}`, private: true,
        scripts: { verify: "node verify.cjs" },
      }));
      await writeFile(path.join(directory, name, "verify.cjs"), `
if (process.argv.length !== 2) process.exit(9);
if (!process.env.NODE_OPTIONS.includes('--max-old-space-size=2048')) process.exit(10);
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(events)}, '${name}:start\\n');
setTimeout(() => fs.appendFileSync(${JSON.stringify(events)}, '${name}:end\\n'), 200);
`);
    }
    expect(await runResourceCommand("pnpm", ["-r", "--parallel", "--node-options=--trace-warnings --max-old-space-size-percentage=90", "--if-present", "verify"], {
      cwd: directory, policy: low, lockPath: path.join(directory, "lock"), stdio: "ignore", log: () => {},
    })).toEqual({ code: 0, signal: null });
    const lines = (await readFile(events, "utf8")).trim().split("\n");
    expect(lines).toEqual(lines[0] === "leaf-a:start"
      ? ["leaf-a:start", "leaf-a:end", "leaf-b:start", "leaf-b:end"]
      : ["leaf-b:start", "leaf-b:end", "leaf-a:start", "leaf-a:end"]);
  }, 30_000);

  it("caps pnpm's explicit Node environment options too", () => {
    const args = ["-r", "--node-options", "--trace-warnings --max-old-space-size-percentage=90", "verify"];
    expect(resourceCommand("pnpm", args, low)).toEqual(["--workspace-concurrency=1", "-r", "verify"]);
    expect(resourceEnvironment("pnpm", args, { NODE_OPTIONS: "--max-old-space-size=6144" }, low).NODE_OPTIONS)
      .toBe("--trace-warnings --max-old-space-size=2048");
    const env = { NODE_OPTIONS: "--max-old-space-size=6144" };
    expect(resourceCommand("pnpm", args, high)).toBe(args);
    expect(resourceEnvironment("pnpm", args, env, high)).toBe(env);
  });
});

describe("parallel and option-prefix escapes", () => {
  it("preserves heap-shaped Node option operands and application arguments", () => {
    expect(cappedNodeOptions('--title "--max-old-space-size=6144" --max-old-space-size=6144'))
      .toBe('--title "--max-old-space-size=6144" --max-old-space-size=2048');
    expect(resourceCommand("node", ["--title", "--max-old-space-size=6144", "--max-old-space-size=6144", "app.mjs"], low))
      .toEqual(["--max-old-space-size=2048", "--title", "--max-old-space-size=6144", "app.mjs"]);
    for (const args of [
      ["-e", "code", "argument", "--max-old-space-size=6144"],
      ["-e", "code", "--", "--max-old-space-size=6144"],
      ["-", "--max-old-space-size=6144"],
    ]) {
      expect(resourceCommand("node", args, low)).toEqual(["--max-old-space-size=2048", ...args]);
      expect(resourceCommand("node", args, high)).toBe(args);
    }
  });

  it.each(["--eval=code", "--print=code"])("removes startup heap flags after inline %s", (flag) => {
    const args = [flag, "--max-old-space-size-percentage", "90", "--max_old_space_size=6144"];
    expect(resourceCommand("node", args, low)).toEqual(["--max-old-space-size=2048", flag]);
    expect(resourceCommand("node", args, high)).toBe(args);
  });

  it("removes pnpm parallel overrides and boolean option values", () => {
    expect(resourceCommand("pnpm", ["-r", "--parallel", "true", "typecheck"], low)).toEqual(["--workspace-concurrency=1", "-r", "typecheck"]);
    expect(resourceCommand("pnpm", ["--recursive", "--parallel=true", "typecheck"], low)).toEqual(["--workspace-concurrency=1", "--recursive", "typecheck"]);
    expect(resourceCommand("vitest", ["run", "--fileParallelism", "true", "selected.test.ts"], low))
      .toEqual(["run", "selected.test.ts", "--maxWorkers=1", "--maxConcurrency=1", "--no-file-parallelism"]);
  });

  it("retains Node value options while capping subsequent V8 flags", () => {
    expect(resourceCommand("node", ["--conditions", "development", "--require", "init.cjs", "--max-old-space-size=6144", "app.mjs"], low))
      .toEqual(["--max-old-space-size=2048", "--conditions", "development", "--require", "init.cjs", "app.mjs"]);
    expect(resourceCommand("node", ["--eval=code", "--max-old-space-size=6144"], low))
      .toEqual(["--max-old-space-size=2048", "--eval=code"]);
  });

  it.skipIf(process.platform === "win32")("does not start a POSIX tool before the group ownership gate is published", async () => {
    const directory = await fixture();
    const output = path.join(directory, "started");
    const child = spawn(process.execPath, [path.join(import.meta.dirname, "posix-tool-child.mjs")], {
      detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    try {
      await delay(150);
      await expect(readFile(output)).rejects.toThrow();
      child.send({ command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(output)}, 'started')`] });
      expect(await exited).toBe(0);
      expect(await readFile(output, "utf8")).toBe("started");
    } finally { child.kill("SIGKILL"); }
  });
});

describe("stale process identity", () => {
  it("recovers a stale lease whose owner PID now belongs to an unrelated process", async () => {
    const directory = await fixture();
    const ready = path.join(directory, "ready");
    const unrelated = spawn(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`], { stdio: "ignore" });
    const exited = new Promise((resolve) => unrelated.once("exit", resolve));
    const lockPath = path.join(directory, "lock");
    try {
      await waitForFile(ready);
      const actualStartedAt = processStartedAt(unrelated.pid);
      expect(actualStartedAt).toBeTruthy();
      await mkdir(`${lockPath}.lock`);
      const old = new Date(Date.now() - 60_000);
      await utimes(`${lockPath}.lock`, old, old);
      await writeFile(`${lockPath}.owner.json`, JSON.stringify({
        pid: unrelated.pid, path: lockPath, token: "crashed-owner", ownerStartedAt: `previous:${actualStartedAt}`,
      }));
      const child = await startFixture(directory, ["-e", "0"], { lockPath });
      expect(await child.exited).toEqual({ code: 0, signal: null });
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
      await expect(readFile(`${lockPath}.owner.json`)).rejects.toThrow();
    } finally { unrelated.kill("SIGKILL"); await exited; }
  }, 30_000);

  it.each(["identified", "legacy"])("refuses a stale lease with a live %s owner", async (kind) => {
    const directory = await fixture();
    const lockPath = path.join(directory, "lock");
    const output = path.join(directory, "unexpected-child");
    await mkdir(`${lockPath}.lock`);
    const old = new Date(Date.now() - 60_000);
    await utimes(`${lockPath}.lock`, old, old);
    const owner = { pid: process.pid, path: lockPath, token: "live-owner" };
    if (kind === "identified") owner.ownerStartedAt = processStartedAt(process.pid);
    await writeFile(`${lockPath}.owner.json`, JSON.stringify(owner));
    await expect(runResourceCommand(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(output)}, 'started')`], {
      policy: low, lockPath, stdio: "ignore", log: () => {},
    })).rejects.toThrow("Stale tool lease still has a live owner");
    await expect(readFile(output)).rejects.toThrow();
    expect(JSON.parse(await readFile(`${lockPath}.owner.json`, "utf8"))).toEqual(owner);
  }, 15_000);

  it.skipIf(process.platform === "win32")("does not terminate a new process group that reused an old PGID", async () => {
    const directory = await fixture();
    const ready = path.join(directory, "unrelated");
    const unrelated = spawn(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`], { detached: true, stdio: "ignore" });
    const exited = new Promise((resolve) => unrelated.once("exit", resolve));
    const lockPath = path.join(directory, "lock");
    try {
      await waitForFile(ready);
      // A real exited PID avoids depending on a machine-specific pid_max.
      const dead = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
      await new Promise((resolve) => dead.once("exit", resolve));
      await mkdir(`${lockPath}.lock`);
      const old = new Date(Date.now() - 60_000);
      await utimes(`${lockPath}.lock`, old, old);
      await writeFile(`${lockPath}.owner.json`, JSON.stringify({
        pid: dead.pid, path: lockPath, token: "previous-token", groupPid: unrelated.pid, groupStartedAt: "old-group-identity",
      }));
      expect(await runResourceCommand(process.execPath, ["-e", "0"], { policy: low, lockPath, stdio: "ignore", log: () => {} }))
        .toEqual({ code: 0, signal: null });
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
    } finally { process.kill(-unrelated.pid, "SIGKILL"); await exited; }
  }, 15_000);
});

describe("SQLite survey resource policy", () => {
  it.each([low, high])("applies the capacity policy to the actual pnpm exec Vitest child ($constrained)", async (policy) => {
    const directory = await fixture();
    const bin = path.join(directory, "node_modules", ".bin");
    const output = path.join(directory, "invocation.json");
    const workspace = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "sqlite-survey-fixture", private: true, packageManager: workspace.packageManager }));
    await mkdir(bin, { recursive: true });
    const probe = path.join(bin, "vitest");
    await writeFile(probe, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({ args: process.argv.slice(2), options: process.env.NODE_OPTIONS, metrics: process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS })); process.exit(7);`, { mode: 0o755 });
    await writeFile(`${probe}.cmd`, `@"${process.execPath}" "${probe}" %*\r\n`);
    const args = ["selected.test.ts", "--maxWorkers=8", "--maxConcurrency=7", "--fileParallelism", "true"];
    const env = { ...process.env, NODE_OPTIONS: "--trace-warnings --max-old-space-size=6144", PWRAGENT_DEV_SQLITE_WRITE_METRICS: "1" };
    expect(await runSqliteWriteTests(args, {
      policy, cwd: directory, env, lockPath: path.join(directory, "lock"), stdio: "ignore", log: () => {},
    })).toEqual({ code: 7, signal: null });
    const invocation = JSON.parse(await readFile(output, "utf8"));
    expect(invocation.args).toEqual(policy.constrained
      ? ["run", "--config", "vitest.workspace.ts", "selected.test.ts", "--maxWorkers=1", "--maxConcurrency=1", "--no-file-parallelism"]
      : ["run", "--config", "vitest.workspace.ts", ...args]);
    expect(invocation.options).toBe(policy.constrained ? "--trace-warnings --max-old-space-size=2048" : env.NODE_OPTIONS);
    expect(invocation.metrics).toBe("1");
  }, 30_000);
});

it("uses the same default machine/user lane across processes with different temp roots", async () => {
  const directory = await fixture();
  const moduleUrl = new URL("./resource-run.mjs", import.meta.url).href;
  const probe = async (temp) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import { MACHINE_TOOL_LOCK } from ${JSON.stringify(moduleUrl)}; console.log(MACHINE_TOOL_LOCK);`], {
      env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (data) => { stdout += data; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    expect(code).toBe(0);
    return stdout.trim();
  };
  expect(await probe(path.join(directory, "a"))).toBe(await probe(path.join(directory, "b")));
});

it("treats a literal zero cgroup limit as finite while OS API zero means unknown", () => {
  const files = {
    "/proc/self/cgroup": "0::/\n",
    "/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
    "/sys/fs/cgroup/memory.max": "0",
  };
  expect(readCgroupMemoryLimits((file) => files[file] ?? "", "linux")).toEqual([0]);
  expect(getToolResourcePolicy({ hostMemory: 32 * GIB, constrainedMemory: 0, cgroupLimits: [0] }).effectiveMemory).toBe(0);
  expect(getToolResourcePolicy({ hostMemory: 32 * GIB, constrainedMemory: 0, cgroupLimits: [0] }).constrained).toBe(true);
  expect(getToolResourcePolicy({ hostMemory: 32 * GIB, constrainedMemory: 0, cgroupLimits: [] }).constrained).toBe(false);
});
