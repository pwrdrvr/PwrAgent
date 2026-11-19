import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentReleaseSource, requiresReadOnlyRecovery } from "./release-context.mjs";
import { checkRegistry, readPublicRegistrySnapshot, releaseMetadata } from "./release.mjs";

function validateArtifact(input) {
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
  return { metadata, expected: { integrity, source: identity, branch: source.branch },
    receipt: { ...source, ...metadata, integrity } };
}

const minute = 60_000;
const firstVerificationDelay = 30 * minute;
const pendingVerificationDelay = 20 * minute;

function validateReceipt(receipt, base) {
  for (const key of ["version", "tag", "commit", "branch", "integrity"]) {
    assert.equal(receipt[key], base[key], `Publication receipt ${key} must match the tested artifact/source`);
  }
  const train = base.version.split(".").slice(0, 2).join(".");
  const channels = [base.distTag];
  if (base.branch === `releases/${train}`) channels.push(`release-${train}${base.distTag === "next" ? "-next" : ""}`);
  assert.ok(receipt.distTag === null || channels.includes(receipt.distTag), "Unexpected publication receipt channel");
  assert.ok(["accepted", "publish-uncertain", "verification-required", "verified-existing"].includes(receipt.status),
    "Unexpected publication attempt status");
  assert.ok(Number.isFinite(receipt.attemptedAt), "Publication receipt timestamp missing");
  assert.ok(receipt.nextCheckAt === undefined || Number.isFinite(receipt.nextCheckAt), "Invalid publication cache deadline");
}

export async function publishRelease(input, { readRegistry, publish, recordReceipt = () => {},
  previousReceipt, resume = false, now = Date.now }) {
  const { metadata, expected, receipt: base } = validateArtifact(input);
  if (previousReceipt) {
    validateReceipt(previousReceipt, base);
    await recordReceipt(previousReceipt);
    return previousReceipt;
  }
  // A retry without proof that earlier submission jobs were skipped may
  // have lost its receipt after a PUT. Continue with read-only verification.
  if (resume) {
    const receipt = { ...base, distTag: null, status: "verification-required", attemptedAt: now() };
    await recordReceipt(receipt);
    return receipt;
  }
  const { document, retryAfterMs = 0 } = await readRegistry();
  const before = checkRegistry(metadata, document, expected);
  const receipt = { ...base, distTag: before.distTag, attemptedAt: now(),
    status: before.status === "verified-existing" ? "verified-existing" : "publish-uncertain" };
  // A pre-submit packument read can carry a cache deadline too. Preserve it
  // without assuming the read caused any subsequent stale response.
  if (before.status === "unpublished" && retryAfterMs > 0) receipt.nextCheckAt = receipt.attemptedAt + retryAfterMs + 1000;
  // Persist intent before npm starts, including on an ambiguous nonzero exit.
  await recordReceipt(receipt);
  if (before.status === "verified-existing") return receipt;
  try {
    await publish(input.packed.filename, before.distTag);
  } catch (cause) {
    receipt.attemptedAt = now();
    await recordReceipt(receipt);
    throw new Error("npm publish did not confirm acceptance; publication is uncertain. Resume read-only verification; do not blindly republish.", { cause });
  }
  receipt.status = "accepted";
  receipt.attemptedAt = now();
  await recordReceipt(receipt);
  return receipt;
}

export async function verifyRelease(input, receipt, { readRegistry, previousVerification, now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const { metadata, expected, receipt: base } = validateArtifact(input);
  validateReceipt(receipt, base);
  const startedAt = now();
  const firstReadAt = receipt.status === "verified-existing" ? startedAt : receipt.attemptedAt + firstVerificationDelay;
  let nextCheckAt = Math.max(firstReadAt, receipt.nextCheckAt ?? 0);
  if (previousVerification) {
    assert.equal(previousVerification.status, "verification-pending", "Only pending verification can postpone a retry");
    validateReceipt({ ...previousVerification, status: receipt.status }, base);
    assert.ok(Number.isFinite(previousVerification.nextCheckAt), "Pending verification timestamp missing");
    nextCheckAt = Math.max(nextCheckAt, previousVerification.nextCheckAt);
  }
  // Only one observation per job. A future cache deadline outside the existing
  // runner budget is carried forward without a read or a sleep.
  if (nextCheckAt < startedAt + 40 * minute) {
    while (now() < nextCheckAt) await wait(nextCheckAt - now());
    const { document, retryAfterMs = 0 } = await readRegistry();
    const result = checkRegistry(metadata, document, { ...expected, distTag: receipt.distTag }, { verification: true });
    if (result.status === "verified-existing") {
      return { ...base, distTag: result.distTag, status: "verified-existing", publicationStatus: receipt.status, verifiedAt: now() };
    }
    nextCheckAt = now() + Math.max(pendingVerificationDelay, retryAfterMs + 1000);
  }
  return { ...receipt, status: "verification-pending", publicationStatus: receipt.status, nextCheckAt };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--verify"), "Usage: publish.mjs [--verify]");
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
  const input = { pkg, desktopVersion: desktop.version, source, packed, manifest,
    bytes: readFileSync(tarball), expectedIntegrity: process.env.EXPECTED_INTEGRITY,
    npmVersion: execFileSync("npm", ["--version"], { encoding: "utf8", env }) };
  const attemptPath = ".local/outpost-publication-attempt.json";
  if (process.argv.includes("--verify")) {
    const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
    const verificationPath = ".local/outpost-release-receipt.json";
    const previous = existsSync(verificationPath) ? JSON.parse(readFileSync(verificationPath, "utf8")) : undefined;
    // A prior success is rechecked as well; only a pending receipt carries a
    // next-read constraint. Never use a saved success as registry evidence.
    const receipt = await verifyRelease(input, attempt, { readRegistry: () => readPublicRegistrySnapshot("verification"),
      previousVerification: previous?.status === "verification-pending" ? previous : undefined });
    writeFileSync(verificationPath, JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify(receipt));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${receipt.status}\n`);
  } else {
    const receipt = await publishRelease(input, {
      readRegistry: () => readPublicRegistrySnapshot("submission-preflight"),
      previousReceipt: existsSync(attemptPath) ? JSON.parse(readFileSync(attemptPath, "utf8")) : undefined,
      resume: requiresReadOnlyRecovery(process.env.GITHUB_EVENT_NAME, process.env.GITHUB_RUN_ATTEMPT,
        process.env.PRIOR_NPM_SUBMISSIONS_SKIPPED === "true"),
      recordReceipt: (receipt) => writeFileSync(attemptPath, JSON.stringify(receipt, null, 2) + "\n"),
      publish: async (filename, distTag) => {
        // A retryable HTTP response may arrive after the registry consumes the PUT.
        execFileSync("npm", ["publish", path.join(root, filename), "--ignore-scripts", "--access", "public", "--provenance",
          "--registry", "https://registry.npmjs.org", "--tag", distTag, "--fetch-retries=0"],
        { env, stdio: ["ignore", "inherit", "inherit"] });
      },
    });
    console.log(JSON.stringify(receipt));
  }
}
