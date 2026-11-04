import { createHash } from "node:crypto";
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readRuntimeManifest, verifyRuntime } from "./stage-runtime.mjs";

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "..", "custom-git-runtime.json");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const roots = [];
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "pwragent-git-runtime-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeManifest(change) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  change(manifest);
  const path = join(tempRoot(), "custom-git-runtime.json");
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

describe("custom Git runtime manifest", () => {
  it("selects the pinned asset for each packaged platform", () => {
    expect(readRuntimeManifest(manifestPath, "linux", "arm64").key).toBe("linux-arm64");
    expect(readRuntimeManifest(manifestPath, "linux", "x64").key).toBe("linux-x64");
    // Both macOS legs stage the one universal payload.
    expect(readRuntimeManifest(manifestPath, "darwin", "x64").key).toBe("darwin-universal");
    expect(readRuntimeManifest(manifestPath, "darwin", "arm64").key).toBe("darwin-universal");
  });

  it("rejects a manifest approved for a different shared consumer", () => {
    const path = writeManifest((m) => { m.consumer_sha256 = "0".repeat(64); });
    expect(() => readRuntimeManifest(path, "linux", "x64")).toThrow(/consumer differs/);
  });

  it("rejects a mutable or foreign archive URL", () => {
    const query = writeManifest((m) => { m.assets["linux-x64"].url += "?latest"; });
    expect(() => readRuntimeManifest(query, "linux", "x64")).toThrow(/immutable versioned release URL/);
    const foreign = writeManifest((m) => {
      m.assets["linux-x64"].url = m.assets["linux-x64"].url.replace("huntharo/git", "example/git");
    });
    expect(() => readRuntimeManifest(foreign, "linux", "x64")).toThrow(/immutable versioned release URL/);
  });

  it("rejects a macOS payload that is not the notarized PwrDrvr build", () => {
    const path = writeManifest((m) => { m.assets["darwin-universal"].notarized = false; });
    expect(() => readRuntimeManifest(path, "darwin", "arm64")).toThrow(/notarized PwrDrvr payload/);
  });

  it("rejects a platform the manifest does not pin", () => {
    expect(() => readRuntimeManifest(manifestPath, "linux", "ia32")).toThrow(/linux-ia32/);
  });
});

// The sealed inventory guards macOS and Linux only; Windows keeps Dugite's Git.
describe.skipIf(process.platform === "win32")("custom Git runtime sealed inventory", () => {
  const version = "2.56.0-dev-pwrgit.9";
  const sourceRevision = "a".repeat(40);

  function fixture() {
    const root = tempRoot();
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "git"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(root, "COPYING"), "GPL-2.0-only\n");
    symlinkSync("git", join(root, "bin", "git-alias"));
    writeFileSync(join(root, "pwrgit-build.json"), JSON.stringify({
      version, source_revision: sourceRevision, primary_sha1: "SHA1_DC",
    }));
    const inventory = {};
    for (const rel of ["bin/git", "COPYING", "pwrgit-build.json"]) {
      const path = join(root, rel);
      inventory[rel] = { sha256: sha256(readFileSync(path)), mode: lstatSync(path).mode & 0o7777 };
    }
    inventory["bin/git-alias"] = { link: "git" };
    const inventoryBytes = JSON.stringify(inventory);
    writeFileSync(join(root, "runtime-files.json"), inventoryBytes);
    const pin = {
      key: "linux-x64",
      manifest: { version, source_revision: sourceRevision },
      asset: { inventory_sha256: sha256(inventoryBytes) },
    };
    return { root, pin };
  }

  const verify = (root, pin) => verifyRuntime(root, pin, { probe: false });

  it("accepts the exact sealed file set", () => {
    const { root, pin } = fixture();
    expect(verify(root, pin).version).toBe(version);
  });

  it("rejects an inventory that differs from the pinned checksum", () => {
    const { root, pin } = fixture();
    pin.asset.inventory_sha256 = "0".repeat(64);
    expect(() => verify(root, pin)).toThrow(/inventory checksum mismatch/);
  });

  it("rejects changed bytes, modes and links", () => {
    const bytes = fixture();
    writeFileSync(join(bytes.root, "COPYING"), "changed\n");
    expect(() => verify(bytes.root, bytes.pin)).toThrow(/changed: COPYING/);

    const mode = fixture();
    chmodSync(join(mode.root, "bin", "git"), 0o644);
    expect(() => verify(mode.root, mode.pin)).toThrow(/changed: bin\/git/);

    const link = fixture();
    rmSync(join(link.root, "bin", "git-alias"));
    symlinkSync("../COPYING", join(link.root, "bin", "git-alias"));
    expect(() => verify(link.root, link.pin)).toThrow(/changed: bin\/git-alias/);
  });

  it("rejects an added file and a symlink that leaves the payload", () => {
    const added = fixture();
    writeFileSync(join(added.root, "bin", "extra"), "");
    expect(() => verify(added.root, added.pin)).toThrow(/file set changed/);

    const escaping = fixture();
    symlinkSync(tmpdir(), join(escaping.root, "outside"));
    expect(() => verify(escaping.root, escaping.pin)).toThrow(/escapes payload: outside/);
  });

  it("rejects a build from another source revision", () => {
    const { root, pin } = fixture();
    pin.manifest.source_revision = "b".repeat(40);
    expect(() => verify(root, pin)).toThrow(/source\/version mismatch/);
  });
});
