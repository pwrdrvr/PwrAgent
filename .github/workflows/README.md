# GitHub Actions Labels

Some PR labels intentionally alter workflow behavior. Keep label names
namespaced with `ci:` when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `ci:build-preview` | `preview-build.yml` | Builds an unsigned macOS preview DMG and uploads it as a workflow artifact. Use for PRs that change release packaging, installer assets, or desktop distribution behavior. |
| `ci:live-agent-core` | `ci.yml` | Runs the live agent-core smoke test even when the changed-file detector would otherwise skip it. Adding the label alone does not start CI; add it before opening the PR, rerun CI, or push a commit after adding it. |
| `ci:windows-package` | `ci.yml` | Builds the unsigned Windows NSIS installer (`release.mjs --win`) and uploads it as a workflow artifact. Off by default — the normal Windows CI job is build + test only. Adding the label alone does not start CI; add it before opening the PR, rerun CI, or push a commit after adding it. The release workflow (`release.yml`) builds the Windows installer automatically on version tags. |

If you add another label-influenced workflow path, document it here in the same
change as the workflow update.
