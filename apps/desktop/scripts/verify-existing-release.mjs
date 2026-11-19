import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function findExistingRelease(tag, { readByTag, listReleaseTags }) {
  const response = await readByTag(tag);
  if (response.status === 404) {
    // The by-tag endpoint can hide a draft left by an interrupted create.
    const tags = await listReleaseTags();
    assert.ok(!tags.includes(tag), `Release ${tag} already exists but is unavailable by tag. Inspect the original run and release before retrying.`);
    return null;
  }
  assert.equal(response.status, 200, "Could not look up the existing GitHub Release");
  return response.json();
}

export function verifyPublishedRelease(release, assets, { tag, notes, expected }) {
  assert.equal(release.tag_name, tag);
  assert.equal(release.name, tag);
  assert.equal(release.draft, false, "Existing release is still a draft");
  assert.equal(release.prerelease, true, "Existing release is not a prerelease");
  assert.equal(release.body?.replace(/\n+$/, ""), notes.replace(/\n+$/, ""), "Existing release notes differ from the tagged changelog");
  assert.equal(assets.length, expected.size, "Existing release asset inventory is incomplete or differs from retained artifacts");
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  assert.equal(byName.size, assets.length, "Existing release has duplicate assets");
  for (const [name, { size, digest }] of expected) {
    const asset = byName.get(name);
    assert.equal(asset?.state, "uploaded", `Release asset ${name} is missing or incomplete`);
    assert.equal(asset.size, size, `Release asset ${name} has a different size`);
    assert.equal(asset.digest, digest, `Release asset ${name} has a different or unavailable digest`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, notesFile, ...files] = process.argv.slice(2);
  assert.equal(process.env.GITHUB_REPOSITORY, "pwrdrvr/PwrAgent");
  assert.match(tag, /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z]+\.[0-9]+)?$/);
  assert.ok(files.length, "Retained release assets are required");
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GH_TOKEN}` };
  const release = await findExistingRelease(tag, {
    readByTag: (name) => fetch(`https://api.github.com/repos/pwrdrvr/PwrAgent/releases/tags/${name}`,
      { headers, redirect: "error", signal: AbortSignal.timeout(30_000) }),
    // GH_TOKEN is the same publication credential, so this listing can see drafts.
    listReleaseTags: () => execFileSync("gh", ["api", "--paginate",
      "repos/pwrdrvr/PwrAgent/releases?per_page=100", "--jq", ".[].tag_name"], { encoding: "utf8" }).trim().split(/\r?\n/),
  });
  if (release === null) process.exit(4);
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0, "Invalid GitHub release ID");
  const assetPages = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp",
    `repos/pwrdrvr/PwrAgent/releases/${release.id}/assets?per_page=100`], { encoding: "utf8" }));
  const expected = new Map();
  for (const file of files) {
    const name = path.basename(file);
    const { size } = statSync(file);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    assert.ok(!expected.has(name), `Duplicate staged asset ${name}`);
    expected.set(name, { size, digest: `sha256:${hash.digest("hex")}` });
  }
  verifyPublishedRelease(release, assetPages.flat(), { tag, notes: readFileSync(notesFile, "utf8"), expected });
  console.log(`Verified ${expected.size} published assets and notes against retained artifacts for ${tag}`);
}
