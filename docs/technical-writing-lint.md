# Technical writing lint

PwrAgent uses Vale for a small, repository-owned set of Simplified Technical
English-inspired checks. The checks are drafting aids, not an ASD-STE100
compliance test. They do not include the ASD-STE100 controlled vocabulary or
copied standard text.

## Local use

Install the Vale executable from [vale.sh](https://vale.sh/docs/), then run:

```sh
pnpm lint:prose
pnpm test:prose
```

The default profile reports warnings for:

- sentences longer than 35 words;
- clear contractions; and
- a small set of vague technical verbs, such as `utilize` and `leverage`.

The passive-voice rule is a suggestion because passive voice can be correct
when the actor is unknown or unimportant. Review all four rule families with:

```sh
pnpm lint:prose -- --minAlertLevel=suggestion
```

Vale understands Markdown and excludes fenced code from these prose rules. The
fixture test also protects this boundary. Use inline code, fenced code, and
technical identifiers freely; the linter is for surrounding prose.

## CI behavior

The CI job installs Vale 3.14.2 and scans repository Markdown while excluding
historical plan, brainstorm, and solution directories. The wrapper converts
warnings and suggestions into GitHub annotations. This keeps the existing
Markdown baseline visible without turning the current documentation corpus into
a mass rewrite. The CI check is advisory: it does not block a merge. Promote a
rule to an error only after measuring its false-positive rate on representative
Markdown and updating the fixtures.

The baseline audit covered all seven repository `AGENTS.md` files. The default
warning profile produced 27 clear-contraction findings and 13 long-sentence
findings. The optional passive-voice review produced 74 suggestions. Matching
text inside a fenced code block produced no finding in the fixture test.

Vale 3.14.2 is MIT-licensed and is the only new external tool. It is not a
package-manager dependency; local installation is an executable on `PATH`, and
CI installs the pinned release archive. The wrapper, configuration, rules, and
fixtures in this repository are covered by PwrAgent's MIT license.
