import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function retainedPackageArtifacts(artifacts) {
  const ids = {};
  for (const [key, name] of [["package", "headless-npm-package"], ["integrity", "headless-npm-integrity"]]) {
    const matches = artifacts.filter((artifact) => artifact.name === name);
    assert.ok(matches.length <= 1, `Ambiguous retained ${name}`);
    if (!matches.length) continue;
    const [artifact] = matches;
    assert.equal(artifact.expired, false, `Retained ${name} expired`);
    assert.match(String(artifact.id), /^[1-9]\d*$/);
    ids[key] = String(artifact.id);
  }
  assert.ok(!ids.package || ids.integrity, "Retained npm package is missing its independent integrity artifact");
  return ids;
}

export function checkedTarballIntegrity(pack, bytes, retained) {
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.equal(integrity, pack.integrity, "Tested tarball does not match its pack manifest");
  if (retained !== undefined) assert.equal(integrity, retained, "Tested tarball does not match retained integrity");
  return integrity;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--locate")) {
    assert.equal(process.env.GITHUB_REPOSITORY, "pwrdrvr/PwrAgent");
    assert.match(process.env.GITHUB_RUN_ID, /^\d+$/);
    const endpoint = `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/artifacts?per_page=100`;
    const pages = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", endpoint], { encoding: "utf8" }));
    const ids = retainedPackageArtifacts(pages.flatMap((page) => page.artifacts));
    for (const [key, id] of Object.entries(ids)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${id}\n`);
  } else {
    const pack = JSON.parse(readFileSync(".local/headless-package/pack.json", "utf8"));
    assert.match(pack.filename, /^pwragent-[0-9A-Za-z.-]+\.tgz$/);
    const integrityPath = ".local/headless-integrity/integrity.txt";
    const retained = process.env.RETAINED_INTEGRITY_ID ? readFileSync(integrityPath, "utf8").trim() : undefined;
    const integrity = checkedTarballIntegrity(pack, readFileSync(`.local/headless-package/${pack.filename}`), retained);
    if (!retained) {
      mkdirSync(".local/headless-integrity", { recursive: true });
      writeFileSync(integrityPath, `${integrity}\n`, { flag: "wx" });
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `integrity=${integrity}\n`);
  }
}
