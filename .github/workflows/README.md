# GitHub Actions Labels

Some PR labels intentionally trigger workflow behavior. Keep label names
namespaced with `ci:` when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `ci:build-preview` | `preview-build.yml` | Builds an unsigned macOS preview DMG and uploads it as a workflow artifact. Use for PRs that change release packaging, installer assets, or desktop distribution behavior. |
| `ci:live-agent-core` | `ci.yml` | Runs the live agent-core smoke test even when the changed-file detector would otherwise skip it. |

If you add another label-triggered workflow path, document it here in the same
change as the workflow update.
