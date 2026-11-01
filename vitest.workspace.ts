import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Windows CI runners are markedly slower at spawning child processes (git.exe,
// bash.exe), so git/worktree-heavy desktop tests can exceed the 5s default.
// Give Windows more headroom; POSIX keeps the standard timeout.
const TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 5_000;
const HOOK_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 10_000;

// desktop-main loads native runtime bindings (better-sqlite3,
// @napi-rs/canvas, and node-pty). A worker thread lets their native teardown
// share a process with other test files and Vitest itself; on macOS that can
// crash the entire test host after every assertion has passed. Forks preserve
// parallel test execution while giving each binding an OS-process ownership
// boundary. They are also required on Windows, where a worker thread's
// process.env is case-sensitive unlike the real Electron main process.
const DESKTOP_MAIN_POOL = "forks";

// Where the desktop suites resolve the PwrAgent root to. `resolvePwragentRoot`
// falls back to `~/.pwragent` — the operator's live application state — and
// only about a dozen main tests override it themselves, so every other test
// that reaches a root-relative path reads and writes the real thing. That is
// not hypothetical: `ensureManagedGrokRuntime` installed a ~353 MB Grok runtime
// into `~/.pwragent/agents/grok/` from a plain `pnpm test`.
//
// Nothing pre-creates this directory. A run where the suites behave leaves no
// trace at all; a run that writes leaves the evidence in the OS temp dir under
// an obvious name instead of in the operator's home. The pid keeps concurrent
// runs (several worktrees testing at once is normal here) off each other's
// state, and is stable for the whole run because the config is evaluated once
// in the vitest host process.
//
// A test that needs its own root still overrides this with `vi.stubEnv` or an
// explicit `env` argument, both of which win over the value seeded here.
const DISPOSABLE_PWRAGENT_HOME = path.join(
  os.tmpdir(),
  `pwragent-vitest-home-${process.pid}`,
);

// The XDG roots, pinned beside it. Nothing in the app reads these today —
// the pre-profile migration that searched `XDG_CONFIG_HOME` /
// `XDG_STATE_HOME` for `pwragnt/` state is deleted in this same change — so
// this is a guard, not a fix: it keeps a future reader of those variables
// from resolving into the operator's real `~/.config` and `~/.local/state`
// the way `findLegacyPaths` did, which made a developer carrying pre-1.0
// files run a different code path than CI on every `initializeAppState`.
//
// Pointed at a directory nothing creates, for the same reason as the root
// above: a run that reads them leaves evidence in the OS temp dir.
const DISPOSABLE_XDG_ROOT = path.join(
  os.tmpdir(),
  `pwragent-vitest-xdg-${process.pid}`,
);
const DISPOSABLE_XDG_CONFIG_HOME = path.join(DISPOSABLE_XDG_ROOT, "config");
const DISPOSABLE_XDG_STATE_HOME = path.join(DISPOSABLE_XDG_ROOT, "state");

// The executable search path every project runs with. The operator's shell
// PATH puts version-manager shims (mise, asdf, nvm, volta) and personal bin
// directories first, so a test that launches `node`, or a fixture with a
// `#!/usr/bin/env node` shebang, ran whatever those resolved to: a mise shim
// read `~/.config/mise/config.toml`, and an unparseable one failed the
// launch. PATH also reaches operator-authenticated tools such as `gh` and
// `op`. The Node running the suite comes first, so `node` is always this
// Node, followed by entries inside this repository: the `node_modules/.bin`
// directories pnpm prepends, which hold the project's own pinned tools
// (oxlint finds `tsgolint` there).
//
// POSIX keeps only the operating system's own directories after those; Git
// and the Xcode tools the suite uses live there. Windows keeps every entry
// outside the user's profile instead: Git for Windows and its MSYS tools are
// installed system-wide in locations that vary by machine, and the code
// finds `bash.exe` by those paths with PATH as the fallback.
//
// Windows spells the variable `Path`, and a threads worker's `process.env` is
// case-sensitive there, so the sandbox replaces whichever key the host has.
const PATH_KEY =
  Object.keys(process.env).find((key) => key.toUpperCase() === "PATH")
  ?? "PATH";
const REPOSITORY_ROOT = path.dirname(fileURLToPath(import.meta.url));
// Relative entries resolve against whatever directory a child runs in, so
// none of them is kept.
const HOST_PATH = (process.env[PATH_KEY] ?? "")
  .split(path.delimiter)
  .filter((entry) => path.isAbsolute(entry));
const SANDBOX_PATH = [...new Set([
  path.dirname(process.execPath),
  ...HOST_PATH.filter((entry) => isWithin(REPOSITORY_ROOT, entry)),
  ...(process.platform === "win32"
    ? HOST_PATH.filter((entry) => !isWithin(os.homedir(), entry))
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
])].join(path.delimiter);
const SANDBOX_ENV = { [PATH_KEY]: SANDBOX_PATH };

function isWithin(parent: string, entry: string): boolean {
  // Windows paths compare without case; POSIX paths are compared as written.
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const relative = path.relative(fold(path.resolve(parent)), fold(path.resolve(entry)));
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Where `desktop-main` workers keep the migrated databases that new test
// databases are copied from (see `state-db-template.ts`). Per run, like the
// roots above; `state-db-template-dir.ts` creates and removes it.
const STATE_DB_TEMPLATE_DIR = path.join(
  os.tmpdir(),
  `pwragent-vitest-state-db-template-${process.pid}`,
);

// Seeded on every desktop project so the root and the XDG homes always move
// together; a test that overrides one and forgets the others is the bug this
// pairing exists to prevent.
const DISPOSABLE_DESKTOP_ENV = {
  ...SANDBOX_ENV,
  PWRAGENT_HOME: DISPOSABLE_PWRAGENT_HOME,
  XDG_CONFIG_HOME: DISPOSABLE_XDG_CONFIG_HOME,
  XDG_STATE_HOME: DISPOSABLE_XDG_STATE_HOME,
};

// Renderer `.test.ts` files that need a DOM. Every other renderer `.test.ts`
// runs in `desktop-renderer-node`, because loading jsdom costs a file about
// 0.4s of worker time whether or not it touches the DOM, and most of them
// test pure projections. A `.test.ts` that needs the DOM fails there with
// `window is not defined` or `document is not defined`: list it here.
const RENDERER_DOM_TS_TESTS = [
  "apps/desktop/src/renderer/src/features/native-voice/__tests__/voice-camera.test.ts",
  "apps/desktop/src/renderer/src/features/navigation/__tests__/drag-drop.test.ts",
  "apps/desktop/src/renderer/src/features/navigation/__tests__/reveal-selected-thread-row.test.ts",
  "apps/desktop/src/renderer/src/features/navigation/__tests__/thread-row-drag-preview.test.ts",
  "apps/desktop/src/renderer/src/features/navigation/__tests__/useThreadJump.test.ts",
  "apps/desktop/src/renderer/src/features/star-map/__tests__/star-map-keyboard.test.ts",
  "apps/desktop/src/renderer/src/features/star-map/__tests__/star-map-orbit.test.ts",
  "apps/desktop/src/renderer/src/features/star-map/__tests__/star-map-preferences.test.ts",
  "apps/desktop/src/renderer/src/features/thread-detail/__tests__/composer-slot.test.ts",
  "apps/desktop/src/renderer/src/features/thread-detail/__tests__/html-preview-document.test.ts",
  "apps/desktop/src/renderer/src/features/thread-detail/__tests__/interactive-svg-document.test.ts",
  "apps/desktop/src/renderer/src/features/thread-detail/__tests__/token-miser-savings-layout.test.ts",
  "apps/desktop/src/renderer/src/lib/__tests__/appearance.test.ts",
  "apps/desktop/src/renderer/src/lib/__tests__/bundled-font-preload.test.ts",
  "apps/desktop/src/renderer/src/lib/__tests__/copy-image.test.ts",
  "apps/desktop/src/renderer/src/lib/__tests__/copy-text.test.ts",
  "apps/desktop/src/renderer/src/lib/__tests__/diagram-image.test.ts",
  "apps/desktop/src/renderer/src/lib/__tests__/keyboard-accel.test.ts",
  "apps/desktop/src/renderer/src/lib/__tests__/load-image-blob.test.ts",
  "apps/desktop/src/renderer/src/lib/__tests__/mermaid-runtime.test.ts",
  "apps/desktop/src/renderer/src/lib/__tests__/nerd-font-fallback.test.ts",
  "apps/desktop/src/renderer/src/lib/__tests__/tildify-path.test.ts",
  "apps/desktop/src/renderer/src/lib/__tests__/useScheduledThreadActionProjection.test.ts",
  "apps/desktop/src/renderer/src/lib/__tests__/window-frame.test.ts",
  "apps/desktop/src/renderer/src/styles/__tests__/css-property-cascade.test.ts",
  "apps/desktop/src/renderer/src/test/outbound-fetch-guard.test.ts",
];

// Renderer `.test.tsx` files that need no DOM, the converse of the list above.
// theme-contract only reads app.css as text. It keeps its `.tsx` name because
// repository guidance cites that path.
const RENDERER_NODE_TSX_TESTS = [
  "apps/desktop/src/renderer/src/styles/__tests__/theme-contract.test.tsx",
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "messaging",
          env: SANDBOX_ENV,
          // Vitest 4 defaults to forks, which execs a fresh Node process for
          // every test file. With hundreds of files and many concurrent
          // worktrees, that executable churn overwhelms macOS provenance
          // checks. Threads retain Vitest's default per-file isolation without
          // creating an OS process per file.
          pool: "threads",
          globals: true,
          testTimeout: TEST_TIMEOUT_MS,
          environment: "node",
          include: ["packages/messaging/**/src/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "shared",
          env: SANDBOX_ENV,
          pool: "threads",
          globals: true,
          testTimeout: TEST_TIMEOUT_MS,
          environment: "node",
          include: ["packages/shared/src/**/__tests__/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "desktop-main",
          pool: DESKTOP_MAIN_POOL,
          globals: true,
          testTimeout: TEST_TIMEOUT_MS,
          hookTimeout: HOOK_TIMEOUT_MS,
          environment: "node",
          env: {
            ...DISPOSABLE_DESKTOP_ENV,
            PWRAGENT_TEST_STATE_DB_TEMPLATE_DIR: STATE_DB_TEMPLATE_DIR,
          },
          include: [
            "scripts/**/*.test.mjs",
            ".agents/skills/codex-rollout-forensics/tests/**/*.test.mjs",
            "apps/desktop/scripts/**/*.test.mjs",
            "apps/desktop/src/main/__tests__/**/*.test.ts",
            "apps/desktop/src/main/agent-tools/__tests__/**/*.test.ts",
            "apps/desktop/src/preload/__tests__/**/*.test.ts",
            "apps/desktop/src/shared/__tests__/**/*.test.ts"
          ],
          // Machine-level cold starts, paid once per run so neither is billed
          // to whichever test file happens to reach it first.
          globalSetup: [
            // Windows only in effect: warms the Job-object wrapper that owns
            // `git worktree remove` so its one-time PowerShell + helper-compile
            // cold start is not billed to whichever test reaches it first.
            "apps/desktop/src/test-setup/windows-job-wrapper-prewarm.ts",
            // PDF.js's 1 MB first read: 3,943ms in the first process on a
            // Windows runner against 111ms in every process after it.
            "apps/desktop/src/test-setup/pdf-runtime-prewarm.ts",
            // The native typed-lint binaries' first execution: 1.5 to 12s
            // on the macOS lane, which reinstalls node_modules every job.
            "scripts/native-typed-lint-prewarm.mjs",
            // Owns the directory of migrated databases used below.
            "apps/desktop/src/test-setup/state-db-template-dir.ts",
          ],
          setupFiles: [
            // Inert unless PWRAGENT_DEV_SQLITE_WRITE_METRICS is set; see
            // `pnpm test:sqlite-writes`.
            "apps/desktop/src/main/state/sqlite-write-metrics-setup.ts",
            // Fails a test that probes an agent CLI installed on the machine
            // running the suite instead of its own fixtures.
            "apps/desktop/src/main/__tests__/setup/agent-cli-spawn-guard.ts",
            // Fails a test that makes a real outbound HTTP request — the step
            // that runs *before* the probe the guard above catches.
            "apps/desktop/src/test-setup/outbound-fetch-guard.ts",
            // Serves each new on-disk StateDb from a migrated copy.
            "apps/desktop/src/test-setup/state-db-template.ts",
          ],
          // Inline @pwrdrvr/codex-discovery so vitest transforms it. Without
          // this, the kit's bundled `import { spawn } from "child_process"`
          // is loaded raw by Node and bypasses the tests'
          // `vi.mock("child_process")` (Codex login + status now run through
          // the package, not in-tree code).
          server: { deps: { inline: ["@pwrdrvr/codex-discovery"] } }
        }
      },
      {
        test: {
          name: "desktop-renderer",
          runner: "apps/desktop/src/renderer/src/test/act-warning-runner.ts",
          pool: "threads",
          globals: true,
          testTimeout: TEST_TIMEOUT_MS,
          environment: "jsdom",
          env: DISPOSABLE_DESKTOP_ENV,
          include: [
            "apps/desktop/src/renderer/src/**/*.test.tsx",
            ...RENDERER_DOM_TS_TESTS,
          ],
          exclude: [...configDefaults.exclude, ...RENDERER_NODE_TSX_TESTS],
          // The renderer reaches the network through IPC, so it has no `fetch`
          // call site today — but `lint:boundaries` reads imports and cannot
          // see a `globalThis.fetch`, and jsdom inherits a live one from Node,
          // so the guard covers a violation nothing else here would catch.
          setupFiles: [
            "apps/desktop/src/test-setup/outbound-fetch-guard.ts",
            "apps/desktop/src/renderer/src/test/setup.ts",
          ]
        }
      },
      {
        test: {
          name: "desktop-renderer-node",
          // No act-warning runner: its guard is installed by the jsdom
          // project's setup.ts, and nothing here renders React.
          pool: "threads",
          globals: true,
          testTimeout: TEST_TIMEOUT_MS,
          environment: "node",
          env: DISPOSABLE_DESKTOP_ENV,
          include: [
            "apps/desktop/src/renderer/src/**/*.test.ts",
            ...RENDERER_NODE_TSX_TESTS,
          ],
          exclude: [...configDefaults.exclude, ...RENDERER_DOM_TS_TESTS],
          setupFiles: ["apps/desktop/src/test-setup/outbound-fetch-guard.ts"],
        }
      }
    ]
  }
});
