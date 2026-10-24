# GitHub Actions Labels

Some PR labels intentionally alter workflow behavior. Keep label names
namespaced with `ci:` when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `ci:benchmark-checks` | `check-performance.yml` | Compares base and PR syntax lint, typed lint and typecheck on one restricted self-hosted macOS runner. Records three paired samples, runner/hardware identity and system load. Same-repository PRs only; adding this label starts the benchmark. |
| `ci:build-preview` | `preview-build.yml` | Builds an ad-hoc signed, unnotarized macOS preview DMG and uploads it as a workflow artifact. Use for PRs that change release packaging, installer assets, or desktop distribution behavior. |
| `ci:windows-package` | `ci.yml` | Builds the unsigned Windows NSIS installer (`release.mjs --win`) and uploads it as a workflow artifact. Off by default — the normal Windows CI job is build + test only. Adding the label alone does not start CI; add it before opening the PR, rerun CI, or push a commit after adding it. The release workflow (`release.yml`) builds the Windows installer automatically on version tags. |
| `ci:linux-packages` | `linux-packaging.yml` | Builds and smoke-tests x64 and arm64 Linux packages for same-repository PRs. Off by default on PRs. Adding this label starts packaging; pushes and reopens rerun it while the label remains. Adding another label does not rerun it. There is no changed-path filter. Every push to `main` runs packaging and smoke tests automatically. Manual dispatch remains available, and the release workflow (`release.yml`) still packages Linux automatically on version tags. |

If you add another label-influenced workflow path, document it here in the same
change as the workflow update.
