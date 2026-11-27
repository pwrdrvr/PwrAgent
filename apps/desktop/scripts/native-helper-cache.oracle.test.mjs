import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { linkedFilesFromTrace, parseMachOLoadCommands } from "./native-helper-cache.mjs";

it("checks the filesystem once for repeated mentions of a linked archive", () => {
  const archive = resolve("link-trace-fixtures", "libvalue.a");
  const other = resolve("link-trace-fixtures", "libother.a");
  const trace = [archive, other, archive, `${archive}(member.o)`].join("\n");
  const checked = [];
  const paths = linkedFilesFromTrace(trace, (path) => {
    checked.push(path);
    return true;
  });
  expect([...paths]).toEqual([archive, other]);
  expect(checked).toEqual([archive, other]);
});

const loads = ["LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB", "LC_LOAD_UPWARD_DYLIB", "LC_LAZY_LOAD_DYLIB"];

it("preserves every dependency form and raw loader token while excluding install IDs", () => {
  fc.assert(fc.property(fc.array(fc.record({
    command: fc.constantFrom(...loads, "LC_ID_DYLIB", "LC_RPATH"),
    prefix: fc.constantFrom("/absolute/path", "@loader_path", "@executable_path", "@rpath"),
    value: fc.integer({ min: 0, max: 10000 }),
  }), { minLength: 1, maxLength: 24 }), (entries) => {
    const model = { libraries: [], rpaths: [], ids: [] };
    const text = entries.map(({ command, prefix, value }, index) => {
      const name = `${prefix}/file-${value}`;
      model[command === "LC_RPATH" ? "rpaths" : command === "LC_ID_DYLIB" ? "ids" : "libraries"].push(name);
      return `Load command ${index}\n      cmd ${command}\n  cmdsize 64\n     ${command === "LC_RPATH" ? "path" : "name"} ${name} (offset 24)\n`;
    }).join("");
    expect(parseMachOLoadCommands(text)).toEqual(model);
  }));
});

it("refuses incomplete or unknown dependency metadata instead of sealing a partial key", () => {
  expect(parseMachOLoadCommands("")).toBeUndefined();
  for (const command of [...loads, "LC_ID_DYLIB", "LC_RPATH", "LC_PREBOUND_DYLIB", "LC_UNKNOWN_DYLIB"]) {
    expect(parseMachOLoadCommands(`Load command 0\n      cmd ${command}\n  cmdsize 64\n`)).toBeUndefined();
  }
  expect(parseMachOLoadCommands("Load command 0\n      cmd LC_LOAD_DYLIB\n name relative.dylib (offset 24)\n")).toBeUndefined();
});

it.each(["load", "weak", "reexport", "upward"])("matches real OS dependency inspection for a %s dylib", (kind) => {
  if (process.platform !== "darwin") {
    // Mach-O inspection only runs on macOS; pure parser properties run on all hosts.
    expect(parseMachOLoadCommands("not Mach-O metadata")).toBeUndefined();
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "macho-inspection-oracle-"));
  try {
    const source = join(root, "value.c");
    const library = join(root, "libvalue.dylib");
    const parent = join(root, "libparent.dylib");
    writeFileSync(source, "int oracle_value(void) { return 42; }\n");
    execFileSync("cc", ["-dynamiclib", source, "-Wl,-install_name,@rpath/libvalue.dylib", "-o", library], { stdio: "pipe" });
    writeFileSync(source, "extern int oracle_value(void); int oracle_parent(void) { return oracle_value(); }\n");
    const link = kind === "load" ? library : `-Wl,-${kind}_library,${library}`;
    execFileSync("cc", ["-dynamiclib", source, link, `-Wl,-rpath,${root}`, "-Wl,-install_name,@rpath/libparent.dylib", "-o", parent], { stdio: "pipe" });
    for (const file of [parent, library, process.execPath, "/usr/bin/cc"]) {
      const run = (flag) => execFileSync("/usr/bin/otool", [flag, file], { encoding: "utf8" });
      const commands = run("-l");
      const parsed = parseMachOLoadCommands(commands);
      expect(parsed).toBeDefined();
      const ids = file.endsWith(".dylib") ? run("-D").trim().split(/\r?\n/).slice(1) : [];
      const names = run("-L").split(/\r?\n/).flatMap((line) => {
        const match = /^\s+((?:\/|@).+?) \(compatibility version /.exec(line);
        return match && !ids.includes(match[1]) ? [match[1]] : [];
      });
      expect([...new Set(parsed.libraries)].sort()).toEqual([...new Set(names)].sort());
      expect(parsed.rpaths).toEqual([...commands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset/g)].map((match) => match[1]));
    }
    const parsed = parseMachOLoadCommands(execFileSync("/usr/bin/otool", ["-l", parent], { encoding: "utf8" }));
    expect(parsed.libraries).toContain("@rpath/libvalue.dylib");
    expect(parsed.ids).toContain("@rpath/libparent.dylib");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
