# Demand-driven Markdown math

`ThreadMarkdown` inspects its repaired source with the dependency-free
`hasPotentialMarkdownMath` hint. With the setting enabled, only a
message with a hint requests `markdown-math-runtime`. The provider carries the
boolean setting; runtime completion updates requesting messages locally.
Ordinary siblings neither receive that update nor acquire math plugins or the
LaTeX normalizer. Detection is memoized by source and setting.

Math rendering is on by default. Operators can turn it off under General →
Markdown rendering or set `experimental.markdown_math_rendering = false` in
their profile config. An explicit `true` or `false` keeps its existing meaning.

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
LaTeX `\(...\)` and `\[...\]`, single-dollar inline math, and backtick/tilde
`math` fences. Single-dollar pairs must stay on one source line, have no
whitespace immediately inside the delimiters, and be followed by whitespace,
closing punctuation, Markdown formatting, or the end of the source. A pair
cannot cross a backtick or end with an opening bracket (`(`, `[`, or `{`).
A trailing run of `*`, `_`, or `~` after whitespace or an opening bracket also
belongs to later Markdown formatting, so prices before `**$-x$**` stay literal.
Algebraic suffixes such as `$V^*$` retain their meaning.
This renders `$A$`, `$(x,y)$`, and `$2^{O(\lambda)}$`
while keeping prices such as `$5 and $10` and `$5-$10` literal. The runtime
guards remark-math's tokenizer without rewriting source or shifting offsets.
Paper-specific macros still need definitions; the renderer does not infer them.

The hint accepts `$$`, `\(`, `\[`, eligible single-dollar pairs, and fence
candidate lines containing `math` or encoded/escaped info. CommonMark decodes
fence info: `m&#97;th` also becomes
`math`. Detection runs after the existing nested-fence repairs. Every streaming
source update is reconsidered, including a delimiter split between updates.
The hint also accepts a pipe after single-dollar math because GFM table cells
end there before the inline parser checks the closing boundary.

This is deliberately not a second Markdown parser. Protected code, escaped or
unmatched delimiters, and `mathematica` fences can fetch the runtime without
rendering math. Ordinary Markdown, ordinary code fences without those hints,
currency such as `$5 and $10` do not request it. Harmless source false
positives preserve the existing context-sensitive code/escaping behavior.

## Malformed multi-dollar parser budget

The installed remark-math text tokenizer scans the remaining inline source for
an equal-length closing dollar run. Distinct unmatched lengths repeatedly scan
overlapping suffixes, including with `singleDollarTextMath: false`. This path
predates the single-dollar work in PR #3739.

The lazy runtime installs `remarkBoundedMath` after remark-math and before
`remarkSingleDollarMath`. The single-dollar policy wraps the bounded tokenizer,
so the index observes upstream math consumption rather than the policy's
scratch eligibility checks. The guard observes
consumption during upstream attempts and caches the last offset of each
dollar-run length when the first attempt fails at EOF. Later opening runs with
no equal-length closer immediately fail; otherwise the original tokenizer and
resolver still own the syntax. The index deliberately
counts raw runs, including escaped and code-looking content, because upstream
math treats those as raw content while searching for its closer. CommonMark
still decides where math can start. Reading ahead of upstream would install
future container-column skips earlier, which micromark checks do not roll back.
Observing the existing EOF failure preserves that traversal order. Subsequent
checks inspect only the opening dollar run, preserving tokens and source
offsets. A new streaming parse gets a fresh context/index, and the WeakMap
permits completed contexts to be collected.

For `"prefix " + Array.from({length:k}, (_,i) => "$".repeat(i+2) + "x").join(" ")`,
the regression counts actual `effects.consume` calls, including speculative
consumption rolled back by checks and failed attempts:

| k | Source bytes | Original work | Bounded work |
| ---: | ---: | ---: | ---: |
| 128 | 8,646 | 740,544 | 25,661 |
| 256 | 33,670 | 5,757,312 | 100,477 |
| 512 | 132,870 | 45,396,736 | 397,565 |

The deterministic budget is at most four consumptions per source character
for these unmatched-run workloads, including generated permutations. It was
confirmed to fail against the unmodified installed tokenizer before the fix.
This bounds the malformed math retry path; it is not a complexity claim about
all CommonMark parsing or KaTeX rendering. Full-tree differential properties
use the installed upstream extensions as the syntax/position oracle, with
single-dollar parsing disabled, enabled, and enabled with the merged currency
and boundary policy from PR #3739. That combined pipeline also has deterministic
and generated work-budget coverage. Streaming-prefix comparisons
cover multi-dollar math, code, containers, escapes, CRLF, tabs and Unicode.

```sh
pnpm test apps/desktop/src/renderer/src/lib/__tests__/markdown-math-budget.property.test.ts
```

## Validation and measurements

### Formula clipboard exports

The demand-loaded math runtime wraps each complete KaTeX root once, preserving
its original MathML, layout, and source annotation. A compact hover/focus copy
menu offers transparent PNG, exact LaTeX, and formatted HTML. Its clipboard
context is eager but has no export dependencies. Only an image or HTML action
imports `math-clipboard-export`; LaTeX copy does not load it. Copy feedback is
outside the selectable formula, and menu navigation uses the shared keyboard
and dismissal behavior.

Exports freeze the current KaTeX layout and embed only its used WOFF2 font
faces. HTML carries inline styles, embedded fonts, MathML, and a plain-text
LaTeX flavor. Paste targets may sanitize fonts or styles. PNG uses transparent
padding and defaults to dark ink at 2x resolution. Export options offer dark,
light, or current app-theme ink for both PNG and HTML, and 1x, 2x, or 4x PNG
scale. Explicit TeX colors remain intact. Every scale is capped at 8192 pixels
per edge and 16 million pixels before image decoding or canvas allocation.
The receiving app determines the pasted image's physical size.

Choices persist locally in `pwragent.math.exportOptions`, following the existing
renderer view-preference pattern. Menus read preferences on open; only explicit
option changes write them. There are no per-formula preference subscriptions,
SQLite writes, background rasterization, or new rendering dependencies. Export
work happens on click, and LaTeX copy is unaffected by these options.

`pnpm --filter @pwragent/desktop exec tsx scripts/verify-math-clipboard.ts` builds
a production Chromium fixture with contrived formulas and an intercepted
clipboard. It checks both inline and display copy, exact source, self-contained
HTML fonts, transparent PNG pixels, unclipped borders, theme-independent dark
ink, persisted color/scale choices across reloads, small-window menu placement,
and export code loading only on demand. Artifacts go under
`.local/formula-clipboard/`.

### Math asset loading

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
