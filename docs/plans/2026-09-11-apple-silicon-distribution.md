# Apple Silicon macOS distribution exploration

Exploration only, 2026-09-11. No release, feed, website, README, or packaging
behavior was changed. Repository inspected at
`592efcd90557dd6ad02149e117a38ab90e9a214a` (desktop `1.1.0-alpha.5`).

## Recommendation

Ship an arm64 DMG and updater ZIP alongside the existing universal pair.
Keep universal for Intel, uncertain browser detection, portable installations,
and older updater compatibility. Do not add an Intel-only product initially.
Use one merged `latest-mac.yml` containing architecture-specific ZIP entries;
the installed updater already performs architecture selection. Preserve the
universal legacy `path` and `sha512` fields and all existing universal names.

Make the arm64 build genuinely architecture-specific: Electron, Grok, native
modules, canvas, ripgrep, and the Dock plug-in. The expected installed saving
is approximately **436.5 MB (42.74%)**, not 50%. Grok's separate signed arm64
distribution is a prerequisite for the recommended complete implementation.

## Measured evidence

Read `/Applications/PwrAgent.app` without modifying it. Its Info.plist reports
`1.1.0-alpha.4`. Counts below are decimal MB, logical regular-file lengths,
excluding symlinks to avoid counting framework contents twice. These are not
APFS allocated blocks or Finder's potentially rounded size display.

For each fat Mach-O, read its fat architecture table and substitute the arm64
slice length. Omit the `canvas-darwin-x64` unpacked package. Retain all other
files, including shared ASAR resources and existing signatures. This estimates
an arm64 payload; it does not produce a runnable, signed app.

| Component | Installed universal MB | Projected arm64 MB | Saving MB |
|---|---:|---:|---:|
| Frameworks | 493.343 | 274.945 | 218.399 |
| Bundled Grok including notices | 347.083 | 168.301 | 178.782 |
| app.asar | 95.562 | 95.562 | 0 |
| app.asar.unpacked | 74.263 | 39.541 | 34.722 |
| Other resources | 10.728 | 6.255 | 4.473 |
| Executable, plug-in, metadata | 0.305 | 0.174 | 0.131 |
| **Total** | **1,021.285** | **584.778** | **436.507** |

Specific measurements:

- Grok executable: 346,308,896 bytes; arm64 slice 167,526,688 bytes;
  x86_64 slice 178,764,096 bytes. The arm64 slice is 48.4% of the fat file.
- Canvas: arm64 binding 26,968,624 bytes; x64 binding 32,558,848 bytes.
  These are separate platform packages, not two slices of one canvas file.
- Electron Framework main binary: 377,834,256 bytes → 178,129,680 bytes.
  Framework resources and other libraries prevent assuming that the entire
  Frameworks directory halves.
- Keeping universal Grok alone would raise the projection to **763.560 MB**,
  reducing the total saving to about **25.24%**.

Compression probe: stream each regular file through independent raw DEFLATE
level 6, then repeat using only each arm64 slice and excluding Intel canvas.
The sums were **393,003,210 → 214,139,310 bytes**, a **45.51%** reduction.
Grok alone was 131,262,907 → 63,050,708 compressed bytes. ZIP headers, symlinks,
archive metadata, signing changes, and builder compression choices are outside
this probe. It is a comparison of compressed payloads, not a generated ZIP.

The published alpha.4 assets, read through GitHub's release API, are:

| Asset | Bytes |
|---|---:|
| PwrAgent-1.1.0-alpha.4-universal-mac.zip | 379,597,882 |
| ZIP blockmap | 398,775 |
| PwrAgent-1.1.0-alpha.4-universal.dmg | 393,047,867 |

Applying the measured compression ratio to that published ZIP gives roughly
**207 MB**, saving about **173 MB**. Treat **~207–214 MB** as a planning
estimate, not a confidence interval or acceptance result. DMG compression
must be measured separately; do not apply a ZIP ratio as a measured DMG size.
The first unsigned paired build must record actual ZIP, DMG, app logical size,
and allocated size, and the signed candidate must repeat the archive checks.

The SQLite source exclusion from PR #2069 is already present in the inspected
builder config. The installed alpha.4 measurement still includes those files.
This projection leaves them in both columns, assigning **no savings** to that
separate change. Compare arm64 and universal from the same commit during
implementation so that saving is not counted twice.

Local raw evidence is in `.local/arm64-exploration/files.json` and
`files-compressed.json`; a compact durable summary accompanies this plan.
No Codex-owned storage was inspected.

## Current packaging and publication contracts

- `apps/desktop/electron-builder.yml`: mac DMG/ZIP targets are universal;
  identity is `com.pwrdrvr.pwragent`; app name is PwrAgent. Keep those stable.
  Preserve Developer ID identity, entitlements, hardened runtime, fuses,
  minimum OS, Icon Composer package, and Xcode 26/actool requirements.
- `apps/desktop/scripts/release.mjs`: a fixed `release-stage` is populated by
  `pnpm deploy --cpu=x64 --cpu=arm64 --os=darwin`; both canvas bindings are
  required. Builder arguments force `--mac --universal`. Post-build paths and
  lipo assertions assume `dist/mac-universal/PwrAgent.app` and both slices for
  the app, SQLite, Dock plug-in, Grok, and ripgrep.
- `build-dock-tile-plugin.mjs` always compiles both architectures.
  `afterpack-sign-dock-tile-plugin.mjs` signs nested code before app sealing.
- `stage-ripgrep-bundle.mjs` already supports `macos-arm64`, but its cache
  deliberately accepts a universal bundle for a single-architecture request.
  That cache policy must not silently defeat the smaller package.
- `.github/workflows/release.yml`: no-secret prepare installs/tests/stages;
  protected `apple-signing` job verifies the digest of its input archive,
  receives no checkout and performs no dependency install; final assembly
  waits for signed macOS, signed Windows, and both Linux packages. Keep this
  separation. Mac jobs run on `macos-26` and use the selected actool 26.
- The signing job copies `PwrAgent-*-universal.dmg` to `PwrAgent.dmg` and
  explicitly uploads `latest-mac.yml`. Assembly verifies updater metadata,
  publishes every tag initially as a prerelease, and checks uploaded assets.
  Promotion remains a separate operator step after all artifacts pass.
- `update-channel-files.mjs`, `check-desktop-release-metadata.mjs`, release
  workflow tests, preview workflow, release skill, and release runbook encode
  these assumptions and need matching changes, not weakened checks.
- The phase-2 runbook was read as required by the release skill. Its migration
  options are historical; current source already uses the public PwrAgent repo.
  Do not introduce the removed environment variables shown in that record.

## Artifact and updater contract

| Purpose | Name |
|---|---|
| Universal DMG, unchanged | `PwrAgent-${version}-universal.dmg` |
| Universal stable alias, unchanged | `PwrAgent.dmg` |
| Universal updater ZIP, unchanged | `PwrAgent-${version}-universal-mac.zip` |
| Apple Silicon DMG, new | `PwrAgent-${version}-arm64.dmg` |
| Apple Silicon stable alias, new | `PwrAgent-arm64.dmg` |
| Apple Silicon updater ZIP, new | `PwrAgent-${version}-arm64-mac.zip` |
| Blockmaps | Each versioned ZIP's name plus `.blockmap` |
| macOS updater manifest, unchanged | `latest-mac.yml` |

`latest-mac.yml` should have universal ZIP first in `files`, arm64 ZIP second,
each with its own SHA-512, size, and generated blockmap-related properties.
Top-level `path` and `sha512` must continue to describe the universal ZIP.
Use versioned ZIP URLs only. Aliases are for human downloads.

Evidence from pinned dependencies:

- `electron-updater` **6.8.9**, `out/providers/Provider.js`, uses `-mac` on
  Darwin regardless of architecture. Creating `latest-mac-arm64.yml` alone
  does nothing for existing clients. A custom channel named `latest-arm64`
  would instead resolve `latest-arm64-mac.yml`, and would require client
  changes. Separate manifests are unnecessary for this rollout.
- `out/MacUpdater.js` detects arm64 via `process.arch`, Rosetta's
  `sysctl.proc_translated`, and an additional uname check. When arm64 files
  exist, it selects only those; on Intel it excludes them. Classification
  looks for the literal `arm64` in file URLs, so use exactly that spelling.
- Installed alpha.4 contains updater 6.8.9 and this selection code, verified
  by reading the application's ASAR. Four assertions against the local pinned
  implementation passed: arm64 preference, Intel exclusion, universal-only
  fallback, and order independence for Intel.
- `app-builder-lib` **26.15.7**, `out/publish/updateInfoBuilder.js`, merges
  update tasks within one invocation and sorts universal ahead of per-arch
  artifacts for backward-compatible legacy fields. Separate builder runs
  do **not** share that merge state: never let their manifests overwrite each
  other or upload whichever finishes last.

| Existing installation | Next release with merged metadata |
|---|---|
| alpha.4 universal on native Apple Silicon | Select arm64 ZIP |
| alpha.4 universal running under Rosetta | Select arm64 ZIP; verify relaunch natively |
| Universal on Intel | Select universal ZIP |
| New arm64 installation | Select subsequent arm64 ZIP |
| Apple Silicon targeting an older universal-only release | Universal fallback |
| Legacy path-only updater | Universal through preserved legacy fields |
| Other historical file-list updaters | Audit shipped version before claiming compatibility |

Keep the current four channel/track slots and release selection semantics.
`auto-updater.ts` points a generic feed at one selected release's download
directory; no change to feed roots is required. Its current eligibility test
only asks for `latest-mac.yml` and any `.zip`; tighten this to recognize the
macOS universal fallback ZIP rather than allowing an unrelated ZIP to qualify.
Do not demand an arm64 ZIP when selecting historical releases.

For the initial universal → arm64 transition, budget a **full ZIP download**.
Differential updating has a full-download fallback, and the previous arm64
blockmap may not exist. Test cache and missing-blockmap behavior explicitly.
Replacing the entire signed `.app` must remove the old Intel payload. Test
bundle identity, signature acceptance, permissions, retained profile state,
launch, and subsequent updates using Squirrel's real install path. Reading
the file selector is not proof that installation/relaunch works.

## Grok cross-repository prerequisite

Inspected [pwrdrvr/grok-build release workflow](https://github.com/pwrdrvr/grok-build/blob/be713136d2a69080743a3f6b3c72077057e5948f/.github/workflows/pwragent-release.yml).
It already builds raw `macos-aarch64` and `macos-x86_64` executables, merges
them with lipo, and signs/publishes only the universal macOS distribution.
The pinned `pwragent-v1.0.0-pwragent.2` release contains only a universal macOS
tarball, **130,915,946 bytes**, plus Linux/Windows assets and SHA256SUMS.

Add a separately signed `pwragent-grok-${version}-macos-aarch64.tar.gz` from
the existing raw arm64 output. Preserve universal. Extend protected signing,
input digest verification, expected-architecture assertions, notices,
SOURCE_REV/build metadata, SHA256SUMS, assembly gates, and release checks.
Do not merely rename the universal tarball. The inspected Grok workflow signs
the executable; it does not show a standalone notarization step. Preserve
that contract and verify the final containing PwrAgent app notarizes.

In PwrAgent add `macos-aarch64` to `grok-bundle.json` at a new pinned release;
select it for arm64 preparation and verify its actual Mach-O architecture.
Keep `PWRAGENT-BUNDLE.json` provenance and all runtime signature checks.
Although local lipo extraction could avoid a new upstream asset in principle,
it changes the distributed bytes/provenance and complicates verification.
A separately signed upstream asset is the recommended supported contract.

Also handle `grok-managed-runtime.ts`: `managedGrokAssetPlatform` maps both
Mac architectures to universal, and cached metadata requires an exact asset
name. Changing that function alone would reject existing cached universals.
Plan arm64 preference with compatible universal fallback for older releases
and valid cached installs. The cache uses `versions/<tag>` without architecture;
do not overwrite an active universal executable at that path with a same-tag
arm64 asset. Either defer same-tag replacement until a new tag, or design
architecture-qualified storage with backward-compatible reads. Include concurrent
native/Rosetta processes and pinned runtimes in that decision. This concerns
disk use outside the app and is separate from the 584.8 MB app estimate.

## Implementation sequence

1. **Upstream runtime.** Land Grok arm64 signed asset support, validate it,
   then pin its new immutable release in PwrAgent. Do not alter existing tags.
2. **Explicit isolated targets.** Add a validated mac architecture parameter
   defaulting to universal. Give arm64/universal separate stage and output
   roots. Deploy only arm64 for that stage; keep both CPUs for universal.
   Ensure x64 canvas is absent from both ASAR and unpacked output in arm64,
   while preserving both for universal and all license notices. Target native
   rebuilds for SQLite/node-pty correctly. Parameterize Dock compilation,
   Grok/ripgrep staging, builder arguments, output paths, and assertions.
   Require exact slice sets, not just presence of arm64. Fix ripgrep cache
   reuse for strict arm64 staging. Keep ASAR integrity generation in builder;
   do not prune an already sealed app.
3. **Paired preparation/signing.** Prefer two prepared target trees in one
   digest-verified input archive and sequential package commands in the
   existing protected mac signing job initially. This preserves the security
   boundary and avoids duplicate full test runs. Measure signing duration
   against the existing 60-minute budget. If parallel signing is needed,
   use independent archives/digests and jobs, not shared mutable stages.
   Include any new script imports in the signing archive allowlist (and the
   Windows allowlist if release.mjs imports them unconditionally).
4. **Deterministic assembly.** Retain each target's generated manifest under
   a temporary distinct name, parse with a real YAML parser in no-secret
   assembly, and produce one merged latest-mac.yml. Validate equal versions,
   one ZIP per intended architecture, universal legacy fields, file sizes,
   SHA-512 values, and referenced artifacts. Validate blockmaps and aliases.
   Upload metadata only after all artifacts are assembled; retain existing
   release prerelease/promotion gates. Add both aliases to checksum coverage.
5. **Updater tests.** Cover the table above, malformed/partial releases,
   universal-only history, missing arm64 blockmaps, interrupted downloads,
   failed verification, cache reuse, and explicit downgrade across slots.
   Perform signed private-candidate upgrade/relaunch tests on Apple Silicon,
   Rosetta, and Intel before production rollout. Use managed lab procedures
   for headed testing. Compare same-commit installed and archive sizes.
6. **Documentation/discovery.** Update release scripts' contract tests,
   `release:check`, release runbook/skill, and relevant preview packaging
   coverage. Land website and README download links only once the new alias
   exists in the promoted stable release. An alpha asset does not make a
   `/releases/latest/download/` URL available.

## Website and README proposal

Read-only inspection identified concrete work in
[pwrdrvr/pwragent.ai](https://github.com/pwrdrvr/pwragent.ai):
`_config.yml`, `_layouts/default.html`, `index.md`, and `assets/js/site.js`.
The site currently has a universal `mac_dmg` setting, `data-mac-dmg` and a
universal asset suffix, an OS-selecting primary CTA, and one macOS size badge.
Add separate arm64/universal URLs, suffix matching, labels, and size badges.
Update the hero, Other platforms, and installation card consistently.

For browsers that expose it, request `getHighEntropyValues(["architecture",
"bitness"])`, feature-detect the API, and handle rejection/missing fields.
Only a macOS result with `architecture: "arm"` and `bitness: "64"` should
automatically select Apple Silicon. Retain mobile/iPad detection first.
Intel results can use universal; unknown results use universal with visible
Apple Silicon/Universal choices. Never infer CPU from the UA string's
`Intel Mac OS X`, WebGL renderer, or CPU core count. Do not delay or break a
click while an asynchronous hint lookup is pending, and never override an
explicit choice. Keep Windows/Linux paths and no-JS links usable. Test
missing hints, mobile, rejected hints, API failure, and asset absence.

The browser API can withhold these values and is not available everywhere;
see [MDN's API documentation](https://developer.mozilla.org/en-US/docs/Web/API/NavigatorUAData/getHighEntropyValues).
Use feature detection rather than a fixed browser-version assumption.

In this project's README, replace the universal-only primary button with a
large **Download for Mac — Apple Silicon** link to
`https://github.com/pwrdrvr/PwrAgent/releases/latest/download/PwrAgent-arm64.dmg`.
Directly beside/below it provide equally readable text links:

- **macOS Universal (Apple Silicon + Intel)** → existing `PwrAgent.dmg` URL.
- **Windows (x64)** → existing `PwrAgent-windows-x64-setup.exe` alias.
- **Debian/Ubuntu installation** → `https://docs.pwragent.ai/linux/`.

Retain a docs link and explain “Not sure which Mac? Choose Universal.” README
cannot run architecture detection. Update its “Get it” section to match these
choices and use text or accurately labeled artwork; do not reuse the current
generic macOS button image with a misleading arm64-only destination.

In [pwrdrvr/docs.pwragent.ai](https://github.com/pwrdrvr/docs.pwragent.ai),
update macOS setup/download references with both variants and update behavior.
`linux.md` already exposes `/linux/`, the correct Debian instructions link.
These are cross-repository follow-ups; no other checkout was edited.

## Open decisions and release prerequisites

- Approve automatic universal → arm64 migration after signed smoke tests, or
  initially publish the arm64 DMG while leaving updater metadata universal-only.
  Recommendation: merged metadata after tests; no mandatory bridge for alpha.4.
- Inventory updater versions in all supported stable installations. Unknown
  historical versions may warrant a universal bridge in their release train.
- Decide Grok's same-tag cache migration policy; prefer leaving valid cached
  universal runtimes until the next tag for the first implementation.
- Confirm whether preserving a universal install intentionally on Apple Silicon
  needs an opt-out. The pinned updater will otherwise select arm64 regardless
  of which DMG the user originally installed.
- Confirm dual notarization runtime/cost with a paired candidate. Do not solve
  a measured slow job by weakening signing or skipping verification.
- Intel-only artifacts are deferred: Intel remains natively supported by
  universal, with fewer artifacts and fewer routing branches to maintain.

Validation performed: source and release asset inspection, installed Mach-O
and canvas sizing, paired compression probe, installed updater inspection,
and four assertions against its pinned architecture filter. No full app build,
signature/notarization operation, or actual update installation was performed.

`git fetch origin --tags` encountered conflicting local alpha.1, alpha.3,
and alpha.4 tags and returned exit 1. No tags were overwritten. The evidence
uses the explicit worktree commit, installed Info.plist, and GitHub release
API rather than treating those local tag refs as authoritative.
