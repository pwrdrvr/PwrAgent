import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runNativeFixtureCommand } from "../src/test-setup/native-helper-fixture";
import { appendNativeOracleTiming, profileNativeBuild } from "./native-relay-oracle-profile.mjs";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const fixtures = [];
const pendingBuilds = [];
afterEach(async () => {
  // Even an aborted assertion must join native owners before removing inputs.
  await Promise.allSettled(pendingBuilds.splice(0));
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(callerSource) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-build-oracle-")));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  for (const name of ["build-mcp-ipc-relay.mjs", "native-helper-cache.mjs"]) {
    copyFileSync(join(desktop, "scripts", name), join(root, "scripts", name));
  }
  const builder = join(root, "scripts/build-mcp-ipc-relay.mjs");
  const source = join(root, "native/mcp-ipc-relay/main.c");
  const header = join(root, "native/mcp-ipc-relay/maintenance-lock.h");
  if (callerSource !== undefined) {
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, callerSource);
  } else {
    cpSync(join(desktop, "native/mcp-ipc-relay"), dirname(source), { recursive: true });
    // Keep the production implementation callable. Only the fixture adds a
    // query that observes which source, local header and flags were compiled.
    const entry = process.platform === "win32" ? "wmain" : "main";
    const parameters = process.platform === "win32" ? "int argc, wchar_t **argv" : "int argc, char **argv";
    const match = process.platform === "win32" ? 'wcscmp(argv[1], L"--build-oracle")' : 'strcmp(argv[1], "--build-oracle")';
    writeFileSync(header, readFileSync(header, "utf8") + '\n#define BUILD_ORACLE_HEADER "header-one"\n');
    writeFileSync(source, `#define ${entry} original_entry\n${readFileSync(source, "utf8")}\n#undef ${entry}
#ifndef BUILD_ORACLE_FLAG
#define BUILD_ORACLE_FLAG 1
#endif
#define BUILD_ORACLE_STRING_VALUE(x) #x
#define BUILD_ORACLE_STRING(x) BUILD_ORACLE_STRING_VALUE(x)
int ${entry}(${parameters}) {
  if (argc == 2 && !${match}) {
    puts("source-one " BUILD_ORACLE_HEADER " flag-" BUILD_ORACLE_STRING(BUILD_ORACLE_FLAG));
    return 0;
  }
  return original_entry(argc, argv);
}
`);
  }
  let attempt = 0;
  const program = (options = {}, profile = process.env.PWRAGENT_NATIVE_ORACLE_PROFILE) => {
    const label = { root, attempt: ++attempt };
    const build = `buildMcpIpcRelay(${JSON.stringify({ outputRoot: root, reuse: process.platform !== "win32", ...options })})`;
    return `import { buildMcpIpcRelay } from ${JSON.stringify(pathToFileURL(builder).href)};
      ${profile ? `import { profileNativeBuild } from ${JSON.stringify(new URL("./native-relay-oracle-profile.mjs", import.meta.url).href)};` : ""}
      console.log(JSON.stringify(${profile ? `profileNativeBuild(${JSON.stringify(label)}, () => ${build})` : build}));`;
  };
  const command = (options, profile) => ["--input-type=module", "-e", program(options, profile)];
  const build = (options, env = process.env) => {
    const args = command(options, env.PWRAGENT_NATIVE_ORACLE_PROFILE);
    const started = performance.now();
    try { return parseOutput(execFileSync(process.execPath, args, { encoding: "utf8", env, stdio: "pipe" })); }
    finally { appendNativeOracleTiming({ kind: "build-process", label: { root, attempt }, ms: performance.now() - started }); }
  };
  return { root, builder, source, header, build, command };
}

// MSVC prints source/linker diagnostics before the child's final JSON line.
function parseOutput(stdout) {
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}

function observe(output) {
  const started = performance.now();
  try { return execFileSync(output, ["--build-oracle"], { encoding: "utf8" }).trim(); }
  finally { appendNativeOracleTiming({ kind: "run-helper", output, ms: performance.now() - started }); }
}

function machine(output) {
  const bytes = readFileSync(output);
  if (process.platform === "darwin") {
    expect(bytes.readUInt32LE(0)).toBe(0xfeedfacf);
    return bytes.readUInt32LE(4) === 0x0100000c ? "arm64" : bytes.readUInt32LE(4) === 0x01000007 ? "x64" : "unknown";
  }
  if (process.platform === "linux") {
    expect(bytes.subarray(0, 4).toString("hex")).toBe("7f454c46");
    expect(bytes[5]).toBe(1);
    return bytes.readUInt16LE(18) === 183 ? "arm64" : bytes.readUInt16LE(18) === 62 ? "x64" : "unknown";
  }
  expect(bytes.subarray(0, 2).toString()).toBe("MZ");
  const pe = bytes.readUInt32LE(0x3c);
  expect(bytes.subarray(pe, pe + 4).toString()).toBe("PE\0\0");
  return bytes.readUInt16LE(pe + 4) === 0xaa64 ? "arm64" : bytes.readUInt16LE(pe + 4) === 0x8664 ? "x64" : "unknown";
}

it("inspects each native Mach-O input once while preserving emitted code and cache sealing", () => {
  const f = fixture();
  if (process.platform !== "darwin") {
    const output = f.build({ reuse: true });
    expect(machine(output)).toBe(process.arch);
    expect(observe(output)).toBe("source-one header-one flag-1");
    return;
  }
  const log = join(f.root, "inspections.jsonl");
  const output = f.build({ reuse: true }, { ...process.env, PWRAGENT_NATIVE_ORACLE_PROFILE: log });
  expect(machine(output)).toBe(process.arch);
  expect(observe(output)).toBe("source-one header-one flag-1");
  expect(existsSync(`${output}.build.json`)).toBe(true);
  const records = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const build = records.find((record) => record.kind === "native-build");
  expect(build.completed).toBe(true);
  expect(build.lockRemaining).toBe(false);
  expect(build.inspectionsOmitted).toBe(0);
  expect(build.inspections.length).toBeGreaterThan(0);
  // Raw Mach-O load commands belong to the file. Loader context may change
  // resolution, but must not launch another inspector for unchanged bytes.
  const targets = new Set(build.inspections.map((call) => call.before.real));
  expect(build.inspections).toHaveLength(targets.size);
  for (const call of build.inspections) {
    expect(call.mode).toBe("-l");
    expect(call.status).toBe(0);
    expect(call.before).toEqual(call.after);
  }
});

it("emitted native code follows source, included headers and compiler flags at the same output path", () => {
  const f = fixture();
  const output = f.build();
  expect(machine(output)).toBe(process.arch);
  expect(observe(output)).toBe("source-one header-one flag-1");
  writeFileSync(f.header, readFileSync(f.header, "utf8").replace('"header-one"', '"header-two"'));
  expect(f.build()).toBe(output);
  expect(observe(output)).toBe("source-one header-two flag-1");
  writeFileSync(f.source, readFileSync(f.source, "utf8").replace('"source-one ', '"source-two '));
  f.build();
  expect(observe(output)).toBe("source-two header-two flag-1");
  const flag = process.platform === "win32" ? "/DBUILD_ORACLE_FLAG=2" : "-DBUILD_ORACLE_FLAG=2";
  const oldFlag = process.platform === "win32" ? '"/O2"' : '"-O2"';
  writeFileSync(f.builder, readFileSync(f.builder, "utf8").replace(oldFlag, `${oldFlag}, ${JSON.stringify(flag)}`));
  f.build();
  expect(observe(output)).toBe("source-two header-two flag-2");
});

it("replaces corrupt output and still fails closed in the real peer verifier", () => {
  const f = fixture();
  const output = f.build({ packaged: true });
  const damaged = readFileSync(output);
  damaged[damaged.length - 1] ^= 1;
  writeFileSync(output, damaged);
  utimesSync(output, 1, 1);
  expect(f.build({ packaged: true })).toBe(output);
  expect(statSync(output).mtimeMs).toBeGreaterThan(1000);
  expect(observe(output)).toBe("source-one header-one flag-1");
  const peer = spawnSync(output, [join(dirname(output), "absent-peer")], { encoding: "utf8" });
  expect(peer.error).toBeUndefined();
  expect(peer.status).toBe(1);
  expect(peer.stdout).toBe("");
  expect(peer.stderr).toContain("MCP IPC:");
});

it("a failed source rebuild or missing toolchain leaves no previously usable helper", () => {
  const f = fixture();
  const output = f.build();
  const source = readFileSync(f.source, "utf8");
  writeFileSync(f.source, source + '\n#error invalidated_build_must_fail_closed\n');
  expect(() => f.build()).toThrow();
  expect(existsSync(output)).toBe(false);
  writeFileSync(f.source, source);
  f.build();
  // VCINSTALLDIR avoids discovery outside this deliberately empty PATH on
  // Windows. No binaries or developer toolchain state are changed.
  expect(() => f.build(undefined, { ...process.env, PATH: f.root, VCINSTALLDIR: f.root })).toThrow();
  expect(existsSync(output)).toBe(false);
});

it("concurrent owners with separate output roots cannot replace each other's artifact", async () => {
  const f = fixture();
  const roots = [join(f.root, "owner-a"), join(f.root, "owner-b")];
  const resultFiles = roots.map((_, index) => join(f.root, `result-${index}.json`));
  const builds = roots.map((outputRoot, index) => runNativeFixtureCommand(process.execPath, [
    "--input-type=module", "-e", `
      import { writeFileSync } from "node:fs";
      import { buildMcpIpcRelay } from ${JSON.stringify(pathToFileURL(f.builder).href)};
      writeFileSync(process.argv[1], JSON.stringify(buildMcpIpcRelay(${JSON.stringify({ outputRoot })})));
    `, resultFiles[index],
  ]));
  pendingBuilds.push(...builds);
  const results = await Promise.allSettled(builds);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  const outputs = resultFiles.map((file) => JSON.parse(readFileSync(file, "utf8")));
  expect(outputs[0]).not.toBe(outputs[1]);
  for (const output of outputs) {
    expect(machine(output)).toBe(process.arch);
    expect(observe(output)).toBe("source-one header-one flag-1");
  }
});

it("a shared packaged filename follows the requested native architecture or fails closed", () => {
  const f = fixture();
  const output = f.build({ packaged: true });
  const other = process.arch === "arm64" ? "x64" : "arm64";
  if (process.platform === "darwin") {
    expect(f.build({ packaged: true, arch: other })).toBe(output);
    // Inspect the foreign slice without relying on Rosetta or executing it.
    expect(machine(output)).toBe(other);
  } else {
    expect(() => f.build({ packaged: true, arch: other })).toThrow();
    expect(existsSync(output)).toBe(false);
  }
  f.build({ packaged: true });
  expect(machine(output)).toBe(process.arch);
  expect(observe(output)).toBe("source-one header-one flag-1");
});

it("reuses verified unchanged native output instead of recompiling it", () => {
  const f = fixture();
  const output = f.build({ reuse: true });
  const bytes = readFileSync(output);
  // Timestamp changes do not change executable bytes. A real cache hit must
  // leave this sentinel intact; the old unconditional compiler replaces it.
  utimesSync(output, 1, 1);
  f.build({ reuse: true });
  if (process.platform === "win32") {
    expect(statSync(output).mtimeMs).toBeGreaterThan(1000);
  } else {
    expect(statSync(output).mtimeMs).toBe(1000);
    expect(readFileSync(output)).toEqual(bytes);
  }
  expect(observe(output)).toBe("source-one header-one flag-1");
});


it("only the active owner can replace or invalidate a shared native output", () => {
  const f = fixture();
  const output = f.build({ reuse: true });
  const original = readFileSync(output);
  const destination = join(f.root, "installed-helper");
  copyFileSync(output, destination);
  const lock = `${output}.build-lock`;
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, owner: "other-builder" }));
  try {
    if (process.platform === "win32") {
      f.build({ reuse: true });
      expect(existsSync(`${output}.build.json`)).toBe(false);
      expect(observe(output)).toBe("source-one header-one flag-1");
    } else {
      expect(() => f.build({ reuse: true, destination })).toThrow(/Another native helper build owns/);
      expect(readFileSync(destination)).toEqual(original);
      expect(readFileSync(output)).toEqual(original);
      expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).owner).toBe("other-builder");
    }
  } finally { rmSync(lock, { recursive: true, force: true }); }
});

it("invalidates linked input identity even when library size and mtime are restored", () => {
  if (process.platform === "win32") {
    const f = fixture();
    const output = f.build({ reuse: true });
    expect(existsSync(`${output}.build.json`)).toBe(false);
    expect(observe(output)).toBe("source-one header-one flag-1");
    return;
  }
  const f = fixture(`int puts(const char *);
const char *oracle_library_value(void);
int main(void) {
  puts(oracle_library_value());
  return 0;
}
`);
  const library = join(f.root, "library");
  mkdirSync(library);
  const object = join(library, "value.o");
  const archive = join(library, "libvalue.a");
  const started = performance.now();
  try {
    execFileSync("cc", ["-x", "c", "-c", "-", "-o", object,
      ...(process.platform === "darwin" ? ["-mmacosx-version-min=12.0"] : []),
    ], {
      input: 'const char *oracle_library_value(void) { return "lib-one"; }\n', stdio: "pipe",
    });
    execFileSync("ar", ["rcs", archive, object], { stdio: "pipe" });
  } finally {
    appendNativeOracleTiming({ kind: "archive-setup", label: { root: f.root }, ms: performance.now() - started });
  }
  // Use a whole-second timestamp so utimesSync can restore it exactly.
  utimesSync(archive, 1, 1);
  writeFileSync(f.builder, readFileSync(f.builder, "utf8").replace('source, "-o", output', `source, ${JSON.stringify(`-Wl,${archive}`)}, "-o", output`));
  // Load the isolated production builder once. This case keeps the same
  // environment throughout and needs no Node subprocess for either build.
  const { buildMcpIpcRelay } = createRequire(import.meta.url)(f.builder);
  let attempt = 0;
  const build = () => profileNativeBuild({ root: f.root, attempt: ++attempt },
    () => buildMcpIpcRelay({ outputRoot: f.root, reuse: true }));
  const output = build();
  const inputs = JSON.parse(readFileSync(`${output}.build.json`, "utf8")).inputs;
  expect(inputs.some((input) => input.path === archive)).toBe(true);
  expect(observe(output)).toBe("lib-one");
  const original = statSync(archive, { bigint: true });
  // Change the one object string in place. Its length and the archive layout
  // stay fixed, and there is no second compiler or archiver invocation.
  const bytes = readFileSync(archive);
  const offset = bytes.indexOf("lib-one\0");
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(bytes.indexOf("lib-one\0", offset + 1)).toBe(-1);
  bytes.write("lib-two", offset);
  writeFileSync(archive, bytes);
  utimesSync(archive, 1, 1);
  const updated = statSync(archive, { bigint: true });
  expect(updated.ino).toBe(original.ino);
  expect(updated.size).toBe(original.size);
  expect(updated.mtimeNs).toBe(original.mtimeNs);
  expect(build()).toBe(output);
  expect(observe(output)).toBe("lib-two");
});

it("removes an installed Outpost helper after a failed POSIX rebuild and rejects Windows", () => {
  const f = fixture();
  const output = f.build({ packaged: true, reuse: true });
  for (const [from, to] of [
    [join(desktop, "../../packages/pwragent/scripts/install.mjs"), join(f.root, "scripts/install.mjs")],
    [join(desktop, "scripts/stage-runtime.mjs"), join(f.root, "scripts/stage-runtime.mjs")],
  ]) copyFileSync(from, to);
  mkdirSync(join(f.root, "dist"));
  writeFileSync(join(f.root, "dist/runtime.json"), "{}");
  const resources = join(f.root, "resources/mcp-ipc-relay");
  mkdirSync(resources, { recursive: true });
  const installed = join(resources, "mcp-ipc-relay");
  copyFileSync(output, installed);
  const run = () => execFileSync(process.execPath, [join(f.root, "scripts/install.mjs")], {
    env: { ...process.env, PATH: f.root, VCINSTALLDIR: f.root }, stdio: "pipe",
  });
  if (process.platform === "win32") {
    expect(run).toThrow(/Outpost supports Linux and macOS/);
    expect(existsSync(installed)).toBe(true);
  } else {
    expect(run).toThrow();
    expect(existsSync(output)).toBe(false);
    expect(existsSync(installed)).toBe(false);
  }
});

it("tracks a real rpath dylib through cache reuse and restored-size/mtime invalidation", () => {
  if (process.platform !== "darwin") {
    expect(process.platform === "linux" || process.platform === "win32").toBe(true);
    return;
  }
  const f = fixture();
  const library = join(f.root, "libvalue.dylib");
  const source = join(f.root, "value.c");
  const buildLibrary = (value) => {
    writeFileSync(source, `const char *oracle_library_value(void) { return "${value}"; }\n`);
    execFileSync("cc", ["-dynamiclib", "-O2", "-mmacosx-version-min=12.0", source, "-Wl,-install_name,@rpath/libvalue.dylib", "-o", library], { stdio: "pipe" });
  };
  buildLibrary("lib-one");
  writeFileSync(f.source, "const char *oracle_library_value(void);\n" + readFileSync(f.source, "utf8").replace('puts("source-one ', 'puts(oracle_library_value()); puts("source-one '));
  writeFileSync(f.builder, readFileSync(f.builder, "utf8").replace('source, "-o", output', `source, ${JSON.stringify(`-Wl,${library}`)}, ${JSON.stringify(`-Wl,-rpath,${f.root}`)}, "-o", output`));
  const output = f.build({ reuse: true });
  expect(observe(output)).toBe("lib-one\nsource-one header-one flag-1");
  expect(existsSync(`${output}.build.json`)).toBe(true);
  const inputs = JSON.parse(readFileSync(`${output}.build.json`, "utf8")).inputs;
  expect(inputs.some((input) => input.path === library)).toBe(true);
  utimesSync(output, 1, 1);
  f.build({ reuse: true });
  expect(statSync(output).mtimeMs).toBe(1000);
  const before = statSync(library);
  buildLibrary("lib-two");
  utimesSync(library, before.atime, before.mtime);
  expect(statSync(library).size).toBe(before.size);
  f.build({ reuse: true });
  expect(statSync(output).mtimeMs).toBeGreaterThan(1000);
  expect(observe(output)).toBe("lib-two\nsource-one header-one flag-1");
});
