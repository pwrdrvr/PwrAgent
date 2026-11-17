import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runNativeFixtureCommand } from "../src/test-setup/native-helper-fixture";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const fixtures = [];
const pendingBuilds = [];
afterEach(async () => {
  // Even an aborted assertion must join native owners before removing inputs.
  await Promise.allSettled(pendingBuilds.splice(0));
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-build-oracle-")));
  fixtures.push(root);
  cpSync(join(desktop, "scripts"), join(root, "scripts"), { recursive: true, filter: (file) =>
    file === join(desktop, "scripts") || file === join(desktop, "scripts/build-mcp-ipc-relay.mjs") });
  cpSync(join(desktop, "native/mcp-ipc-relay"), join(root, "native/mcp-ipc-relay"), { recursive: true });
  const builder = join(root, "scripts/build-mcp-ipc-relay.mjs");
  const source = join(root, "native/mcp-ipc-relay/main.c");
  const header = join(root, "native/mcp-ipc-relay/maintenance-lock.h");
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
  const program = (options = {}) => `import { buildMcpIpcRelay } from ${JSON.stringify(pathToFileURL(builder).href)};
    console.log(JSON.stringify(buildMcpIpcRelay(${JSON.stringify({ outputRoot: root, ...options })})));`;
  const command = (options) => ["--input-type=module", "-e", program(options)];
  const build = (options, env = process.env) => parseOutput(execFileSync(process.execPath, command(options), { encoding: "utf8", env, stdio: "pipe" }));
  return { root, builder, source, header, build, command };
}

// MSVC prints source/linker diagnostics before the child's final JSON line.
function parseOutput(stdout) {
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}

function observe(output) {
  return execFileSync(output, ["--build-oracle"], { encoding: "utf8" }).trim();
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
  writeFileSync(output, "untrusted output");
  expect(f.build({ packaged: true })).toBe(output);
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
