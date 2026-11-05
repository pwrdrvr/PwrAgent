import { chmodSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { verifyRuntime } from "../../../scripts/stage-runtime.mjs";
import {
  verifyManagedGitPayload,
  type CustomGitPin,
} from "../managed-git-verify";
import { makeRoot, sealPayload, writePayload } from "./helpers/managed-git-fixture";

// Oracle: the shared stage-runtime.mjs that packages the bundled runtime. A
// downloaded runtime must be accepted and rejected exactly as a bundled one
// is, so both verifiers run over the same payload after the same tampering.
// The download verifier adds one rule the script leaves out (a Linux
// payload's recorded architecture must match its catalog key); payloads here
// are built with the right architecture, so the two must agree everywhere.

const version = "2.56.0-dev-pwrgit.9";
const revision = "a".repeat(40);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sealed(beforeSeal?: (root: string) => void): { root: string; pin: CustomGitPin } {
  const root = makeRoot();
  roots.push(root);
  writePayload(root, version, revision);
  beforeSeal?.(root);
  const inventorySha256 = sealPayload(root);
  return {
    root,
    pin: {
      key: "linux-x64",
      catalog: {
        schema: 1,
        version,
        source_revision: revision,
        consumer_sha256: "c".repeat(64),
        assets: {},
      },
      asset: { url: "", sha256: "0".repeat(64), inventory_sha256: inventorySha256 },
    },
  };
}

const FILES = ["bin/git", "libexec/git-core/git-lfs", "ssl/cacert.pem", "COPYING", "share/git-core/templates/description", "pwrgit-build.json"];

/** One way to change a sealed payload, and whether it should be caught. */
const tamper = fc.oneof(
  fc.record({ kind: fc.constant("bytes"), file: fc.constantFrom(...FILES), suffix: fc.string({ minLength: 1, maxLength: 4 }) }),
  fc.record({ kind: fc.constant("mode"), file: fc.constantFrom(...FILES.filter((f) => f !== "pwrgit-build.json")), bits: fc.constantFrom(0o111, 0o4000, 0o022) }),
  fc.record({ kind: fc.constant("remove"), file: fc.constantFrom(...FILES) }),
  fc.record({ kind: fc.constant("add"), file: fc.constantFrom("bin/git-extra", "libexec/git-core/git-evil", ".hidden") }),
  fc.record({ kind: fc.constant("retarget-link"), target: fc.constantFrom("git", "../COPYING", "../../../../etc/passwd") }),
  fc.record({ kind: fc.constant("escape-link"), file: fc.constantFrom("bin/escape", "share/escape") }),
  fc.record({ kind: fc.constant("replace-with-link"), file: fc.constantFrom("bin/git", "COPYING") }),
  fc.record({ kind: fc.constant("inventory"), suffix: fc.constantFrom(" ", "\n", "{}") }),
  fc.record({ kind: fc.constant("build-version"), value: fc.constantFrom("2.56.0-dev-pwrgit.8", "2.56.0") }),
  fc.record({ kind: fc.constant("none") }),
);

type Tamper = typeof tamper extends fc.Arbitrary<infer T> ? T : never;

function apply(root: string, change: Tamper): void {
  const at = (file: string) => path.join(root, file);
  switch (change.kind) {
    case "bytes":
      writeFileSync(at(change.file), `${readFileSync(at(change.file), "utf8")}${change.suffix}`);
      return;
    case "mode":
      chmodSync(at(change.file), (lstatSync(at(change.file)).mode & 0o7777) ^ change.bits);
      return;
    case "remove":
      rmSync(at(change.file));
      return;
    case "add":
      writeFileSync(at(change.file), "unsealed");
      return;
    case "retarget-link":
      rmSync(at("bin/git-lfs"));
      symlinkSync(change.target, at("bin/git-lfs"));
      return;
    case "escape-link":
      symlinkSync("/etc/hosts", at(change.file));
      return;
    case "replace-with-link":
      rmSync(at(change.file));
      symlinkSync("../pwrgit-build.json", at(change.file));
      return;
    case "inventory":
      writeFileSync(at("runtime-files.json"), `${readFileSync(at("runtime-files.json"), "utf8")}${change.suffix}`);
      return;
    case "build-version": {
      const build = JSON.parse(readFileSync(at("pwrgit-build.json"), "utf8"));
      build.version = change.value;
      writeFileSync(at("pwrgit-build.json"), JSON.stringify(build));
      return;
    }
    case "none":
      return;
  }
}

async function ours(root: string, pin: CustomGitPin): Promise<boolean> {
  try {
    await verifyManagedGitPayload(root, pin, { probe: false, requireSigned: false });
    return true;
  } catch {
    return false;
  }
}

function oracle(root: string, pin: CustomGitPin): boolean {
  try {
    verifyRuntime(root, { key: pin.key, manifest: pin.catalog, asset: pin.asset }, { probe: false, requireSigned: false });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("downloaded Git verifier against the packaging oracle", () => {
  it("accepts and rejects exactly what stage-runtime.mjs does, for any one change", async () => {
    await fc.assert(fc.asyncProperty(tamper, async (change) => {
      const { root, pin } = sealed();
      apply(root, change);
      const expected = oracle(root, pin);
      expect(await ours(root, pin)).toBe(expected);
      // Only an untouched payload is acceptable; every listed change is a
      // tamper the seal must catch.
      expect(expected).toBe(change.kind === "none");
    }), { numRuns: 120 });
  });

  it("rejects a sealed link that leaves the payload, as the script does", async () => {
    // The seal lists the link, so only the escape rule can catch it.
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("bin/escape", "share/git-core/escape"),
      fc.constantFrom("/etc/hosts", "../../..", "../../../.."),
      async (file, target) => {
        const { root, pin } = sealed((payload) => symlinkSync(target, path.join(payload, file)));
        expect(oracle(root, pin)).toBe(false);
        await expect(verifyManagedGitPayload(root, pin, { probe: false, requireSigned: false }))
          .rejects.toThrow(/escapes payload/);
      },
    ), { numRuns: 6 });
  });

  it("rejects resealed build metadata that names another source, as the script does", async () => {
    // Resealing defeats the inventory hash, so only the metadata rule is left.
    await fc.assert(fc.asyncProperty(
      fc.oneof(
        fc.record({ field: fc.constant("version"), value: fc.constantFrom("2.56.0-dev-pwrgit.8", "2.56.0", "") }),
        fc.record({ field: fc.constant("source_revision"), value: fc.constantFrom("b".repeat(40), revision.slice(0, 39), "") }),
        fc.record({ field: fc.constant("primary_sha1"), value: fc.constantFrom("OPENSSL", "sha1dc", "") }),
      ),
      async ({ field, value }) => {
        const { root, pin } = sealed((payload) => {
          const file = path.join(payload, "pwrgit-build.json");
          writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), [field]: value }));
        });
        expect(oracle(root, pin)).toBe(false);
        await expect(verifyManagedGitPayload(root, pin, { probe: false, requireSigned: false }))
          .rejects.toThrow(/mismatch/);
      },
    ), { numRuns: 12 });
  });

  it("also rejects a Linux payload built for the other architecture", async () => {
    const { root, pin } = sealed();
    const arm = { ...pin, key: "linux-arm64" as const };
    // The script has no architecture rule; the download path must not
    // install an arm64 runtime on x64 or the reverse.
    expect(oracle(root, arm)).toBe(true);
    await expect(verifyManagedGitPayload(root, arm, { probe: false })).rejects.toThrow(/Expected arm64 Git/);
  });
});
