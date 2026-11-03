# GitHub Actions Labels

Some PR labels intentionally alter workflow behavior. Keep label names
namespaced with `ci:` when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `ci:benchmark-checks` | `check-performance.yml` | Compares base and PR syntax lint, typed lint and typecheck on one GitHub-hosted `macos-26` runner. Records three paired samples, runner/hardware identity and system load. Adding this label starts the benchmark. |
| `ci:build-preview` | `preview-build.yml` | Builds an ad-hoc signed, unnotarized macOS preview DMG and uploads it as a workflow artifact. Use for PRs that change release packaging, installer assets, or desktop distribution behavior. |
| `ci:windows-package` | `ci.yml` | Builds the unsigned Windows NSIS installer (`release.mjs --win`) and uploads it as a workflow artifact. Off by default — the normal Windows CI job is build + test only. Adding the label alone does not start CI; add it before opening the PR, rerun CI, or push a commit after adding it. The release workflow (`release.yml`) builds the Windows installer automatically on version tags. |
| `ci:windows-shutdown-diagnostics` | `ci.yml` | Runs three full Windows Desktop E2E samples across the usual four lanes, with signed Handle/CDB tools, native process and pipe observation, and bounded native stack captures. Default CI runs one sample across four lanes with ordinary shutdown reports. No PDBs are downloaded. Adding the label alone does not start CI; add it before opening the PR, rerun CI, or push a commit after adding it. See [shutdown diagnostics](../../docs/playwright-worker-shutdown-diagnostics.md#opt-in-hosted-windows-pipe-evidence). |
| `ci:windows-shutdown-diagnostics` | `windows-native-quit-repro.yml` | Separately runs 25 fresh stock-Electron profiles per mode, with and without session preparation. Records native identity, pipe and stack evidence under the existing capture limits. It stops on the first abnormal case. This workflow also supports manual dispatch. Adding the label alone does not start it; open, reopen, or push the labeled PR. |
| `ci:linux-packages` | `linux-packaging.yml` | Builds and smoke-tests x64 and arm64 Linux packages for same-repository PRs. Off by default on PRs. Adding this label starts packaging; pushes and reopens rerun it while the label remains. Adding another label does not rerun it. There is no changed-path filter. Pushes to `main` do not start this workflow. Manual dispatch remains available, and the release workflow (`release.yml`) still packages Linux automatically on version tags. |

If you add another label-influenced workflow path, document it here in the same
change as the workflow update.
