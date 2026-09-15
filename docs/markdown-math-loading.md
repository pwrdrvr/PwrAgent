# Demand-driven Markdown math

`ThreadMarkdown` inspects its repaired source with the dependency-free
`hasPotentialMarkdownMath` hint. With the experimental setting enabled, only a
message with a hint requests `markdown-math-runtime`. The provider carries the
boolean setting; runtime completion updates requesting messages locally.
Ordinary siblings neither receive that update nor acquire math plugins or the
LaTeX normalizer. Detection is memoized by source and setting.

`ThreadMarkdown` is the sole runtime hook consumer. Transcript messages, plans,
reviews, activity and input content inherit the existing main thread-view
provider. Standalone Markdown/changelog viewers without that provider retain
their default disabled behavior; clipboard HTML continues to omit math.

The shared import promise coalesces concurrent requests. Effect cleanup ignores
completion after disabling, replacing the source with ordinary text, or
unmounting. A failed import logs once and remains settled for the renderer's
lifetime; reopening the window permits a new attempt. No persistence or timers
are involved. Once fetched, assets remain cached even if the setting is disabled;
disabling immediately removes math processing from rendered messages.

## Syntax and conservative detection

The runtime still owns parsing and security (`trust: false`, `maxExpand: 1000`,
`maxSize: 20`). Supported syntax includes multi-dollar text/flow math, normalized
LaTeX `\(...\)` and `\[...\]`, and backtick/tilde `math` fences. Single-dollar
text math remains disabled.

The hint accepts `$$`, `\(`, `\[`, and fence candidate lines containing `math`
or encoded/escaped info. CommonMark decodes fence info: `m&#97;th` also becomes
`math`. Detection runs after the existing nested-fence repairs. Every streaming
source update is reconsidered, including a delimiter split between updates.

This is deliberately not a second Markdown parser. Protected code, escaped or
unmatched delimiters, and `mathematica` fences can fetch the runtime without
rendering math. Ordinary Markdown, ordinary code fences without those hints,
currency such as `$5 and $10`, and `$x$` do not request it. Harmless source false
positives preserve the existing context-sensitive code/escaping behavior.

## Validation and measurements

With math enabled and ordinary Markdown, **309,513 B of math JavaScript and
CSS are no longer loaded**. This avoids loading math code and installing its
stylesheet until a message has a math hint. Installed application size is
unchanged; startup time and memory savings were not measured.

Measured against main commit `a70af514b91d892c42d1143ddd38e71b068c1d4d`, which
includes Mermaid and the shared image gestures. Both sides use the same resolved
Electron production renderer configuration and installed dependencies. Byte
counts are emitted, uncompressed asset sizes, not wire-transfer measurements.

| Loaded during ordinary use, math enabled | Before | After | Avoided |
| --- | ---: | ---: | ---: |
| Math runtime + shared KaTeX JavaScript | 279,443 B | 0 B | 279,443 B |
| Math stylesheet | 30,070 B | 0 B | 30,070 B |
| Total math assets | 309,513 B | 0 B | 309,513 B |
| Math asset requests | 3 | 0 | 3 |

The new loading code adds 167 B of eager JavaScript, making the net reduction
309,346 B during ordinary use. Math font requests are zero on both sides for
ordinary text; fonts load when an expression actually needs them. KaTeX is now a
shared chunk because Mermaid also uses it. Opening Mermaid can load that shared
code independently; the math-specific runtime and CSS still wait for math.

<details>
<summary>Emitted bundle sizes (files remain installed; their load timing changes)</summary>

| Production renderer output | Before | After |
| --- | ---: | ---: |
| Entry JS plus transitive static JS imports | 1,222,063 B | 1,222,230 B |
| Main CSS | 527,605 B | 527,605 B |
| Separate math runtime JS | 18,130 B | 18,130 B |
| Shared KaTeX JS | 261,313 B | 261,313 B |
| Separate math CSS | 30,070 B | 30,070 B |

Math runtime and KaTeX gzip sizes total 84,549 B, unchanged. These assets already
existed as separate chunks; previously the math setting requested them even
without a math message.

</details>

A headless Chromium fixture uses the real provider and `ThreadMarkdown`, built
with the resolved Electron renderer production configuration. It has only
contrived text and needs no Electron backend or profile. The probe also builds
the full production renderer and checks Rollup's transitive static import graph:
math runtime, normalizer, math parser extensions, KaTeX and math CSS must be
outside that graph. Ordinary Markdown still uses its existing shared Markdown
parser dependencies.

| Browser scenario | Observed |
| --- | --- |
| Before: enabled ordinary Markdown | Math runtime + shared KaTeX JS + CSS requested; zero expressions |
| After: enabled ordinary Markdown and code | Zero math JS/CSS/font requests |
| After: disabled supported math | Zero math asset requests |
| After: streaming `$` becomes `$$x$$` | Two JS requests (runtime + KaTeX), one CSS request, two font requests; rendered math |
| After: inline LaTeX, display LaTeX, tilde math fence | Three expressions, two display blocks, no errors |
| After: disable loaded math | Zero rendered expressions |
| Fresh document: code span containing `$$` | Runtime fetched, zero rendered expressions (source false positive) |

Regression tests also cover encoded fence labels, nested containers, code
escaping, character-by-character streaming, source replacement, concurrent
messages under Strict Mode, unrelated message render counts, unmounts, disabled
cached runtime, and failed-import retries. Existing math fixtures remain intact.

### Reproduce

From the repository root (requires installed Playwright Chromium):

```sh
pnpm --filter @pwragent/desktop exec tsx scripts/verify-markdown-math-loading.ts
pnpm --filter @pwragent/desktop exec tsx scripts/verify-markdown-math-loading.ts --baseline-ref=a70af514b91d892c42d1143ddd38e71b068c1d4d
```

The baseline probe substitutes only that commit's provider and consumer source
in memory; it never changes the checkout. Reports and fixture builds go under
`.local/math-loading/current/` and `.local/math-loading/baseline/`. The full
renderer graph records module membership, static/dynamic imports, CSS imports,
and emitted/gzip JS sizes. The browser report records math requests and errors.
These instrumented builds can differ slightly from `pnpm build` in entry/asset
paths; the tables above consistently use the instrumented production renderer outputs
on both sides. `pnpm build` is also validated separately.
