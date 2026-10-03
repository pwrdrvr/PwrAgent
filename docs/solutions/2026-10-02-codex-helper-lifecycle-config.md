# Codex helper lifecycle configuration

PwrAgent already forwards per-thread Codex configuration through the existing
`config` object on start, resume, and fork. Its primary ephemeral-helper config
already suppressed lifecycle hooks and legacy notifications. The legacy helper
fallback omitted both suppressions. `buildCodexHelperConfig` now composes
`features.hooks = false` and `notify = []` for both attempts, preserving the rest
of each feature table and its existing execution/MCP overrides.

## Architecture and scope

Reviewed root, desktop, and Codex adapter `AGENTS.md` guidance and
`ARCHITECTURE.md` before implementation. The profile's managed App Server
connection serves both helpers and interactive coding threads.

| Path | Existing behavior and decision |
| --- | --- |
| `CodexAppServerClient.generateTitle` | Fresh ephemeral thread through `runHelperStructuredTurn`; suppress hooks/notify on both attempts. |
| `generateStructuredObject` | Same composer for prompt drafting, diff condensation, usage analysis, and Token Miser; preserve feature/MCP overrides and optional execution disabling. |
| `runHelperToolTurn` | Star Map intake shares the composer; preserve advertised PwrAgent dynamic tools and handler lifecycle. |
| Ordinary `startThread`, `forkThread`, and `startTurn`/resume | Preserve caller config and inherited hooks/notify on the shared process. |
| Star Map manager, user-facing Agent threads, automation coding threads | Ordinary registry thread creation and operator-selected execution modes; retain normal capabilities. Automation prompt drafting uses a separate ephemeral helper. |
| `buildCodexClientArgs` and settings config overrides | Existing process `-c` defaults and invalidation remain unchanged; helper policy belongs in each request. |

Primary helpers already included empty inline hook event arrays as well as the
feature flag. Those arrays remain in place. The legacy configuration keeps its
existing smaller feature table. MCP servers remain individually disabled from
protocol inventory. Data-only helpers retain their execution/delegation flags;
tool helpers retain their supplied dynamic tools.

## Protocol and source evidence

The [official App Server documentation](https://learn.chatgpt.com/docs/app-server)
describes per-thread configuration overrides and optional named `permissions`
selection. The [official config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents `features.hooks` and the independent legacy `notify` command.

Generated the installed `codex-cli 0.160.0` experimental JSON schema in an ignored
workspace directory. `ThreadStartParams`, `ThreadResumeParams`, and
`ThreadForkParams` each expose an object-valued `config`; `ClientRequest` has no
separate overlay endpoint. PwrAgent's existing payload builders forward it.

Inspected these upstream Apache-2.0 files at `rust-v0.160.0`, downloaded only
under this checkout's ignored `.local/codex-config-review/source/`:

- `app-server/src/config_manager.rs::load_with_cli_overrides` chains request
  config after process CLI overrides.
- `core/src/config/mod.rs::layer_stack_preserving_session` preserves session
  layers when rebuilding retained configuration.
- `hooks/src/registry.rs::from_config` constructs legacy `after_agent`
  notification callbacks independently of the lifecycle engine's
  `feature_enabled` flag. Empty notification argv creates no legacy callback.

Thus hook suppression alone leaves notification commands enabled. Both settings
belong on each helper attempt. No user Codex files or private session storage
were read or changed; tests use mocked protocol responses without inference or
API credentials. PwrSnap [PR #700](https://github.com/pwrdrvr/PwrSnap/pull/700)
provided the investigation context, adapted here to PwrAgent's shared composer.

## Permission-profile retained configuration

PwrAgent's helper config defines no `[permissions]` profile. Its thread payload
builders emit legacy `sandbox`, not typed `permissions`; helper starts introduce
neither a named definition nor a named selection. Upstream `core/src/config/mod.rs`
requires `default_permissions` when config defines permission profiles unless a
typed profile override provides initial selection. Retained rebuilds can lose
that typed selection, explaining PwrSnap's separate fix in
[PR #698](https://github.com/pwrdrvr/PwrSnap/pull/698).

PwrAgent has no equivalent owned named-profile lifecycle to repair. Adding a
synthetic profile/default would change existing sandbox behavior. Profile
selection, sandbox/approval defaults, workspace roots, environment selection,
and fallback ordering remain unchanged. Operator profiles remain Codex-owned.

## Regression evidence

Added 18 protocol tests covering four helper kinds, primary and fallback
attempts, and ordinary start/fork/resume requests on the same client afterward:

1. Before fixes: 8 failures (four hooks, four notifications), 10 passing controls.
2. With hooks fixed: 4 notification failures remained, 14 tests passed.
3. With both fixed: all 308 Codex client tests passed, including all 18 new tests.

Controls verify default ordinary threads receive no helper config, explicit
ordinary hooks/notifications survive start/fork/resume, and caller config stays
unchanged. Helpers retain existing feature/MCP restrictions and tool advertisement.
The related backend-registry, title-generation, Star Map intake, and Token Miser
suites passed all 985 tests. ESLint and workspace typechecking passed. No SQLite
writes or other persistence were added.
