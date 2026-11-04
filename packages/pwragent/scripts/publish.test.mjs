import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { publishRelease, verifyRelease } from "./publish.mjs";
import { registryRetryDelay } from "./release.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const source = { tag: "v1.3.7", commit: "a".repeat(40) };
const bytes = Buffer.from("tested tarball fixture");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const input = () => ({ pkg: { ...structuredClone(pkg), version: "1.3.7", publishConfig: { ...pkg.publishConfig, tag: "latest" } },
  desktopVersion: "1.3.7", source, bytes, expectedIntegrity: integrity, npmVersion: "11.5.1",
  packed: { filename: "pwragent-1.3.7.tgz", version: "1.3.7", integrity, release: source },
  manifest: { ...structuredClone(pkg), version: "1.3.7", publishConfig: { ...pkg.publishConfig, tag: "latest" }, pwragentRelease: source } });
const registry = () => ({ name: "pwragent", maintainers: [{ name: "huntharo" }],
  versions: { "0.0.0": {} }, "dist-tags": { latest: "0.0.0" } });
const published = () => ({ ...registry(), "dist-tags": { latest: "1.3.7" }, versions: { "0.0.0": {}, "1.3.7": {
  pwragentRelease: source, dist: { integrity, attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } } },
} } });

test("records acceptance after publishing once without any immediate registry verification", async () => {
  let reads = 0;
  const calls = [];
  const result = await publishRelease(input(), {
    readRegistry: async () => {
      assert.equal(++reads, 1, "must not read after publish");
      return registry();
    },
    publish: async (filename, tag) => calls.push([filename, tag]),
  });
  assert.deepEqual(calls, [["pwragent-1.3.7.tgz", "latest"]]);
  assert.equal(result.status, "accepted");
  assert.equal(result.integrity, integrity);
  assert.equal(result.commit, source.commit);
});

test("an identical published version is a verified retry without any npm mutation", async () => {
  const result = await publishRelease(input(), { readRegistry: async () => published(),
    publish: async () => assert.fail("must not republish immutable version") });
  assert.equal(result.status, "verified-existing");
});

test("prerelease desktop versions publish to next with the exact prerelease version", async () => {
  const version = "1.4.0-prerelease.2";
  const request = input();
  request.source = { ...source, tag: `v${version}` };
  request.desktopVersion = version;
  request.pkg = { ...request.pkg, version, publishConfig: { ...pkg.publishConfig, tag: "next" } };
  request.manifest = { ...request.pkg, pwragentRelease: request.source };
  request.packed = { ...request.packed, filename: `pwragent-${version}.tgz`, version, release: request.source };
  const document = published();
  document.versions[version] = { ...document.versions["1.3.7"], pwragentRelease: request.source };
  document["dist-tags"].next = version;
  let reads = 0;
  const calls = [];
  const result = await publishRelease(request, { now: () => 0, readRegistry: async () => {
    assert.equal(++reads, 1);
    return registry();
  },
    publish: async (filename, tag) => calls.push([filename, tag]) });
  assert.deepEqual(calls, [[`pwragent-${version}.tgz`, "next"]]);
  assert.equal(result.version, version);
  assert.equal((await verifyRelease(request, result, verifier([document]).deps)).distTag, "next");
});

test("retry verifies an older identical version without rolling a later channel backwards", async () => {
  const document = published();
  document.versions["1.3.8"] = {};
  document["dist-tags"].latest = "1.3.8";
  assert.equal((await publishRelease(input(), { readRegistry: async () => document,
    publish: async () => assert.fail("must not mutate channel") })).status, "verified-existing");
});

test("source, artifact, ownership, channel and OIDC prerequisites fail before publishing", async () => {
  for (const change of [{ bytes: Buffer.from("tampered") }, { expectedIntegrity: "sha512-other" },
    { desktopVersion: "1.3.8" }, { npmVersion: "11.5.0" },
    { packed: { ...input().packed, release: { ...source, commit: "b".repeat(40) } } },
    { manifest: { ...input().manifest, pwragentRelease: undefined } }]) {
    await assert.rejects(publishRelease({ ...input(), ...change }, { readRegistry: async () => registry(),
      publish: async () => assert.fail("invalid input published") }));
  }
  for (const change of [{ maintainers: [] }, { "dist-tags": {} },
    { versions: { "0.0.0": {}, "1.3.7": { pwragentRelease: source, dist: { integrity: "wrong" } } } }]) {
    await assert.rejects(publishRelease(input(), { readRegistry: async () => ({ ...registry(), ...change }),
      publish: async () => assert.fail("invalid registry published") }));
  }
});

test("an occupied version with different source or no provenance is never accepted as success", async () => {
  for (const change of [{ pwragentRelease: { ...source, commit: "b".repeat(40) } },
    { dist: { integrity } }, { dist: { integrity: "wrong", attestations: {} } }]) {
    const document = published();
    Object.assign(document.versions["1.3.7"], change);
    await assert.rejects(publishRelease(input(), { readRegistry: async () => document,
      publish: async () => assert.fail("must not overwrite") }));
  }
});

const minute = 60_000;
const receipt = (status = "accepted") => ({ ...source, version: "1.3.7", distTag: "latest", integrity,
  status, attemptedAt: 0 });
function verifier(documents) {
  let time = 0;
  const waits = [];
  const reads = [];
  return { waits, reads, deps: {
    now: () => time,
    wait: async (ms) => { waits.push(ms); time += ms; },
    readRegistry: async () => {
      reads.push(time);
      const next = documents.shift();
      assert.ok(next, "unexpected extra registry read");
      return next.document ? next : { document: next };
    },
  } };
}

test("deferred verification waits before reading and backs off across stale full documents", async () => {
  const harness = verifier([registry(), registry(), published()]);
  const result = await verifyRelease(input(), receipt(), harness.deps);
  assert.deepEqual(harness.reads, [5 * minute, 15 * minute, 35 * minute]);
  assert.equal(result.status, "verified-existing");
  assert.equal(result.integrity, integrity);
  assert.equal(result.verifiedAt, 35 * minute);
});

test("cache lifetime and Retry-After can only postpone the verification schedule", async () => {
  const harness = verifier([{ document: registry(), retryAfterMs: 12 * minute }, published()]);
  assert.equal((await verifyRelease(input(), receipt(), harness.deps)).status, "verified-existing");
  assert.deepEqual(harness.waits, [5 * minute, 12 * minute + 1000]);
  const headers = (values) => new Headers(values);
  assert.equal(registryRetryDelay(headers({ "cache-control": "public, max-age=300", age: "100" })), 200_000);
  assert.equal(registryRetryDelay(headers({ "cache-control": "max-age=60, s-maxage=900", age: "100" })), 800_000);
  assert.equal(registryRetryDelay(headers({ "cache-control": "max-age=60", age: "100", "retry-after": "120" })), 120_000);
  assert.equal(registryRetryDelay(headers({ "retry-after": "Thu, 01 Jan 1970 00:10:00 GMT" }), 0), 10 * minute);
  assert.equal(registryRetryDelay(headers({ "retry-after": "invalid" })), 0);
});

test("long cache hints and persistently stale metadata remain pending, never unpublished or verified", async () => {
  for (const documents of [[registry(), registry(), registry()], [{ document: registry(), retryAfterMs: 60 * minute }]]) {
    const harness = verifier(documents);
    const result = await verifyRelease(input(), receipt(), harness.deps);
    assert.equal(result.status, "verification-pending");
    assert.ok(result.nextCheckAt >= 40 * minute);
    assert.equal(result.integrity, integrity);
  }
});

test("late provenance and stale channel metadata defer verification without weakening guards", async () => {
  const noProvenance = published();
  delete noProvenance.versions["1.3.7"].dist.attestations;
  const oldChannel = published();
  oldChannel["dist-tags"].latest = "0.0.0";
  const harness = verifier([noProvenance, oldChannel, published()]);
  assert.equal((await verifyRelease(input(), receipt(), harness.deps)).status, "verified-existing");
  assert.equal(harness.reads.length, 3);
  const neverProvenance = verifier([noProvenance, noProvenance, noProvenance]);
  assert.equal((await verifyRelease(input(), receipt(), neverProvenance.deps)).status, "verification-pending");
});

test("verification fails immediately for conflicting bytes/source, invalid owner or invalid provenance", async () => {
  for (const change of [
    (doc) => { doc.versions["1.3.7"].dist.integrity = "wrong"; },
    (doc) => { doc.versions["1.3.7"].pwragentRelease.commit = "b".repeat(40); },
    (doc) => { doc.maintainers = []; },
    (doc) => { doc.versions["1.3.7"].dist.attestations.provenance.predicateType = "invalid"; },
  ]) {
    const document = structuredClone(published());
    change(document);
    const harness = verifier([document]);
    await assert.rejects(verifyRelease(input(), receipt(), harness.deps));
    assert.equal(harness.reads.length, 1);
  }
});

test("uncertain or authentication failure records intent and fails, while recovery never republishes", async () => {
  for (const message of ["socket closed after PUT", "npm E401 unauthorized", "npm E403 forbidden"]) {
    let saved;
    await assert.rejects(publishRelease(input(), {
      now: () => 0,
      readRegistry: async () => registry(),
      recordReceipt: (value) => { saved = structuredClone(value); },
      publish: async () => {
        assert.equal(saved.status, "publish-uncertain", "intent must be retained before invoking npm");
        throw new Error(message);
      },
    }), (error) => error.cause.message === message && /uncertain/.test(error.message));
    const recovered = await publishRelease(input(), { previousReceipt: saved,
      readRegistry: async () => assert.fail("recovery must defer reads"),
      publish: async () => assert.fail("recovery must not republish") });
    const stale = verifier([registry(), registry(), registry()]);
    assert.equal((await verifyRelease(input(), recovered, stale.deps)).status, "verification-pending");
    const visible = verifier([published()]);
    assert.equal((await verifyRelease(input(), recovered, visible.deps)).status, "verified-existing");
  }
});

test("accepted attempts and retries with a lost receipt cannot publish again", async () => {
  for (const previousReceipt of [receipt(), undefined]) {
    const recovered = await publishRelease(input(), { previousReceipt, resume: true, now: () => 0,
      readRegistry: async () => assert.fail("retry must defer registry verification"),
      publish: async () => assert.fail("retry must not republish") });
    assert.equal(recovered.status, previousReceipt ? "accepted" : "verification-required");
    const harness = verifier([published()]);
    assert.equal((await verifyRelease(input(), recovered, harness.deps)).status, "verified-existing");
  }
});

test("receipt identity and channel must match the protected source and tested bytes", async () => {
  for (const change of [{ integrity: "wrong" }, { commit: "b".repeat(40) }, { version: "1.3.8" },
    { tag: "v1.3.8" }, { branch: "releases/1.3" }, { distTag: "release-1.3" }, { status: "published" }]) {
    const previousReceipt = { ...receipt(), ...change };
    await assert.rejects(publishRelease(input(), { previousReceipt,
      publish: async () => assert.fail("invalid receipt published") }));
    await assert.rejects(verifyRelease(input(), previousReceipt, verifier([]).deps));
  }
});

test("registry unavailability fails closed before publishing or during verification", async () => {
  await assert.rejects(publishRelease(input(), { readRegistry: async () => { throw new Error("registry unavailable"); },
    publish: async () => assert.fail("must fail closed") }), /registry unavailable/);
  await assert.rejects(verifyRelease(input(), receipt(), { wait: async () => {},
    readRegistry: async () => { throw new Error("registry unavailable"); } }), /registry unavailable/);
});

test("a verifier retry respects the prior cache deadline even when the acceptance is old", async () => {
  const harness = verifier([published()]);
  const previousVerification = { ...receipt(), status: "verification-pending", nextCheckAt: 25 * minute };
  const result = await verifyRelease(input(), receipt(), { ...harness.deps, previousVerification });
  assert.equal(result.status, "verified-existing");
  assert.deepEqual(harness.reads, [25 * minute]);
});

test("verification-only occupied-version recovery preserves later and maintenance channels", async () => {
  const later = published();
  later.versions["1.3.8"] = {};
  later["dist-tags"].latest = "1.3.8";
  assert.equal((await verifyRelease(input(), receipt(), verifier([later]).deps)).distTag, "latest");
  const request = input();
  request.source = { ...source, branch: "releases/1.3" };
  const maintenance = published();
  maintenance.versions["1.4.0"] = {};
  maintenance["dist-tags"] = { latest: "1.4.0", "release-1.3": "1.3.7" };
  const attempt = { ...receipt(), branch: "releases/1.3", distTag: "release-1.3" };
  assert.equal((await verifyRelease(request, attempt, verifier([maintenance]).deps)).distTag, "release-1.3");
  assert.equal((await verifyRelease(request, { ...attempt, distTag: null }, verifier([maintenance]).deps)).distTag, "release-1.3");
});
