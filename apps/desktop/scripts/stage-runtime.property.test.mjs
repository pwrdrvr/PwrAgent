import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { verifyRuntime } from "./stage-runtime.mjs";

// The promise: packaging ships exactly the sealed payload. Any change to a
// file's bytes, mode or link, or to which files exist, is rejected.

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const version = "2.56.0-dev-pwrgit.9";
const sourceRevision = "a".repeat(40);
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fileName = fc.constantFrom("bin/git", "bin/git-lfs", "libexec/git-core/git-remote-https", "share/a", "COPYING");
const payload = fc.record({
  files: fc.uniqueArray(fc.record({
    rel: fileName,
    content: fc.string({ maxLength: 8 }),
    mode: fc.constantFrom(0o644, 0o755),
  }), { selector: (file) => file.rel, minLength: 1 }),
  link: fc.boolean(),
});

const tamper = fc.constantFrom("bytes", "mode", "remove", "add", "replace-with-link", "retarget-link");

function build({ files, link }) {
  const root = mkdtempSync(join(tmpdir(), "pwragent-sealed-"));
  roots.push(root);
  writeFileSync(join(root, "pwrgit-build.json"), JSON.stringify({
    version, source_revision: sourceRevision, primary_sha1: "SHA1_DC", lfs_version: "3.7.1",
  }));
  for (const { rel, content, mode } of files) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
    chmodSync(join(root, rel), mode);
  }
  const inventory = {};
  for (const rel of ["pwrgit-build.json", ...files.map((file) => file.rel)]) {
    const path = join(root, rel);
    inventory[rel] = { sha256: sha256(readFileSync(path)), mode: lstatSync(path).mode & 0o7777 };
  }
  if (link) {
    symlinkSync(files[0].rel, join(root, "bin-link"));
    inventory["bin-link"] = { link: files[0].rel };
  }
  const inventoryBytes = JSON.stringify(inventory);
  writeFileSync(join(root, "runtime-files.json"), inventoryBytes);
  return {
    root,
    pin: { key: "linux-x64", manifest: { version, source_revision: sourceRevision }, asset: { inventory_sha256: sha256(inventoryBytes) } },
  };
}

/** Changes the payload; false when this payload has nothing to change that way. */
function apply(kind, root, { files, link }) {
  const target = join(root, files[0].rel);
  switch (kind) {
    case "bytes":
      writeFileSync(target, `${readFileSync(target, "utf8")}!`);
      return true;
    case "mode":
      chmodSync(target, files[0].mode ^ 0o111);
      return true;
    case "remove":
      rmSync(target);
      return true;
    case "add":
      writeFileSync(join(root, "unsealed"), "");
      return true;
    case "replace-with-link":
      rmSync(target);
      symlinkSync(join(root, "pwrgit-build.json"), target);
      return true;
    case "retarget-link":
      if (!link) return false;
      rmSync(join(root, "bin-link"));
      symlinkSync("pwrgit-build.json", join(root, "bin-link"));
      return true;
  }
}

// The sealed inventory guards macOS and Linux only; Windows keeps Dugite's Git.
describe.skipIf(process.platform === "win32")("custom Git sealed inventory, any tamper", () => {
  it("accepts the sealed payload and rejects it after any one change", () => {
    fc.assert(fc.property(payload, tamper, (spec, kind) => {
      const { root, pin } = build(spec);
      expect(verifyRuntime(root, pin, { probe: false }).version).toBe(version);
      fc.pre(apply(kind, root, spec));
      expect(() => verifyRuntime(root, pin, { probe: false })).toThrow();
    }), { numRuns: 60 });
  });
});

// The archive owns file modes. The caller's umask must not change the sealed
// payload. Real tar extraction and the inventory verifier are the oracles.
describe.skipIf(process.platform === "win32")("custom Git extraction modes", () => {
  it("preserves sealed modes under umask 077 and generated caller masks", () => {
    const { root, pin } = build({
      files: [{ rel: "bin/git", mode: 0o755, content: `#!/bin/sh
case "$*" in
  '--version') echo 'git version ${version}' ;;
  'version --build-options') printf '%s\\n' 'SHA-1: SHA1_DC' 'built from commit: ${sourceRevision}' ;;
  '--exec-path') printf '%s/libexec/git-core\\n' "\${0%/bin/git}" ;;
  'lfs version') echo 'git-lfs/3.7.1 fixture' ;;
  *) exit 1 ;;
esac
` }],
      link: true,
    });
    const temp = mkdtempSync(join(tmpdir(), "pwragent-extraction-"));
    roots.push(temp);
    const archive = join(temp, "fixture.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", root, "."]);
    const digest = sha256(readFileSync(archive));
    renameSync(archive, join(temp, `${digest}.tar.gz`));
    const manifestPath = join(temp, "manifest.json");
    const consumer = new URL("./stage-runtime.mjs", import.meta.url);
    writeFileSync(manifestPath, JSON.stringify({
      schema: 1, ...pin.manifest,
      consumer_sha256: sha256(readFileSync(consumer)),
      assets: { "linux-x64": {
        ...pin.asset, sha256: digest,
        url: `https://github.com/huntharo/git/releases/download/v${version}/fixture.tar.gz`,
      } },
    }));
    let run = 0;
    // Preserve owner access to newly created staging directories.
    fc.assert(fc.property(fc.integer({ min: 0, max: 0o077 }), (mask) => {
      const output = join(temp, `staged-${run++}`);
      // Use a child so the property never changes the test runner's umask.
      execFileSync(process.execPath, ["--input-type=module", "-e", `
        process.umask(Number(process.argv[1]));
        globalThis.fetch = () => { throw new Error("Expected the pinned cached archive"); };
        const { stageRuntime } = await import(${JSON.stringify(consumer.href)});
        await stageRuntime({ manifestPath: process.argv[2], platform: "linux", arch: "x64",
          output: process.argv[3], cache: process.argv[4] });
      `, String(mask), manifestPath, output, temp], { stdio: "pipe" });
      expect(verifyRuntime(output, pin, { probe: false }).version).toBe(version);
    }), { numRuns: 12, examples: [[0o077]] });
  });
});
