import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { publishRelease, verifyRelease } from "./publish.mjs";
import { requiresReadOnlyRecovery } from "./release-context.mjs";
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
  pwragentRelease: { ...source }, dist: { integrity, attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } } },
} } });

test("records acceptance after publishing once without any immediate registry verification", async () => {
  let reads = 0;
  const calls = [];
  const result = await publishRelease(input(), {
    readRegistry: async () => {
      assert.equal(++reads, 1, "must not read after publish");
      return { document: registry() };
    },
    publish: async (filename, tag) => calls.push([filename, tag]),
  });
  assert.deepEqual(calls, [["pwragent-1.3.7.tgz", "latest"]]);
  assert.equal(result.status, "accepted");
  assert.equal(result.integrity, integrity);
  assert.equal(result.commit, source.commit);
});

test("an identical published version is a verified retry without any npm mutation", async () => {
  const result = await publishRelease(input(), { readRegistry: async () => ({ document: published() }),
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
    return { document: registry() };
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
  assert.equal((await publishRelease(input(), { readRegistry: async () => ({ document }),
    publish: async () => assert.fail("must not mutate channel") })).status, "verified-existing");
});

test("source, artifact, ownership, channel and OIDC prerequisites fail before publishing", async () => {
  for (const change of [{ bytes: Buffer.from("tampered") }, { expectedIntegrity: "sha512-other" },
    { desktopVersion: "1.3.8" }, { npmVersion: "11.5.0" },
    { packed: { ...input().packed, release: { ...source, commit: "b".repeat(40) } } },
    { manifest: { ...input().manifest, pwragentRelease: undefined } }]) {
    await assert.rejects(publishRelease({ ...input(), ...change }, { readRegistry: async () => ({ document: registry() }),
      publish: async () => assert.fail("invalid input published") }));
  }
  for (const change of [{ maintainers: [] }, { "dist-tags": {} },
    { versions: { "0.0.0": {}, "1.3.7": { pwragentRelease: source, dist: { integrity: "wrong" } } } }]) {
    await assert.rejects(publishRelease(input(), { readRegistry: async () => ({ document: { ...registry(), ...change } }),
      publish: async () => assert.fail("invalid registry published") }));
  }
});

test("an occupied version with different source or no provenance is never accepted as success", async () => {
  for (const change of [{ pwragentRelease: { ...source, commit: "b".repeat(40) } },
    { dist: { integrity } }, { dist: { integrity: "wrong", attestations: {} } }]) {
    const document = published();
    Object.assign(document.versions["1.3.7"], change);
    await assert.rejects(publishRelease(input(), { readRegistry: async () => ({ document }),
      publish: async () => assert.fail("must not overwrite") }));
  }
});

const minute = 60_000;
const receipt = (status = "accepted") => ({ ...source, version: "1.3.7", distTag: "latest", integrity,
  status, attemptedAt: 0 });
function verifier(documents, startedAt = 0) {
  let time = startedAt;
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

test("the first read is gated by submission time and all retained deadlines", async () => {
  for (const status of ["accepted", "publish-uncertain", "verification-required"]) {
    for (const elapsed of [0, 1, 29, 30, 31, 90]) {
      for (const savedDeadline of [0, 25, 30, 37]) {
        const startedAt = elapsed * minute;
        const harness = verifier([published()], startedAt);
        const attempt = receipt(status);
        const previousVerification = { ...attempt, status: "verification-pending", nextCheckAt: savedDeadline * minute };
        const result = await verifyRelease(input(), attempt, { ...harness.deps, previousVerification });
        assert.deepEqual(harness.reads, [Math.max(elapsed, 30, savedDeadline) * minute],
          JSON.stringify({ status, elapsed, savedDeadline }));
        assert.equal(result.status, "verified-existing");
        assert.equal(result.publicationStatus, status);
      }
    }
  }
});

test("a stale first read persists its deadline and a fresh runner resumes when due", async () => {
  const first = verifier([{ document: registry(), retryAfterMs: 60 * minute }]);
  const pending = await verifyRelease(input(), receipt(), first.deps);
  assert.deepEqual(first.reads, [30 * minute]);
  assert.equal(pending.status, "verification-pending");
  assert.equal(pending.publicationStatus, "accepted");
  assert.equal(pending.integrity, integrity);
  assert.equal(pending.nextCheckAt, 90 * minute + 1000);

  const early = verifier([], 31 * minute);
  assert.deepEqual(await verifyRelease(input(), receipt(), { ...early.deps, previousVerification: pending }), pending);
  assert.deepEqual(early.waits, []);
  assert.deepEqual(early.reads, []);

  const due = verifier([published()], pending.nextCheckAt);
  const result = await verifyRelease(input(), receipt(), { ...due.deps, previousVerification: pending });
  assert.equal(result.status, "verified-existing");
  assert.equal(result.publicationStatus, "accepted");
  assert.equal(result.verifiedAt, pending.nextCheckAt);
  assert.deepEqual(due.waits, []);
});

test("pre-submit cache hints survive acceptance and can postpone the first verification", async () => {
  let time = 0;
  const accepted = await publishRelease(input(), {
    now: () => time,
    readRegistry: async () => ({ document: registry(), retryAfterMs: 70 * minute }),
    publish: async () => { time = minute; },
  });
  const harness = verifier([], time);
  const pending = await verifyRelease(input(), accepted, harness.deps);
  assert.equal(pending.nextCheckAt, 70 * minute + 1000);
  assert.equal(pending.publicationStatus, "accepted");
  assert.deepEqual(harness.reads, []);
});

test("registry cache lifetime and Retry-After are independent lower bounds", () => {
  const headers = (values) => new Headers(values);
  assert.equal(registryRetryDelay(headers({ "cache-control": "public, max-age=300", age: "100" })), 200_000);
  assert.equal(registryRetryDelay(headers({ "cache-control": "max-age=60, s-maxage=900", age: "100" })), 800_000);
  assert.equal(registryRetryDelay(headers({ "cache-control": "max-age=60", age: "100", "retry-after": "120" })), 120_000);
  assert.equal(registryRetryDelay(headers({ "retry-after": "Thu, 01 Jan 1970 00:10:00 GMT" }), 0), 10 * minute);
  assert.equal(registryRetryDelay(headers({ "retry-after": "invalid" })), 0);
});

test("missing metadata stays pending across runs until provenance and channel become visible", async () => {
  const noProvenance = published();
  delete noProvenance.versions["1.3.7"].dist.attestations;
  const oldChannel = published();
  oldChannel["dist-tags"].latest = "0.0.0";
  let pending;
  let startedAt = 0;
  const attempt = receipt();
  for (const document of [registry(), noProvenance, oldChannel]) {
    const harness = verifier([document], startedAt);
    pending = await verifyRelease(input(), attempt, { ...harness.deps, previousVerification: pending });
    assert.equal(pending.status, "verification-pending");
    assert.deepEqual(harness.reads, [Math.max(startedAt, 30 * minute)]);
    assert.equal(pending.nextCheckAt, harness.reads[0] + 20 * minute);
    assert.equal(pending.publicationStatus, "accepted");
    startedAt = pending.nextCheckAt;
  }
  const harness = verifier([published()], startedAt);
  assert.equal((await verifyRelease(input(), attempt, { ...harness.deps, previousVerification: pending })).status, "verified-existing");
});

test("verification fails immediately for conflicting bytes/source, invalid owner or invalid provenance", async () => {
  for (const [change, error] of [
    [(doc) => { doc.versions["1.3.7"].dist.integrity = "wrong"; }, /different bytes/],
    [(doc) => { doc.versions["1.3.7"].pwragentRelease.commit = "b".repeat(40); }, /different source metadata/],
    [(doc) => { doc.maintainers = []; }, /Expected npm owner/],
    [(doc) => { doc.versions["1.3.7"].dist.attestations.provenance.predicateType = "invalid"; }, /missing provenance/],
  ]) {
    const document = published();
    change(document);
    const harness = verifier([document]);
    await assert.rejects(verifyRelease(input(), receipt(), harness.deps), error);
    assert.deepEqual(harness.reads, [30 * minute]);
  }
});

test("uncertain or authentication failure records intent and fails, while recovery never republishes", async () => {
  for (const message of ["socket closed after PUT", "npm E401 unauthorized", "npm E403 forbidden"]) {
    let saved;
    await assert.rejects(publishRelease(input(), {
      now: () => 0,
      readRegistry: async () => ({ document: registry() }),
      recordReceipt: (value) => { saved = structuredClone(value); },
      publish: async () => {
        assert.equal(saved.status, "publish-uncertain", "intent must be retained before invoking npm");
        throw new Error(message);
      },
    }), (error) => error.cause.message === message && /uncertain/.test(error.message));
    const recovered = await publishRelease(input(), { previousReceipt: saved,
      readRegistry: async () => assert.fail("recovery must defer reads"),
      publish: async () => assert.fail("recovery must not republish") });
    const stale = verifier([registry()]);
    assert.equal((await verifyRelease(input(), recovered, stale.deps)).status, "verification-pending");
    const visible = verifier([published()]);
    assert.equal((await verifyRelease(input(), recovered, visible.deps)).status, "verified-existing");
  }
});

test("only the first tag push attempt can PUT, even when retries and dispatches lose the receipt", async () => {
  let writes = 0;
  let reads = 0;
  let saved;
  const deps = {
    now: () => 0,
    readRegistry: async () => { reads++; return { document: registry() }; },
    publish: async () => { writes++; },
    recordReceipt: (value) => { saved = structuredClone(value); },
  };
  const original = await publishRelease(input(), { ...deps, resume: requiresReadOnlyRecovery("push", "1") });
  assert.equal(original.status, "accepted");
  for (const event of ["push", "workflow_dispatch"]) {
    for (const attempt of [undefined, "1", "2", "3"]) {
      if (event === "push" && attempt === "1") continue;
      for (const previousReceipt of [original, undefined]) {
        const recovered = await publishRelease(input(), { ...deps, previousReceipt, resume: requiresReadOnlyRecovery(event, attempt) });
        assert.equal(saved.status, previousReceipt ? "accepted" : "verification-required");
        const harness = verifier([published()]);
        assert.equal((await verifyRelease(input(), recovered, harness.deps)).status, "verified-existing");
      }
    }
  }
  assert.equal(writes, 1);
  assert.equal(reads, 1);
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
  await assert.rejects(verifyRelease(input(), receipt(), { now: () => 30 * minute,
    readRegistry: async () => { throw new Error("registry unavailable"); } }), /registry unavailable/);
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
