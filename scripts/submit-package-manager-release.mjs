#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditChannels, compareVersions, ghJson, PACKAGE_ID, TAP_REPO, WINGET_PATH, WINGET_REPO } from "./package-manager-release.mjs";

function mutate(endpoint, payload) {
  const result = spawnSync("gh", ["api", "--method", "POST", endpoint, "--input", "-"], {
    input: JSON.stringify(payload), encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`GitHub write ${endpoint}: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

export async function submitChannel({ channel, target, fork, files, version, runUrl }, api = ghJson, write = mutate) {
  if (channel.version && compareVersions(channel.version, version) > 0) throw new Error(`Refusing ${target} downgrade`);
  if (channel.version === version) return { state: "published-in-repository", repository: target, version };
  if (channel.pending.length) return { state: "pending-review", submissions: channel.pending, nextAction: "Review existing submission; do not create a duplicate" };
  const upstream = api(`repos/${target}`);
  const destination = fork === target ? upstream : api(`repos/${fork}`);
  if (fork !== target && destination.parent?.full_name !== target) throw new Error(`${fork} must be a fork of ${target}`);
  const base = api(`repos/${target}/git/ref/heads/${upstream.default_branch}`).object.sha;
  const branch = `pwragent-${version}`;
  const existing = api(`repos/${fork}/git/ref/heads/${branch}`, true);
  if (existing) {
    // Resume only identical inputs; never overwrite a reviewed branch.
    for (const [path, contents] of Object.entries(files)) {
      const remote = api(`repos/${fork}/contents/${path}?ref=${branch}`);
      if (Buffer.from(remote.content, "base64").toString() !== contents) throw new Error(`Existing ${branch} differs at ${path}; review manually`);
    }
  } else {
    const commit = api(`repos/${target}/git/commits/${base}`);
    const tree = write(`repos/${fork}/git/trees`, {
      base_tree: commit.tree.sha,
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
    });
    const head = write(`repos/${fork}/git/commits`, {
      message: `chore(release): update PwrAgent distribution to ${version}`, tree: tree.sha, parents: [base],
    });
    write(`repos/${fork}/git/refs`, { ref: `refs/heads/${branch}`, sha: head.sha });
  }
  const evidence = runUrl ? `\nValidation run: ${runUrl}\n` : "\nSee the submission's checks for platform validation.\n";
  const body = target === WINGET_REPO
    ? `## 📖 Description

Thanks for maintaining WinGet. PwrDrvr publishes PwrAgent, a desktop app for running coding agents, and is adding it to the community source.

${PACKAGE_ID} ${version} uses the released x64 NSIS installer with explicit user and machine switches. The downloaded bytes match the publisher's SHA-256 manifest and GitHub asset digest. ARM64 Windows is not published.
${evidence}
## ✅ Checklist

- [ ] Signed the [Contributor License Agreement](https://cla.opensource.microsoft.com) (the bot determines account status)
- [ ] Linked to an issue (not applicable)

## 📦 Manifest Checklist

- [x] Checked for duplicate open pull requests
- [x] This PR modifies one package manifest set
- [x] Validated with winget validate in the linked workflow
- [x] Tested fresh installation and upgrade in the linked workflow
- [x] Manifest conforms to the 1.12 schema
`
    : `## Summary

Thanks for maintaining the PwrDrvr tap. PwrAgent is adding Homebrew installation alongside its signed GitHub releases.

Pin PwrAgent ${version} to the released arm64 and universal DMGs. Apple Silicon selects arm64; Intel selects universal. Preserve ~/.pwragent during uninstall.

## Verification

Downloaded bytes match published SHA-256 checksums and GitHub digests. The linked workflow checks cask style, audit, both app architectures, signature/notarization, fresh install and upgrade.
${evidence}
## Notes

Publication requires merging this PR and verifying the tap after brew update. The cask tracks promoted stable releases only.
`;
  const pr = write(`repos/${target}/pulls`, {
    title: target === WINGET_REPO
      ? (channel.version ? `Update: ${PACKAGE_ID} to ${version}` : `New package: ${PACKAGE_ID} version ${version}`)
      : `chore(release): update pwragent cask to ${version}`,
    head: fork === target ? branch : `${destination.owner.login}:${branch}`,
    base: upstream.default_branch,
    body,
  });
  return { state: "pending-review", url: pr.html_url, nextAction: "Monitor validation and merge, then verify client publication" };
}

async function main() {
  const dir = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("Usage: node scripts/submit-package-manager-release.mjs <generated-dir>");
  const generated = JSON.parse(await readFile(resolve(dir, "audit.json"), "utf8"));
  const audit = auditChannels();
  if (audit.status !== "complete") throw new Error(`Channel audit blocked: ${audit.blockers.join("; ")}; do not submit`);
  const version = audit.stable.version;
  if (version !== generated.stable.version) throw new Error("GitHub Latest changed; regenerate and revalidate inputs before submission");
  if (!process.env.DISTRIBUTION_VALIDATION_RUN) throw new Error("Set DISTRIBUTION_VALIDATION_RUN to the successful platform validation run URL");
  const cask = await readFile(resolve(dir, "Casks/pwragent.rb"), "utf8");
  const winget = {};
  for (const suffix of ["yaml", "installer.yaml", "locale.en-US.yaml"]) {
    const path = `${WINGET_PATH}/${version}/${PACKAGE_ID}.${suffix}`;
    winget[path] = await readFile(resolve(dir, path), "utf8");
  }
  // No automatic fork creation: ownership and credentials are operator setup.
  const fork = process.env.WINGET_FORK_REPO;
  if (!fork) throw new Error("Set WINGET_FORK_REPO to an existing publisher-owned fork of microsoft/winget-pkgs");
  const common = { version, runUrl: process.env.DISTRIBUTION_VALIDATION_RUN };
  const results = {};
  results.homebrew = await submitChannel({ ...common, channel: audit.homebrew, target: TAP_REPO, fork: TAP_REPO, files: { "Casks/pwragent.rb": cask } });
  console.log(JSON.stringify({ homebrew: results.homebrew }));
  results.winget = await submitChannel({ ...common, channel: audit.winget, target: WINGET_REPO, fork, files: winget });
  console.log(JSON.stringify({ winget: results.winget }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
