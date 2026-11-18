# Profiling the Renderer with React DevTools

Moved verbatim from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps
a summary and says when to read this document.

## Profiling the Renderer with React DevTools

Nothing in the app connects React DevTools on its own. Two opt-in env vars,
both read by [`electron.vite.config.ts`](../electron.vite.config.ts) at Vite
config time, turn it on:

| Variable | What it does |
|---|---|
| `PWRAGENT_DEV_REACT_DEVTOOLS=1` | Injects `<script src="http://localhost:8097">` as the first `<head>` script so the renderer loads the standalone DevTools backend. |
| `PWRAGENT_DEV_REACT_DEVTOOLS_HOST` / `_PORT` | Point that script somewhere other than `localhost:8097`. |
| `PWRAGENT_DEV_REACT_PROFILING=1` | Aliases `react-dom/client` → `react-dom/profiling` for `electron-vite build` only. |

With both unset the plugin is never constructed and the alias key is never
added, so a normal build is byte-identical to one from a tree without this
feature. That was verified by building from both configs and diffing
`out/renderer` — no output difference.

### Attaching to the dev build

This is the configuration to reach for first, and it needs no build changes.

```bash
npx react-devtools
```

Then, from the repository root, start the app for this checkout with the
bridge enabled:

```bash
PWRAGENT_DEV_REACT_DEVTOOLS=1 .agents/skills/pwragent-dev-profile/scripts/pwragent-dev-profile.zsh restart --root "$PWD"
```

The skill's daemon passes the current environment through to `pnpm dev`, so
exporting the variable before the call is enough. `npx react-devtools` must
already be listening when the renderer loads; the script tag is a synchronous
classic script, and a refused connection simply means React never registers a
renderer with the hook.

Do not add `react-devtools` to `package.json`. It depends on `electron@^23`,
which would pull a second Electron runtime into `node_modules` alongside the
one the app actually uses.

### Knowing which instance you attached

Several PwrAgent checkouts usually run at once on this machine and the
standalone DevTools window says nothing about which page is on the other end
of its socket. Two things resolve it:

- The bridge is opt-in per process. An instance started without
  `PWRAGENT_DEV_REACT_DEVTOOLS=1` has no script tag and *cannot* connect, so
  starting exactly one bridged instance is itself the isolation.
- The injected bridge logs its endpoint and the checkout it was built from to
  the renderer console:
  `[pwragent] React DevTools bridge -> http://localhost:8097 (renderer from /…/apps/desktop)`.
  Open that window's own Electron DevTools and read the line to confirm.

To profile two checkouts at once, give each its own port and run one
`react-devtools` per port:

```bash
npx react-devtools --port 8098
PWRAGENT_DEV_REACT_DEVTOOLS=1 PWRAGENT_DEV_REACT_DEVTOOLS_PORT=8098 …
```

Every window in the process loads the same renderer bundle, so auxiliary
windows (Star Map, Settings, Activity) carry the bridge too. The standalone
server accepts one connection at a time and logs a warning when it replaces
an earlier one.

### Which build to use for what

**Use the dev build to find re-render storms and update loops.** It is the
better tool for that, not a fallback:

- The Profiler's "Record why each component rendered" attribution is richer
  in a development build — it reports the specific changed props by name and
  the changed hook indices (`Hook 7 changed`). The production profiling build
  drops some of that detail.
- No build step, no packaging, and HMR still works.
- A pathology shows up as a *ratio* — components re-rendered per commit,
  or commits per interaction — and ratios survive the dev build's overhead
  intact.

**Use the profiling build only when an absolute millisecond number has to be
trustworthy.** Development React is much slower than production React and the
overhead is uneven across component shapes, so dev-build durations rank badly
against each other and must never be quoted as the cost users pay. A plain
production build is not an option here: it reports "Profiling not supported"
because production `react-dom` is compiled without the timing
instrumentation.

The profiling build is **not** a prerequisite for spotting a storm. Reach for
it after the dev build has told you where to look.

```bash
PWRAGENT_DEV_REACT_PROFILING=1 PWRAGENT_DEV_REACT_DEVTOOLS=1 pnpm --filter @pwragent/desktop build
pnpm --filter @pwragent/desktop preview
```

Measured cost of the alias on the renderer bundle, `react-dom` 19.2.8:

| | baseline | profiling | delta |
|---|---|---|---|
| `vendor-react-*.js` raw | 382,982 B | 402,937 B | +19,955 B (+5.2%) |
| `vendor-react-*.js` gzip | 118,127 B | 123,956 B | +5,829 B (+4.9%) |
| whole `out/renderer` | 5,463,569 B | 5,483,765 B | +20,196 B (+0.4%) |

Only `react-dom/client` is aliased. Bare `react-dom` (`createPortal`,
`flushSync`) and `react-dom/server` keep resolving normally, and that is what
keeps one reconciler in the bundle: in React 19 both `react-dom/client` and
`react-dom/profiling` require the shared bare `react-dom` module for their
internals, so swapping the client entry alone cannot produce two copies.
Confirm a build really is the profiling one by grepping the chunk for a
Profiler-only fiber field — `treeBaseDuration` appears 21 times in the
profiling bundle and 0 times in the baseline.

### The DevTools browser extension does not work here

`electron-devtools-installer` plus the React DevTools MV3 extension is a dead
end on Electron 41, and the half that works makes it look like it might.
Measured on Electron 41.10.7 with React Developer Tools 8.0.0:

- The extension installs and Electron accepts `manifest_version: 3`.
- Its background **service worker runs**.
- Content-script injection works — `__REACT_DEVTOOLS_GLOBAL_HOOK__` is
  installed in the page with the full hook API. The old `chrome.scripting`
  blocker from 2023 is genuinely gone.
- **The extension's `devtools_page` never loads.** No webContents is created
  for it, and no Components or Profiler tab appears in Electron's DevTools,
  with the window shown or hidden.

So the backend half attaches and the frontend half does not, which yields a
hook and no UI. Use the standalone route.

### Packaging cannot ship the bridge

`PWRAGENT_DEV_REACT_DEVTOOLS` is read at build time, so nothing at app
runtime can undo a renderer HTML that was built with it.
[`verify-asar-contents.mjs`](../scripts/verify-asar-contents.mjs) fails packaging
when any packaged HTML loads a remote script; `release.mjs` runs it on every
packaging path. The rule is written against the shape — a remote `<script
src>` in a shipped renderer — not against the flag.

All four variables are also listed in `rejectDevOnlyEnvVarsInProduction`
([`src/main/index.ts`](../src/main/index.ts)). The `delete` there is inert for
them, since this process never reads them; the point is the `console.error`
line, so an operator who exports one and then launches a packaged build is
told it did nothing instead of wondering why the Profiler never connects.
