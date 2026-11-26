# Third-Party License Notices

PwrAgent's desktop app ships a generated `THIRD_PARTY_LICENSES` file with npm
production dependency notices and the Electron runtime MIT license.

The notice is generated with:

```bash
pnpm licenses:generate
```

CI checks it with:

```bash
pnpm licenses:check
```

## Electron and Chromium

PwrAgent is built on Electron, which includes Chromium and Node.js runtime
components. The generated PwrAgent notice includes Electron's MIT license and
the npm packages bundled by the app.

Electron also publishes Chromium's generated credits as
`LICENSES.chromium.html` inside Electron runtime distributions. For the pinned
desktop runtime used by PwrAgent, that file is about 18 MB, so PwrAgent does
not append it to the readable `THIRD_PARTY_LICENSES` text file.

Reference links:

- Chromium source and credits entry point: https://source.chromium.org/chromium
- Electron releases: https://github.com/electron/electron/releases
- Electron license: https://github.com/electron/electron/blob/main/LICENSE

## Dependency License Policy and Gate

Read this before changing dependencies that ship, license tooling or allowlists, embedded Git, fonts, or AppImage packaging/distribution. Preserve the scoped approvals and all disclosure/source obligations below.

- Three scripts cover licensing. They check different things.

| Script | Checks |
|---|---|
| [`check-package-licenses.mjs`](../scripts/check-package-licenses.mjs) | Our own workspace `package.json` files declare MIT. Never looks at a dependency. |
| [`check-third-party-license-allowlist.mjs`](../scripts/check-third-party-license-allowlist.mjs) | Every declared license the notice covers is on an allowlist. |
| [`generate-third-party-licenses.mjs`](../scripts/generate-third-party-licenses.mjs) | Transcribes the tree into `THIRD_PARTY_LICENSES`. Judges nothing. |

- That last row is the reason the allowlist gate exists.
- The generator groups records by whatever license string pnpm reports.
- Before the gate, a dependency that flipped MIT to GPL-3.0 wrote a new `GPL-3.0` section into the notice.
- `generate-third-party-licenses.mjs --check` then passed, because the committed file matched the generated file.
- CI went green and shipped copyleft.
- The only safety was that a reviewer might notice a new license heading in the diff.
- `pnpm licenses:check` runs the allowlist gate before the notice check.
- A bad license then reports as a licensing problem, not as a stale notice.
- Run the gate alone with `pnpm licenses:allowlist`.
- The gate evaluates each declared license as an SPDX expression, not as a string match.
- `OR` is satisfied by either side. `(MIT OR WTFPL)` passes on its MIT half, so WTFPL needs no allowlist entry.
- `AND` requires both sides. `Apache-2.0 AND GPL-3.0` fails.
- `AND` binds tighter than `OR`.
- Identifier comparison folds case, because SPDX short identifiers are case-insensitive.
- An unparseable string fails. Examples are `UNLICENSED`, `SEE LICENSE IN LICENSE.md`, and a `WITH` exception.
- Refusing to guess is the safe direction for a legal gate.

### Gate coverage

- The gate covers the records the notice is built from.
- It reads the npm production tree for the `@pwragent/desktop...` pnpm selector.
- The `...` suffix is load-bearing. Keep it.
- A bare `@pwragent/desktop` selects that one project.
- `pnpm licenses list` then reports only the dependencies that `apps/desktop/package.json` declares.
- Every dependency reached through a workspace package is invisible to that selector.
- `@pwragent/desktop` depends on eight workspace packages.
- The whole npm tree under the six messaging providers ships in the packaged application.
- Before the suffix, 69 shipped packages were absent from the notice and ungated.
- `NOTICE_PNPM_FILTER` in [`generate-third-party-licenses.mjs`](../scripts/generate-third-party-licenses.mjs) holds this selector.
- The generator and the gate import that one constant, so the two cannot drift.
- A test asserts the exact selector string, because dropping the suffix leaves every check passing.
- It reads `NOTICE_DEV_DEPENDENCIES` from the `all` report.
- That set holds Electron, a devDependency that ships and that `--prod` never reports.
- The generator and the gate import that one set, so the two cannot drift.
- Add a name to `NOTICE_DEV_DEPENDENCIES` when a devDependency starts shipping.
- The synthesized platform variants copy `declaredLicense` from their parent record.
- Gating the production tree therefore gates them.
- The gate reports a failure when a surface produced no records at all.
- An empty report is otherwise indistinguishable from a clean tree.
- The gate does **not** cover these sources:
  - Optional dependencies that the running machine did not install. The generator does not pass `--no-optional`, and the CI `Lint` job runs on `ubuntu-latest` only.
  - A platform variant's own package metadata. The notice prints the parent's license for every variant, so neither script ever reads one.
  - devDependencies outside `NOTICE_DEV_DEPENDENCIES`. They do not ship and the notice does not disclose them.
  - Chromium and Node.js components inside Electron. The notice points at Electron's upstream generated credits.
  - Codex App Server Rust crates. PwrAgent invokes a locally installed Codex App Server and vendors no crate.

### Changing the allowlist

- PwrDrvr LLC owns PwrAgent. Preserve MIT licensing, `LICENSE`, every
  package's `license: "MIT"`, and third-party disclosures. Changing
  first-party licensing or removing a disclosure requires an explicit PwrDrvr
  LLC policy change.
- Adding an id to `ALLOWED_LICENSE_IDS` is a legal decision.
- Make that decision in a commit that says why.
- Never add an id to make CI green.
- PwrDrvr LLC explicitly approved one exception on 2026-09-20: ship Dugite's
  bundled Git as a separate executable with Git LFS, to remove the system-Git
  dependency. Git's GPL-2.0-only license and source/build locations are retained
  in `apps/desktop/resources/embedded-git/` and `THIRD_PARTY_LICENSES`. This does
  not add GPL to the npm dependency allowlist or change first-party MIT licensing.
- Apart from that bundled Git exception, strong copyleft and source-available terms are permitted nowhere.
- Those terms include GPL, AGPL, BSL, SSPL, and Commons Clause.
- PwrDrvr LLC approved a scoped AppImage exception on 2026-10-01, to permit
  the modern runtime without a system `libfuse.so.2` dependency.
  - Permit only the unmodified AppImage `type2-runtime` release `20251108`
    (commit `dd6cebedcbddde9c82f89b011e8e1d40b6e43868`), as distributed by
    electron-builder's `toolsets.appimage: "1.0.3"`, as the AppImage ELF stub.
  - This exception covers its statically linked libfuse 3.15.0 library under
    LGPL-2.1-only. It does not cover LGPL libraries in the Electron payload,
    native addons, or npm dependencies, or bundled `fusermount`/`fusermount3`
    executables. A different runtime or library version needs a new decision.
  - Keep first-party code and package declarations MIT. Do not add LGPL to
    `ALLOWED_LICENSE_IDS`.
  - Before shipping an AppImage, retain the runtime's MIT notice, full LGPL-2.1
    text, libfuse's license split, and all linked-library notices in the
    distribution and `THIRD_PARTY_LICENSES`. Include mimalloc's MIT notice and
    use libzstd's BSD license alternative.
  - Publish the complete pinned runtime and library source, patches, checksums,
    and build/relink instructions beside the AppImage on the same GitHub
    release. Preserve original source and identify modifications with dated
    change notices, including the upstream libfuse `mount.c` patch.
  - Identify the runtime stub and the separately executed Electron payload in
    the notice. State that `fusermount`/`fusermount3` is a system executable,
    not included in the AppImage.
- LGPL remains prohibited outside that AppImage runtime exception. The
  exception records approval; it does not itself add a shipped component or
  satisfy the required disclosures and source distribution.
- `MPL-2.0` is the one copyleft id on the allowlist.
- Its copyleft binds the MPL-licensed files themselves.
- It places no condition on the larger work that includes them.
- Do not read that entry as permission for file-scoped copyleft in general.
- PwrDrvr LLC approved `OFL-1.1` on 2026-09-29, on the condition that PwrGit
  and PwrSnap already ship it. Both bundle `@fontsource/geist-sans` and
  `@fontsource/geist-mono` under it.
- `OFL-1.1` covers the Geist webfont assets that the renderer build emits.
- Its copyleft binds a derived font, which must stay under the OFL.
- It places no condition on software that embeds the font.
- The seeded list records drift that existed before any policy was enforced.
- `BlueOak-1.0.0` and `Python-2.0` were already in the shipped tree and documented nowhere.
- `0BSD`, `CC0-1.0`, `MPL-2.0`, and `Unlicense` are approved ids that the production tree does not use today.
