# Artifact contract and resolver inputs

Implementation provenance: [PwrAgent PR #2497](https://github.com/pwrdrvr/PwrAgent/pull/2497), merged as `883c363994342069714553ec69566b94b64c07fe`. Consult current `apps/desktop/scripts/desktop-debug-artifacts.mjs`, `apps/desktop/electron.vite.config.ts`, `.github/workflows/release.yml` and the release runbook's “Release-matched JavaScript debug artifacts” when the contract changes. Inspection checkout also includes Windows-native tar/target correction `3184f3beb469f1c3599b084a5021f5836bc440ec`.

Public repository: `pwrdrvr/PwrAgent`. Asset pair:
`PwrAgent-<version>-<platform>-<arch>-debug.tar.gz` and the exact basename plus `.sha256`.
Public release assets have no configured expiration; intermediate CI archives retain 30 days (preview: 14). Installed apps intentionally exclude maps. Retention does not backfill old releases. macOS tar's paired AppleDouble metadata (magic-checked `._*` sidecars) is ignored without extraction and listed in provenance. Other unlisted build payloads are rejected. Explicit local subset mode may retain auxiliary files **outside** `out/` (such as the supplied backfill's `rebuild.mjs`); they are listed separately, covered by the archive checksum, never executed, and not represented as manifest-verified files.

Schema 1 manifest: `version`, `releaseTag`, full `commit`, `trackedChanges`, `builtAt`, `platform`, `arch`, `buildHost`, `tools`, `lockfileSha256`, `ci` (repository/ref/runId/runAttempt/workflow), and `files`. Each file has app.asar-relative `path` under `out/`, `bytes`, `sha256`; each JS entry also has adjacent `sourceMap` or null. Full release mode requires the selected version/tag/target, clean tracked state, and maps for main/preload/renderer. It checks every listed file and rejects unlisted payloads. A checksum detects corruption; it is not an independent signature proving provenance. GitHub's asset digest is checked when provided. Manifest commit is reported and compared with `--commit` when supplied; it is not guessed from a local tag.

## Commands

`--version`, `--platform`, `--arch` are mandatory even for local overrides. `--version` also accepts `v1.2.3`; no latest/version auto-inference. `--stack FILE` reads UTF-8; omit to paste via stdin. Limit: 1 MiB. `--json` emits preserved raw lines and structured results. Exit codes: 0 = at least one mapped frame (inspect each confidence/status), 3 = no frames mapped, 2 = acquisition/validation/input failure. Partial mapping is not a claim that every frame resolved.

Installed evidence alternatives:

- `--installed-root DIR`: original extracted app.asar root containing `out/`.
- Repeated `--installed-file 'out/renderer/assets/chunk.js=/tmp/original/chunk.js'`: direct bytes, hashed by helper.
- `--hashes FILE`: JSON keyed by full `out/...` JS paths. Values are a SHA-256 string or `{"sha256":"<64 hex>","bytes":123}`. State the operator's provenance for hashes; supplying size adds a size check. Conflicting hash/file evidence is an error. Do not silently omit a mismatching input.

`--commit` compares an authoritative full 40-character build commit. `--column-base 1` is the default for browser/V8/Safari/Firefox/ErrorEvent coordinates; `0` accepts already converted coordinates. Lines always begin at 1. Main/preload, worker and lazy-chunk paths use the same lookup. `app.asar/out/...`, Windows paths and percent-encoded file URLs normalize to archive paths; bare basenames require uniqueness. The helper uses source-map v3 greatest-lower-bound lookup and embedded sources. Name absence is reported; the generated stack's name is kept separately. It does not infer original enclosing functions. React component-only, eval, blob, indexed source maps and native/external frames can remain explicitly unresolved.

## Local unpublished/older builds

`--archive PATH [--checksum PATH]` bypasses network and defaults to `PATH.sha256`. The checksum line must name the exact archive basename. Ordinary local overrides still use the full release schema; `--local-subset` is explicitly reserved for scoped backfills with manifest `scope`, version, platform, commit and per-file hashes/sizes. Its architecture may be unspecified and is reported as such; the requested target is not promoted to proven package identity. It may derive a missing `sourceMap` field only from the adjacent listed map. It **requires original installed evidence for every mapped frame**. A local archive is reported as local, never as a published release asset.

Example for an operator-verified three-renderer-chunk backfill:

```bash
python3 /path/to/scripts/resolve_stack.py --version 1.1.5 \
  --platform darwin --arch universal \
  --commit 4704c7cd431e0c8f4c9f1163821969db54f44c18 \
  --archive /tmp/PwrAgent-1.1.5-verified-renderer-debug.tar.gz \
  --local-subset --hashes /tmp/original-installed-hashes.json \
  --stack /tmp/crash.txt --json
```

Only accept rebuild-derived maps after original JS hash/size matches; lockfile/commit/version equality alone is insufficient. Do not automate a rebuild as a fallback. Missing maps require an exact-build archive, or explicit separately authorized forensic work.

## Acquisition, safety and cache

The helper makes one GitHub release metadata request per invocation and selects exactly one named asset pair. Missing/duplicate assets stop acquisition before downloading. Each asset downloads at most once, with a 45-second socket timeout, a 120-second deadline checked between reads, size cap and no retry loop. `GH_TOKEN`/`GITHUB_TOKEN` can authenticate the metadata request; tokens are never sent to download/CDN redirects. Network-restricted environments can use their normal approved access or a local archive.

Default cache: `~/.cache/pwragent-crash-stacks/<version>/<target>/<asset-identity>/`. Override with `--cache` for an isolated diagnostic workspace. The key includes release ID and asset IDs, digests, sizes and update times. A validated commit receipt records manifest commit, target and checksum. Cached archive checksum, every file digest and identity are rechecked on each use. Invalid cached data stops; delete only that reported entry and reacquire explicitly. No writes to app files or Codex-owned storage.

Compressed archive cap: 256 MiB; expanded total: 1 GiB; individual file: 128 MiB; member count: 20,000. The archive is read in memory without filesystem extraction. Absolute/traversing/drive-letter paths, duplicate files, links and special members are rejected. Embedded source paths are labels, never filesystem read targets. Large legitimate artifacts can exceed these conservative bounds; adjust deliberately with evidence rather than disabling validation.
