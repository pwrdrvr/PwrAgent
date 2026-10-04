const { test } = require("node:test");
const assert = require("node:assert/strict");
const lib = import("./package-manager-release.mjs");
const version = "1.1.4";
const repo = "pwrdrvr/PwrAgent";
const names = [`PwrAgent-${version}-arm64.dmg`, `PwrAgent-${version}-universal.dmg`, `PwrAgent-${version}-windows-x64-setup.exe`, "PwrAgent-macos-SHA256SUMS", "PwrAgent-windows-SHA256SUMS"];
const hashes = Object.fromEntries(names.slice(0, 3).map((name, index) => [name, String(index + 1).repeat(64)]));
const release = {
  tag_name: `v${version}`, draft: false, prerelease: false,
  html_url: `https://github.com/${repo}/releases/tag/v${version}`,
  assets: names.map((name) => ({ name, size: 3, digest: hashes[name] && `sha256:${hashes[name]}`, browser_download_url: `https://github.com/${repo}/releases/download/v${version}/${name}` })),
};
const result = (items) => ({ incomplete_results: false, total_count: items.length, items });
const encoded = (text) => ({ encoding: "base64", content: Buffer.from(text).toString("base64") });
function fixture(files, published = true, override = () => undefined) {
  return (endpoint) => {
    const custom = override(endpoint);
    if (custom !== undefined) return custom;
    if (/^repos\/[^/]+\/[^/?]+$/.test(endpoint)) return { private: false, default_branch: "main" };
    if (endpoint.endsWith("releases/latest")) return release;
    if (endpoint.includes("/releases?")) return [release];
    if (endpoint.startsWith("search/")) return result([]);
    if (endpoint.includes("/contents/")) {
      if (!published) return null;
      if (endpoint.includes("/Casks/pwragent.rb")) return encoded(files["Casks/pwragent.rb"]);
      if (endpoint.includes(".installer.yaml")) return encoded(files[`manifests/p/PwrDrvr/PwrAgent/${version}/PwrDrvr.PwrAgent.installer.yaml`]);
      return [{ type: "dir", name: version }];
    }
    throw new Error(`Unexpected test read: ${endpoint}`);
  };
}
function runtime(responses) {
  const calls = [];
  const waits = [];
  return {
    calls, waits, env: { GH_TOKEN: "write-fixture", DISTRIBUTION_READ_TOKEN: "read-fixture", GH_DEBUG: "api" },
    now: () => 0,
    sleep: (delay) => waits.push(delay),
    run: (...args) => { calls.push(args); return responses.shift(); },
  };
}
function response(status, body, headers = "") {
  return { status: status === 200 ? 0 : 1, stdout: `HTTP/2.0 ${status}\r\n${headers}\r\n${JSON.stringify(body)}`, stderr: "private raw error must not escape" };
}

test("reports authoritative architecture-specific sources/hashes and matching versions", async () => {
  const { auditChannels, renderPackages } = await lib;
  const audit = auditChannels(fixture(renderPackages(release, hashes)));
  assert.equal(audit.status, "complete");
  assert.equal(audit.homebrew.comparison, "matches-github-latest");
  assert.equal(audit.winget.comparison, "matches-github-latest");
  assert.deepEqual(audit.homebrew.installers.map((i) => i.architecture), ["arm64", "universal"]);
  assert.deepEqual(audit.winget.installers.map((i) => i.scope), ["user", "machine"]);
  assert.equal(audit.homebrew.installers[0].url, release.assets[0].browser_download_url);
  assert.equal(audit.winget.installers[0].sha256, hashes[names[2]]);
  assert.match(audit.winget.source, /blob\/main\/manifests/);
  assert.match(audit.verification, /refreshed-client validation remain required/);
});

test("reports absent initial registrations with pending and closed submission links", async () => {
  const { auditChannels } = await lib;
  const api = fixture({}, false, (endpoint) => endpoint.startsWith("search/issues")
    ? result([{ html_url: "https://github.com/example/pull/1", title: "PwrAgent", state: "open", draft: true }]) : undefined);
  const audit = auditChannels(api);
  assert.equal(audit.status, "complete");
  assert.equal(audit.winget.version, null);
  assert.equal(audit.homebrew.version, null);
  assert.equal(audit.winget.comparison, "not-published-at-known-path");
  assert.equal(audit.winget.pending[0].draft, true);
  assert.equal(audit.homebrew.submissions[0].url, "https://github.com/example/pull/1");
});

test("blocks alternate identities, official Homebrew ownership and checksum/source drift", async () => {
  const { auditChannels, renderPackages } = await lib;
  const files = renderPackages(release, hashes);
  for (const [target, path] of [["microsoft/winget-pkgs", "manifests/o/Other/PwrAgent/1.1.4.yaml"], ["Homebrew/homebrew-core", "Formula/p/pwragent.rb"], ["pwrdrvr/homebrew-tap", "Casks/pwragent-beta.rb"]]) {
    const audit = auditChannels(fixture(files, true, (endpoint) => endpoint.startsWith("search/code") && decodeURIComponent(endpoint).includes(`repo:${target}`)
      ? result([{ path, html_url: `https://github.com/${target}/blob/main/${path}` }]) : undefined));
    assert.equal(audit.status, "blocked");
    assert.ok(audit.blockers.length);
  }
  const bad = { ...files, "Casks/pwragent.rb": files["Casks/pwragent.rb"].replace(hashes[names[0]], "f".repeat(64)) };
  assert.match(auditChannels(fixture(bad)).blockers[0], /checksum differs/);
  const alias = { ...files, "Casks/pwragent.rb": files["Casks/pwragent.rb"].replace("releases/download/v#{version}/PwrAgent-#{version}-#{arch}.dmg", "releases/latest/download/PwrAgent.dmg") };
  assert.equal(auditChannels(fixture(alias)).status, "blocked");
});

test("refuses unknown source layouts and unreadable/private search repositories", async () => {
  const { auditChannels, renderPackages, caskMetadata, wingetMetadata } = await lib;
  const files = renderPackages(release, hashes);
  assert.throws(() => caskMetadata(files["Casks/pwragent.rb"].replace('arm: "arm64"', 'arm: "x64"')), /architectures changed/);
  assert.throws(() => wingetMetadata("PackageIdentifier: Other.Agent\n", version), /identity/);
  assert.throws(() => auditChannels(fixture(files, true, (endpoint) => endpoint === "repos/microsoft/winget-pkgs" ? { private: true, default_branch: "master" } : undefined)), /confirmed readable/);
  assert.throws(() => auditChannels(() => { throw new Error("HTTP 403"); }), /HTTP 403/);
});

test("paginates searches completely and rejects changing, duplicate, truncated and incomplete pages", async () => {
  const { ghJson } = await lib;
  const first = Array.from({ length: 100 }, (_, id) => ({ id }));
  const page = (total_count, items) => ({ incomplete_results: false, total_count, items });
  const io = runtime([response(200, page(101, first)), response(200, page(101, [{ id: 100 }]))]);
  assert.equal(ghJson("search/code?per_page=100&q=PwrAgent", false, null, io).items.length, 101);
  assert.match(io.calls[1][1].at(-1), /page=2$/);
  for (const pages of [
    [page(101, first), page(102, [{ id: 100 }])],
    [page(101, first), page(101, [{ id: 0 }])],
    [page(101, first), page(101, [])],
    [page(1001, first)],
    [{ incomplete_results: true, total_count: 0, items: [] }],
  ]) assert.throws(() => ghJson("search/code?per_page=100&q=PwrAgent", false, null, runtime(pages.map((p) => response(200, p)))), /Incomplete GitHub search/);
});

test("bounds throttling retries, honors server delays, isolates reads and hides raw subprocess errors", async () => {
  const { ghJson } = await lib;
  const io = runtime([response(429, {}, "Retry-After: 90\r\n"), response(200, {})]);
  ghJson("repos/public/source", false, null, io);
  assert.deepEqual(io.waits, [90_000]);
  assert.equal(io.calls[0][2].env.GH_TOKEN, "read-fixture");
  assert.equal(io.calls[0][2].env.GH_DEBUG, "");
  assert.equal(io.env.GH_TOKEN, "write-fixture");
  const reset = runtime([response(403, {}, "X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 120\r\n"), response(200, {})]);
  ghJson("repos/public/source", false, null, reset);
  assert.deepEqual(reset.waits, [120_000]);
  const long = runtime([response(429, {}, "Retry-After: 300\r\n")]);
  assert.throws(() => ghJson("repos/public/source", true, null, long), /bounded/);
  assert.deepEqual(long.waits, []);
  assert.throws(() => ghJson("repos/public/source", true, null, runtime([response(401, {})])), (e) => /HTTP 401/.test(e.message) && !e.message.includes("private raw error"));
  assert.equal(ghJson("repos/public/source", true, null, runtime([response(404, {})])), null);
  const fallback = runtime([response(200, {})]);
  delete fallback.env.DISTRIBUTION_READ_TOKEN;
  ghJson("repos/public/source", false, null, fallback);
  assert.equal(fallback.calls[0][2].env.GH_TOKEN, "write-fixture");
});

test("paginates release history, selects numeric promoted stable independently of GitHub Latest", async () => {
  const { auditChannels, publishedReleases, previousRelease } = await lib;
  const hundred = Array.from({ length: 100 }, () => ({ ...release, tag_name: "v9.0.0-beta.1", prerelease: true }));
  const higher = { ...release, tag_name: "v1.10.0" };
  const api = fixture({}, false, (endpoint) => endpoint.includes("releases?per_page=100&page=1") ? hundred
    : endpoint.includes("releases?per_page=100&page=2") ? [release, higher, { ...release, tag_name: "v99.0.0", draft: true }] : undefined);
  assert.equal(publishedReleases(api).length, 103);
  const audit = auditChannels(api);
  assert.equal(audit.stable.version, "1.1.4");
  assert.equal(audit.highestPromotedStable.version, "1.10.0");
  assert.equal(previousRelease("1.11.0", (endpoint) => endpoint.endsWith("/releases/tags/v1.10.0") ? higher : api(endpoint)).tag_name, "v1.10.0");
  assert.throws(() => publishedReleases(() => hundred), /pagination limit/);
});

test("CLI preserves a blocked JSON report and refuses submission before any write", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "distribution-audit-"));
  try {
    const stub = `#!${process.execPath}
const endpoint = process.argv[process.argv.indexOf("--include") + 1];
if (process.argv.includes("POST")) throw new Error("Unexpected write");
let body = null;
if (/^repos\\/[^/]+\\/[^/?]+$/.test(endpoint)) body = { private: false, default_branch: "main" };
else if (endpoint.endsWith("releases/latest")) body = ${JSON.stringify(release)};
else if (endpoint.includes("/releases?")) body = [${JSON.stringify(release)}];
else if (endpoint.startsWith("search/")) {
  const items = endpoint.startsWith("search/code") && decodeURIComponent(endpoint).includes("Homebrew/homebrew-cask")
    ? [{ path: "Casks/p/pwragent.rb", html_url: "https://github.com/Homebrew/homebrew-cask/blob/main/Casks/p/pwragent.rb" }] : [];
  body = { incomplete_results: false, total_count: items.length, items };
}
console.log("HTTP/2.0 " + (body === null ? "404" : "200") + "\\r\\n\\r\\n" + JSON.stringify(body));
process.exitCode = body === null ? 1 : 0;
`;
    await writeFile(join(dir, "gh"), stub, { mode: 0o755 });
    await writeFile(join(dir, "audit.json"), JSON.stringify({ stable: { version } }));
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, DISTRIBUTION_VALIDATION_RUN: "https://github.com/example/actions/runs/1" };
    const audit = spawnSync(process.execPath, [resolve(__dirname, "package-manager-release.mjs"), "--audit"], { encoding: "utf8", env });
    assert.equal(audit.status, 1);
    assert.equal(JSON.parse(audit.stdout).status, "blocked");
    const plan = spawnSync(process.execPath, [resolve(__dirname, "package-manager-release-plan.mjs"), "plan", dir], { encoding: "utf8", env });
    assert.equal(plan.status, 1);
    assert.equal(JSON.parse(plan.stdout).status, "blocked");
    const { readFile } = await import("node:fs/promises");
    assert.equal(JSON.parse(await readFile(join(dir, "preflight.json"), "utf8")).status, "blocked");
    const submission = spawnSync(process.execPath, [resolve(__dirname, "submit-package-manager-release.mjs"), dir], { encoding: "utf8", env });
    assert.equal(submission.status, 1);
    assert.match(submission.stderr, /Channel audit blocked: .*reconcile ownership.*do not submit/);
    assert.doesNotMatch(submission.stderr, /Unexpected write/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
