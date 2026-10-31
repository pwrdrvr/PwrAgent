import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentReleaseSource } from "./release-context.mjs";
import { checkRegistry, readPublicRegistry, releaseMetadata } from "./release.mjs";

export async function publishRelease(input, { readRegistry, publish }) {
  const { pkg, desktopVersion, source, packed, bytes, manifest, expectedIntegrity, npmVersion } = input;
  const identity = { tag: source.tag, commit: source.commit };
  const metadata = releaseMetadata(pkg, { tag: source.tag, desktopVersion });
  const [major, minor, patch] = npmVersion.trim().split(".").map(Number);
  assert.ok(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))),
    "npm >=11.5.1 required for trusted publishing");
  assert.equal(packed.filename, `pwragent-${metadata.version}.tgz`);
  assert.equal(packed.version, metadata.version);
  assert.deepEqual(packed.release, identity, "Artifact source must match the protected desktop tag");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(integrity, packed.integrity, "Artifact integrity mismatch");
  assert.equal(integrity, expectedIntegrity, "Artifact must match the validation job's tested tarball integrity");
  assert.deepEqual(releaseMetadata(manifest, { tag: source.tag, desktopVersion }), metadata);
  assert.deepEqual(manifest.pwragentRelease, identity, "Tarball source must match the desktop source commit");
  const expected = { integrity, source: identity, branch: source.branch };
  const before = checkRegistry(metadata, await readRegistry(), expected);
  if (before.status === "verified-existing") return { ...before, ...source, ...metadata, distTag: before.distTag, integrity };
  // A thrown/ambiguous npm failure remains a failed release. A retry can verify
  // the now-visible immutable bytes, but this run never assumes npm succeeded.
  await publish(packed.filename, before.distTag);
  const after = checkRegistry(metadata, await readRegistry(), expected);
  assert.equal(after.status, "verified-existing", "npm publish returned but the tested version is not visible in the registry");
  assert.equal(after.distTag, before.distTag, "npm release channel changed during publication");
  return { ...source, ...metadata, distTag: after.distTag, integrity, status: "published" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = currentReleaseSource();
  const root = path.resolve(".local/headless-package");
  const packed = JSON.parse(readFileSync(path.join(root, "pack.json"), "utf8"));
  assert.match(packed.filename, /^pwragent-[0-9A-Za-z.-]+\.tgz$/);
  const tarball = path.join(root, packed.filename);
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const desktop = JSON.parse(readFileSync(new URL("../../../apps/desktop/package.json", import.meta.url), "utf8"));
  // Use an empty user config and no credential fallback. setup-node does not
  // create a token-bearing npmrc in this job; the hosted runner supplies OIDC.
  const npmrc = path.join(process.env.RUNNER_TEMP, "outpost-empty.npmrc");
  writeFileSync(npmrc, "");
  const env = { ...process.env, NODE_AUTH_TOKEN: "", NPM_TOKEN: "", NPM_CONFIG_USERCONFIG: npmrc };
  let reads = 0;
  const receipt = await publishRelease({ pkg, desktopVersion: desktop.version, source, packed, manifest,
    bytes: readFileSync(tarball), expectedIntegrity: process.env.EXPECTED_INTEGRITY,
    npmVersion: execFileSync("npm", ["--version"], { encoding: "utf8", env }) }, {
    readRegistry: async () => {
      // After publish, allow bounded registry propagation. Conflicting bytes,
      // ownership and provenance fail in publishRelease, never via a fallback.
      if (reads++ === 0) return readPublicRegistry();
      for (let attempt = 0; attempt < 6; attempt++) {
        const document = await readPublicRegistry();
        const version = document.versions?.[pkg.version];
        if (version?.dist?.attestations?.provenance || attempt === 5) return document;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    },
    publish: async (filename, distTag) => {
      execFileSync("npm", ["publish", path.join(root, filename), "--ignore-scripts", "--access", "public", "--provenance",
        "--registry", "https://registry.npmjs.org", "--tag", distTag], { env, stdio: "inherit" });
    },
  });
  writeFileSync(".local/outpost-release-receipt.json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
}
