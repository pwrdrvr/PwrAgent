---
name: loc-accounting
description: Count and compare repository lines of code using Git-tracked files, with product, test, documentation, generated, and vendored breakdowns. Use for LOC reports, historical comparisons, or evaluating cloc against loccount.
---

# Repository LOC accounting

Produce a reproducible, read-only snapshot of the requested repository. The
Pwr suite has used `cloc` code lines as its common baseline; a line is counted
as code rather than blank or comment. Use the user's requested metric and
exclusions when they differ. LOC and test-to-product ratios measure size, not
feature completeness, test coverage, quality, or engineering effort.

## Pin and select the input

- Record the full commit and short `HEAD`, repository path, tool versions, and
  whether a requested remote tip was actually verified. A local `origin/main`
  is only the last fetched tip. Do not fetch, switch branches, or modify a
  checkout without authorization.
- Use tracked paths from the requested commit. Prefer a clean checkout whose
  index matches that commit; do not silently include untracked or dirty files.
  A temporary `git archive` snapshot can isolate content, but archive
  attributes, symlinks and submodules can change what gets counted. Record the
  method and any missing paths. Do not use another thread's worktree.
- Exclude lockfiles (including nested `pnpm-lock.yaml`, `package-lock.json`,
  `yarn.lock`, `bun.lock*`, `Cargo.lock`, `Gemfile.lock`, `Pipfile.lock`,
  `poetry.lock`, `uv.lock`, `composer.lock`, and `go.sum`) and generated
  `THIRD_PARTY_LICENSES`. Report exclusions. Check for other lockfile formats.
  Account for gitlinks explicitly: distinguish tracked vendored trees from
  submodules, and say whether submodule contents were included or unavailable.
- By default report the total tracked selection and classify documentation and
  third-party or generated material separately. When the user asks to exclude
  them, state that scope and still identify substantial excluded material.
  Adapt to the repository: for example, `.repos/` in a t3code snapshot held
  vendored reference trees, but do not assume another checkout has the same
  layout. Inspect `Vendor/` and other third-party paths outside that directory.

## Count and classify

Use `cloc` from PATH (on the operator's Mac it has been at
`/opt/homebrew/bin/cloc`). Make one file list from the pinned tracked selection
and run `cloc --list-file=<list> --by-file --csv --report-file=<csv>` once.
Capture diagnostics as well as the exit status; `cloc` can exit successfully
while omitting timed-out files. Do not pass lockfiles or the excluded license
report in the list. A list file is line-delimited: detect filenames containing
newlines and use a safe alternative or report the limitation. Avoid printing
unbounded per-file output.

Keep `cloc`'s default duplicate handling for comparisons with the previous Pwr
suite reports. Derive both language totals and exclusive category totals from
the **same by-file run**, and reconcile them to its SUM. Separate invocations
can select different copies of identical files, affecting category totals and
sometimes the total itself. Record timeouts, unknown formats, duplicates and
other omissions; do not present an incomplete result as exact. If `cloc` is
unavailable, report the blocker or use a clearly labeled alternative rather
than silently changing methods.

Classify paths against the repository's actual layout, inspecting large and
ambiguous entries. Make the buckets mutually exclusive and report precedence
where paths overlap:

- Product source: split the desktop main, renderer (including CSS), preload,
  shared/native code, and each workspace package as applicable. Keep test and
  non-product support files out. Report substantial data such as translation
  JSON separately if it materially affects the product subtotal.
- Unit tests and test support (`*.test.*`, `*.spec.*`, `__tests__/`,
  `test-support/`, and repository-specific test kits and testing packages),
  with E2E/integration tests separately. Explain whether fixtures are included.
- Design artboards, scripts and CI, Markdown/docs, and other substantial
  fixtures, generated code or vendor files. Documentation inside test or
  design paths requires an explicit precedence, especially when excluded.

Report files and code lines per language, comment total, category counts and
paths, and test/product ratio using the stated test and product buckets.
Identify large generated or vendored files counted by `cloc`; count SQL
migration versions when meaningful, distinguishing an initial schema from
subsequent migrations. Explain changes in methodology before comparing with a
past result. Preserve snapshot-specific results as dated evidence, not as
current repository facts.

## Optional loccount comparison

If requested or useful, compare Eric S. Raymond's
[loccount](https://gitlab.com/esr/loccount) with `cloc` on the same selection.
An operator may already have `~/.local/bin/loccount`; check its version. Do not
install or update tools without the appropriate authorization.

Loccount's `--no-duplicates` is its closest counterpart to `cloc`'s default;
its own default counts copies. `-j` emits JSON lines, and `-k` is needed when
passing explicit paths inside a Git checkout. Check the operating system's
argument limit before passing a large list; do not naively split invocations
and sum them, because that loses global duplicate handling. A directory-mode
run can be used with documented exclusions and limitations if it cannot accept
the list.

Even with the same paths, loccount may skip hidden paths, README files,
symlinks and generated files, and its language identification differs. Capture
and summarize scanner errors and warnings, including successful exits. It does
not report comment or blank totals. Its LLOC support is language-specific;
never present a partial LLOC sum as the whole project's logical-line count.
Investigate large tool discrepancies rather than attributing them to one
cause without evidence.

## Comparisons and reporting

Lead with a compact snapshot: repo and commit, total, product/test/E2E split,
ratio, and change from a comparable earlier snapshot. Follow with the requested
language and bucket tables, explicit exclusions and material limitations.
PwrGit, PwrSnap, PwrRoute, t3code and OpenClaw may be useful comparison points
when relevant to the user's question, but use verified commits and matching
scope, and do not infer completeness or coverage from LOC. If asked to judge
completeness, compare actual capabilities separately and cite the evidence for
each project. Never treat a historical number or prior layout as current
without checking.
