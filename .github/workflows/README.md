# GitHub Actions Labels

Some PR labels intentionally alter workflow behavior. Keep label names
namespaced with `ci:` when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `ci:build-preview` | `preview-build.yml` | Builds an unsigned macOS preview DMG and uploads it as a workflow artifact. Use for PRs that change release packaging, installer assets, or desktop distribution behavior. |
| `ci:windows-package` | `ci.yml` | Builds the unsigned Windows NSIS installer (`release.mjs --win`) and uploads it as a workflow artifact. Off by default — the normal Windows CI job is build + test only. Adding the label alone does not start CI; add it before opening the PR, rerun CI, or push a commit after adding it. The release workflow (`release.yml`) builds the Windows installer automatically on version tags. |
| `ci:windows-signing` | `ci.yml` | Installs `TrustedSigning` on Windows and proves a fresh non-interactive PowerShell 7 process resolves `Invoke-TrustedSigning`. For same-repository PRs, it also requests the `windows-signing` environment and runs the installer build with `--require-signing`; fork PRs can run only the credential-free preflight. The environment currently permits only `v*` tags, so its protected PR job is rejected unless that policy is deliberately changed outside the workflow. Add this label before opening the PR, or push another commit after adding it. |

If you add another label-influenced workflow path, document it here in the same
change as the workflow update.
