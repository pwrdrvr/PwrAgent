# Isolated Linux task driver

This runs the real unpackaged PwrAgent Electron build under Xvfb and drives the
shipping preload IPC, like `lib/live-app.ts`. Managed Codex, normal instruction
injection, tools, security transforms and Token Miser remain in the real path.
No fake provider or standalone compression implementation is used by the driver.

Build from a **git archive** of a pinned commit, never a working-directory Docker
context containing credentials, node_modules, `.local`, or other task artifacts:

```sh
mkdir build-context
git archive HEAD | tar -x -C build-context
docker build --platform linux/arm64 -f build-context/apps/desktop/eval/container/Dockerfile -t pwragent-eval:PIN build-context
```

The image uses Ubuntu 24.04, Node 24, the locked pnpm dependencies, uid 1000,
Electron's sandbox, Xvfb, and tini. Build requires more memory than a small task;
allow Docker its configured 8 GiB while compiling. Task execution starts with
`--cpus 2 --memory 6g --shm-size 512m`, concurrency 1. Use native arm64 on Apple
Silicon when the task supports it; `--platform linux/amd64` is emulated there.
The image contains the readonly-capable payload at `/opt/pwragent`. For an
existing benchmark task image, install the same OS libraries and copy that
payload and `/usr/local` Node runtime from this image, preserving permissions.
Do not mount verifier files until the agent container has stopped.

Download and verify the official `pwrdrvr/codex` managed release archive and its
published SHA256SUMS outside the image build. Extract the complete bundle and
retain LICENSE/NOTICE. Pin all three executable hashes:

```sh
node apps/desktop/eval/container/write-runtime-manifest.mjs ./managed /opt/managed 0.162.1-pwragent.1 ./runtime.json
```

Input schema (unknown fields fail closed):

```json
{
  "schemaVersion": 1,
  "runId": "task01-sol-on-attempt1",
  "cwd": "/app",
  "prompt": "Solve the task using the repository and its visible tests.",
  "model": "gpt-6.1-sol",
  "reasoningEffort": "high",
  "serviceTier": "default",
  "tokenMiser": true,
  "timeoutMs": 600000,
  "runtimeManifest": "/eval/runtime.json",
  "profileDir": "/eval/profile",
  "codexHome": "/eval/codex",
  "maxObservedCostUsd": 10,
  "maxObservedTokens": 1000000
}
```

Models are exactly `gpt-6.1-sol` or `gpt-6-astra`. `/testbed` or another absolute
cwd is supported. Each arm uses a fresh task, profile and Codex home. Within a
model pair only `tokenMiser` changes (and identifying paths/runId). Optional
`preflightOnly: true` checks startup/auth/model catalog/gates, creates an empty
thread to verify effective settings, and probes interrupt IPC with an impossible
turn ID. It starts **no turn** and makes no model inference request.
Use separate fresh directories for preflight and a subsequent paid run.

```sh
# Create writable empty profile, output, codex directories owned by uid 1000.
# Bind ONLY the auth file: never an entire consumer ~/.codex directory.
docker run --rm --init --cpus 2 --memory 6g --shm-size 512m \
  --mount type=bind,src="$TASK",dst=/app \
  --mount type=bind,src="$OUTPUT",dst=/eval/output \
  --mount type=bind,src="$PROFILE",dst=/eval/profile \
  --mount type=bind,src="$CODEX_STATE",dst=/eval/codex \
  --mount type=bind,src="$AUTH_FILE",dst=/eval/codex/auth.json,readonly \
  --mount type=bind,src="$MANAGED",dst=/opt/managed,readonly \
  --mount type=bind,src="$RUNTIME_JSON",dst=/eval/runtime.json,readonly \
  --mount type=bind,src="$INPUT_JSON",dst=/eval/input.json,readonly \
  pwragent-eval:PIN --input /eval/input.json --output /eval/output
```

The underlying portable command is:
`node apps/desktop/eval/run-headless.mjs --input /eval/input.json --output /eval/output`.
It must run non-root inside Linux with DISPLAY (normally `xvfb-run -a`). If the
read-only auth file is mode 0600, use `--user HOST_UID:HOST_GID` and make the
empty writable mounts owned by that same identity; do not copy credentials or
broaden the auth file permissions. Never
use `--no-sandbox`. A host/container security policy that prevents Electron's
sandbox is a failed prerequisite, not permission to disable it. Default Docker
outbound network is permitted consistently in every arm; no host Docker socket,
SSH agent, API keys in images, consumer settings or federation credentials.

The driver uses an allowlisted environment and a fresh HOME beneath the profile.
Messaging and automations are explicitly disabled, federation is disabled in
config, other providers disabled, notifications disabled, and unpackaged app
updates disabled by the normal app behavior. Provider MCP connections are off;
ordinary PwrAgent/Codex tools and Token Miser transforms remain. Auth is never
copied and cannot be refreshed onto the readonly mount; expired auth fails.

`ready.json` records catalog, managed version/command, and activation evidence.
`run.json` is fsynced before the only `startTurn`. Repeated identical input/output
returns the recorded outcome without launching or spending; mismatched input
fails. An incomplete attempt exits 6 and MUST be reconciled by the spend owner;
there is deliberately no automatic paid retry. A new attempt needs a fresh
runId, output, profile and Codex state. Lost dispatch acknowledgements and
transport failures before a known outcome retain `incomplete`, including when
a timeout or cancellation was requested locally.

`result.json` includes status, IDs, actual pricing ledger (cache/reasoning/helper
rows), tool accounting and Token Miser totals. `thread.json` preserves the final
IPC projection. `familyUsage` records tokens, cost and unpriced status for each
distinct delegated thread; `observed` sums the family. Native helper usage is
already attributed to its owning thread and is not added a second time.
`rollout.jsonl` is PwrAgent's normalized event stream;
`protocol.jsonl` is sanitized **PwrAgent-owned** App Server protocol capture,
not a read of Codex's private rollout storage. Credentials/account fields are
redacted; raw duplicate wire strings are omitted. Profile-local captures are
private diagnostics and must not be uploaded. `patch.diff` includes tracked
changes against initial HEAD; `untracked.tar.gz` preserves new task files. The
mounted task itself remains the authoritative grading artifact.

Exit codes: 0 completed (or preflight passed), 1 failed, 2 preflight/config/auth
failure, 3 timeout, 4 signal/provider cancellation, 5 observed budget threshold,
6 current or prior attempt incomplete. A terminal event must match both thread and turn; idle
state alone never means success. Approval/user-input requests fail unattended
runs instead of receiving invented answers. A provider `turn/completed` with
status `interrupted` is cancellation, not successful completion. Timeout/cancellation interrupts the
turn, closes the app and its managed children, then exports artifacts. The
controller should retain an outer timeout and stop the task container after
reading the result; tini reaps orphan children.

Observed cost/token thresholds are **not hard billing limits**: usage lands
after a model request. The execution owner reserves in-flight headroom (including
Token Miser helpers, cached-input uncertainty, and retries) under the current
**$500 cumulative evaluation cap**, and pauses after the authorized cohort for user review. The driver
makes no independent budget authorization. Do not assume an output/context cap
unless the actual provider protocol proves it is honored.
