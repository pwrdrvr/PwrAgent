# Desktop Vitest Guards

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## No Real Agent CLIs in Vitest

The `desktop-main` project loads
[`src/main/__tests__/setup/agent-cli-spawn-guard.ts`](../src/main/__tests__/setup/agent-cli-spawn-guard.ts)
as a setup file. It fails any test that spawns a `codex` / `gemini` / `grok` /
`kimi` / `qwen` executable from outside the OS temp dir.

It exists because **sandboxing `PATH` does not sandbox discovery**. The ACP kit
also scans well-known `$HOME` bin dirs (`~/.local/bin`, `~/.bun/bin`, every
installed nvm node bin) and each strategy's absolute fallback candidates
(`~/.kimi-code/bin/kimi`, `~/.grok/bin/grok`); Codex discovery probes its own
install locations, including the `codex` inside ChatGPT.app. Before #1740 the
suite ran ~169 real agent processes per run and asserted against whatever
versions the developer had installed.

**CI cannot catch this on its own.** CI machines have none of those binaries, so
the probe fails, discovery finds nothing, and the assertions still pass — the
tests take a different code path locally than on CI. The guard makes both the
same failure.

The hook is `ChildProcess.prototype.spawn`, not the `child_process` exports:
it is the one chokepoint every async spawn path funnels through, and a
prototype patch survives however a module imported `child_process` — including
externally bundled dependencies vitest never transforms, which `vi.mock` cannot
reach. It records **and** throws; the recording is what fails the test, because
discovery probes run inside `try/catch` and swallow a bare throw. Sync spawns
(`spawnSync` / `execFileSync`) are not covered — all agent discovery is async.

Fix a failure by injecting the seam, never by widening the guard's allowed
roots:

| Surface | Seam |
|---|---|
| ACP discovery | `listExecutables` + `fallbackRootDir` (+ `bundledGrokCommand: null`) to confine candidates to the fixture, or inject `discover` / `readVersionOutput` |
| Codex discovery | inject `codexDiscoveryCoordinator`, or `vi.mock("@pwrdrvr/codex-discovery")` via [`__tests__/helpers/codex-discovery-stub.ts`](../src/main/__tests__/helpers/codex-discovery-stub.ts) |
| Anything else | `vi.mock` the discovery module, as `settings-ipc` and `backend-registry` already do |

`acp-runtime-override-launch.test.ts` is the worked example of the ACP seams,
and `acp-instance-discovery.test.ts` of plain probe injection.

## No Git Against the Checkout in Vitest

[`src/main/__tests__/setup/checkout-git-spawn-guard.ts`](../src/main/__tests__/setup/checkout-git-spawn-guard.ts)
fails a `desktop-main` test that runs Git against the repository checkout the
suite runs in, whether through `-C <path>`, a `cwd` inside it, `--git-dir`,
`--work-tree`, or `GIT_DIR` / `GIT_WORK_TREE` in the child's environment.
`init` and `clone` are judged by the directory they write, and a local `clone`
by its source too.

A thread started with `cwd: process.cwd()` did this without anyone asking.
`startThread` ran `git rev-parse --abbrev-ref HEAD` whenever the head-branch
file probe could not prove the layout, and a linked worktree is enough for
that. `get_thread_status` read the working state with ten commands across the
whole tree, about a second per call on a GitHub runner and under 100 ms on a
warm local worktree. A property test made 30 such calls and timed out on CI
only (#3687). The results also depended on the checkout's branch and dirty
files.

Fix a failure without widening the guard:

- A test whose subject is not Git: start the thread in an empty
  `mkdtemp` directory (`nonRepositoryCwd` in `backend-registry.test.ts`), or
  inject `gitWorkingStateService` / `gitDirectoryService`.
- A test of Git itself: build its own repository under `os.tmpdir()`.

Like the agent-CLI guard it hooks `ChildProcess.prototype.spawn`, records and
throws, and does not see sync launches or, on Windows, `ownProcessTree`
launches, which start the PowerShell job wrapper rather than Git. `checkout-git-spawn-guard.test.ts`
checks the classifier against Git's own `rev-parse --show-toplevel`.

## No Network and No Operator State in Vitest

Two more suite-wide guards, both pure test infrastructure. Production code has
no test-awareness and behaves identically either way — the seams are in
`vitest.workspace.ts`.

**Where.** Every desktop project sets `PWRAGENT_HOME` to
`<os.tmpdir()>/pwragent-vitest-home-<pid>`. `resolvePwragentRoot` otherwise
falls back to `~/.pwragent`, and only about a dozen main tests override it
themselves, so every other test that touches a root-relative path was reading
and writing the operator's live application state. A plain `pnpm test` really
did install a ~353 MB Grok runtime into `~/.pwragent/agents/grok/`, and the
suite still writes a scratch projects directory and `state/image-inputs` —
those now land in the temp root.

Nothing pre-creates the directory, so a well-behaved run leaves no trace at
all; anything that appears there is a test writing to the PwrAgent root. The
pid keeps concurrent runs (several worktrees testing at once is normal) off
each other's state. A test that needs its own root still wins with `vi.stubEnv`
or an explicit `env` argument. `__tests__/disposable-pwragent-home.test.ts`
pins both halves — that each project still declares the redirect, and that the
value actually reaches a forked worker — so a config edit cannot quietly drop
it. The one root path it does not cover is `userHomeWorktreesRoot`, which is
deliberately `os.homedir()`-anchored; no test has ever created it, and
`git-directory-service` takes an injected `homeDir`.

`XDG_CONFIG_HOME` and `XDG_STATE_HOME` travel with it, pinned to
`<os.tmpdir()>/pwragent-vitest-xdg-<pid>/{config,state}` on each project and
guarded by the same test. Nothing in the app reads them today; the pre-profile
migration that searched them for `pwragnt/` state is gone. They stay because
`PWRAGENT_HOME` never covered them: those roots came from `os.homedir()` and
the ambient XDG variables, so a test that stubbed only the PwrAgent root still
read the operator's real `~/.config` and `~/.local/state` — and a developer
carrying pre-1.0 files then ran a different code path than CI on every
`initializeAppState`. Set all three together when a suite needs its own roots.

`PATH` is sandboxed on every project, including messaging and shared. The
directory of the Node running the suite comes first, so `node` and a fixture's
`#!/usr/bin/env node` shebang are always that Node. The repository's own
`node_modules/.bin` directories that pnpm prepends come next; they hold the
project's pinned tools, such as the `tsgolint` that typed oxlint runs. On POSIX
only `/usr/bin`, `/bin`, `/usr/sbin` and `/sbin` follow; on Windows every entry
outside the user's profile does, because Git for Windows lives in system
locations that vary by machine. It exists because the operator's shell `PATH` starts with
version-manager shims: a mise shim read `~/.config/mise/config.toml` on every
ACP fixture launch, and an unparseable one failed the suite on one Mac only.
It also keeps operator-authenticated tools such as `gh` and `op` out of reach.
Production code that appends search directories for agent launches still
does; the agent-CLI spawn guard covers what that can reach. A test that needs
another tool should resolve it by absolute path, as the deploy-isolation test
does with `npm_execpath`, or supply it, as the manual Git LFS validation test
does, rather than widen the sandbox. `disposable-pwragent-home.test.ts` pins
the sandbox for every project and in the running worker.

**Whether.** [`src/test-setup/outbound-fetch-guard.ts`](../src/test-setup/outbound-fetch-guard.ts)
replaces `globalThis.fetch` and fails any test that makes a real outbound
request. It hooks the global rather than taking an injected `fetch` per caller
for the same reason the spawn guard hooks a prototype: it is the one chokepoint
every request funnels through, so it also covers `acp-registry-service`,
`mcp-connection-gateway-service`, and `auto-updater` — none of which were given a
seam — plus any network path added later. Injection is how you *fix* a failure
(`fetchLatestCompatibleRelease` honors `options.fetch`, and
`grok-managed-runtime.test.ts` passes one); it cannot be what enforces the
rule, because a module with no seam is exactly the case that needs catching.

Like the spawn guard it records **and** throws — every one of these callers
degrades to a cached value or a logged warning inside its own `try`/`catch`, so
a bare throw would be swallowed and the test would pass green having attempted
the request anyway. Unlike the spawn guard's prototype patch, the global is
routinely replaced by tests, so the guard reinstalls itself on every setup run
rather than once per worker; a test that drives its own fake HTTP layer
replaces it for its own duration, as `auto-updater.test.ts` does. Not covered:
`http.request` / `https.request` / `net.connect`, which Node's undici `fetch`
does not route through and nothing here uses directly.

**Loopback goes through.** `localhost` (and any `*.localhost`),
`127.0.0.0/8` — including the `::ffff:127.0.0.1` form a dual-stack socket
reports — `::1`, and the wildcard bind addresses `0.0.0.0` / `::` cannot leave
the machine, so they are not what the guard is for: that is a test talking to a
server it started, the same category as the spawn guard's `os.tmpdir()`
allowance. `agent-tool-mcp-server.test.ts` drives its MCP server's real HTTP
surface (auth, CORS, thread binding) exactly this way. A scheme that opens no
socket at all — `data:`, `blob:`, `file:` — is allowed for the same reason;
those have no host to classify, and reading an inline fixture is not egress.
The allowance is pinned by the self-test, including that a remote host merely
*containing* "localhost" is still blocked.

Both renderer projects load the fetch guard too. It has no `fetch` call site
today and reaches the network through IPC, but `lint:boundaries` reads imports
and cannot see a `globalThis.fetch`, and jsdom inherits a live one from Node —
so this is the only thing here that would catch a renderer reaching a remote
host directly. A relative URL is resolved against the document origin before it
is classified, so a same-origin renderer fetch is allowed through as loopback;
the guard measures egress, not same-origin. Node has no `location`, so the same
input there stays unparseable and is treated as escaping.

`__tests__/outbound-fetch-guard.test.ts` is the guard's self-test, in the same
shape as `agent-cli-spawn-guard.test.ts`;
`renderer/src/test/outbound-fetch-guard.test.ts` covers the one case that needs
a document origin.
