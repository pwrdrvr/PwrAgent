import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

// Resolve from the actual consumers, including the separate ASAR versions
// used by electron-builder and the packaged-content verifier.
const desktop = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const dependenciesOf = (parent, name) => createRequire(parent.resolve(name));
const builder = dependenciesOf(dependenciesOf(desktop, "electron-builder"), "app-builder-lib");
const universal = dependenciesOf(builder, "@electron/universal");
const legacyAsar = dependenciesOf(builder, "@electron/asar");
const installer = dependenciesOf(dependenciesOf(builder, "electron-builder-squirrel-windows"), "electron-winstaller");
const temp = dependenciesOf(installer, "temp");
const rimraf = dependenciesOf(temp, "rimraf");
const directories = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pwragent-glob-compatibility-"));
  directories.push(directory);
  return directory;
}

function write(directory, name, content = name) {
  const path = join(directory, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("glob dependency compatibility", () => {
  for (const [name, asar] of [
    ["electron-builder ASAR", builder("@electron/asar")],
    ["packaged-content verifier ASAR", desktop("@electron/asar")],
  ]) {
    it(`${name} preserves hidden files and unpacks native files and directories`, async () => {
      const directory = fixture();
      const input = join(directory, "input");
      write(input, "main.js");
      write(input, ".metadata");
      write(input, "native/addon.node");
      write(input, "vendor/tool/data.bin");
      const archive = join(directory, "app.asar");
      await asar.createPackageWithOptions(input, archive, {
        unpack: "**/*.node",
        unpackDir: "**/tool",
      });
      expect(asar.extractFile(archive, "main.js").toString()).toBe("main.js");
      expect(asar.extractFile(archive, ".metadata").toString()).toBe(".metadata");
      expect(asar.statFile(archive, join("native", "addon.node")).unpacked).toBe(true);
      expect(asar.statFile(archive, join("vendor", "tool", "data.bin")).unpacked).toBe(true);
      expect(asar.extractFile(archive, join("native", "addon.node")).toString()).toBe("native/addon.node");
      expect(asar.extractFile(archive, join("vendor", "tool", "data.bin")).toString()).toBe("vendor/tool/data.bin");
    });
  }

  it("keeps glob 7 callback and synchronous traversal, dotfiles, braces, and ignores", async () => {
    const directory = fixture();
    write(directory, "src/main.js");
    write(directory, "src/.hidden.js");
    write(directory, "src/native.node");
    write(directory, "src/skip.js");
    const options = { cwd: directory, dot: true, ignore: "**/skip.js" };
    const expected = ["src/.hidden.js", "src/main.js", "src/native.node"];
    for (const consumer of [legacyAsar, rimraf]) {
      const glob = consumer("glob");
      expect(glob.sync("**/*.{js,node}", options).sort()).toEqual(expected);
      expect((await promisify(glob)("**/*.{js,node}", options)).sort()).toEqual(expected);
    }
    const removable = join(directory, "remove");
    write(removable, "nested/data.txt");
    await promisify(temp("rimraf"))(removable);
    expect(rimraf("glob").sync("remove/**/*", { cwd: directory })).toEqual([]);
  });

  it("preserves universal app directory comparison filters", () => {
    const directory = fixture();
    for (const side of ["arm64", "x64"]) {
      write(join(directory, side), "main.js", "same");
      write(join(directory, side), ".hidden.js", "same hidden file");
      write(join(directory, side), "nested/debug.map", side);
    }
    const compare = universal("dir-compare");
    const left = join(directory, "arm64");
    const right = join(directory, "x64");
    expect(compare.compareSync(left, right, { compareContent: true }).same).toBe(false);
    expect(compare.compareSync(left, right, {
      compareContent: true,
      includeFilter: "*.js",
      excludeFilter: "*.map",
    }).same).toBe(true);
    write(right, ".hidden.js", "changed");
    expect(compare.compareSync(left, right, {
      compareContent: true,
      includeFilter: "*.js",
    }).same).toBe(false);
  });

  it("preserves installer template file lists", () => {
    const directory = fixture();
    const included = write(directory, "templates/installer.ejs");
    write(directory, "templates/ignored.txt");
    const filelist = dependenciesOf(dependenciesOf(builder, "ejs"), "jake")("filelist");
    // Filelist normalizes results to forward slashes; its native pattern
    // still needs backslashes treated as separators rather than escapes.
    const files = new filelist.FileList(join(directory, "**/*.ejs"), {
      windowsPathsNoEscape: true,
    });
    expect(files.toArray()).toEqual([included.replaceAll("\\", "/")]);
  });

  it("preserves packaging inclusions, exclusions, directory descent, and Windows patterns", () => {
    const directory = fixture();
    const { FileMatcher } = builder("./fileMatcher.js");
    const matcher = new FileMatcher(directory, join(directory, "out"), (value) => value, [
      "dist\\**\\*.{js,node}",
      "!dist/**/*.test.js",
    ]);
    const filter = matcher.createFilter();
    const file = { isDirectory: () => false };
    const folder = { isDirectory: () => true };
    expect(filter(join(directory, "dist"), folder)).toBe(true);
    expect(filter(join(directory, "dist/main.js"), file)).toBe(true);
    expect(filter(join(directory, "dist/.hidden.js"), file)).toBe(true);
    expect(filter(join(directory, "dist/native/addon.node"), file)).toBe(true);
    expect(filter(join(directory, "dist/main.test.js"), file)).toBe(false);
    expect(filter(join(directory, "src/main.js"), file)).toBe(false);
  });

  it("preserves Sigstore cache writes, reads, and glob-based cleanup", async () => {
    const directory = fixture();
    const sign = dependenciesOf(dependenciesOf(desktop, "sigstore"), "@sigstore/sign");
    const cache = dependenciesOf(sign, "make-fetch-happen")("cacache");
    await cache.put(directory, "fixture", "signed payload");
    expect((await cache.get(directory, "fixture")).data.toString()).toBe("signed payload");
    await cache.rm.all(directory);
    await expect(cache.get(directory, "fixture")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves TUF trust target matching without widening delegated paths", () => {
    const tuf = dependenciesOf(dependenciesOf(dependenciesOf(desktop, "sigstore"), "@sigstore/tuf"), "tuf-js");
    const models = dependenciesOf(tuf, "@tufjs/models");
    const { DelegatedRole } = models("./role.js");
    const role = new DelegatedRole({
      name: "fixture",
      keyIDs: ["fixture-key"],
      threshold: 1,
      terminating: true,
      paths: ["trusted/*.json"],
    });
    expect(role.isDelegatedPath("trusted/root.json")).toBe(true);
    expect(role.isDelegatedPath("untrusted/root.json")).toBe(false);
    expect(role.isDelegatedPath("trusted/nested/root.json")).toBe(false);
  });
});
