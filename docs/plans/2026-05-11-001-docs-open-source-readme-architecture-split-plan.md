---
title: Open-source-ready README + architecture/contributor doc split
type: docs
status: active
date: 2026-05-11
---

# Open-source-ready README + architecture/contributor doc split

## Overview

PwrAgent is preparing to go public (MIT license already landed in [c9b25009](https://github.com/pwrdrvr/PwrAgent/commit/c9b25009)). The current top-level documentation is internal-shaped: a 308-line [README.md](README.md) that opens with a Mermaid data-storage diagram, dives into pnpm workspace layout, dev diagnostics, and Codex App Server endpoint coverage before any user ever sees what the app *does*. There are no screenshots, no "why would I use this," and most of the body is content that a contributor — not a first-time visitor — needs.

This plan rewrites the top of the funnel. It does **not** build the [#311](https://github.com/pwrdrvr/PwrAgent/issues/311) versioned docs site. That work stays parked. The deliverable here is a hook-first README, a real ARCHITECTURE.md that owns the technical detail currently sprawled across README, and an expanded CONTRIBUTING.md that absorbs the developer/diagnostic content. A GitHub-Pages-backed `docs.pwragent.ai` is included as a thin, optional follow-on — a single landing page that points at the GitHub repo, *not* a docs platform.

## Problem Statement / Motivation

Today's [README.md](README.md) fails the "would a stranger try this in 30 seconds?" test:

1. **No user-facing pitch.** First content is a Mermaid graph of sqlite stores. A new visitor cannot tell from the first screen what PwrAgent looks like, what it competes with, or why they would install it.
2. **No screenshots.** The product's whole value proposition — thread-first browsing, messenger-bound threads, pairing flow, closed-by-default safety — is visual. None of it is shown.
3. **Wrong audience mix.** Workspace layout, `PWRAGNT_HEAP_DIAGNOSTICS`, Codex App Server endpoint matrix, replay-fixture recipes — all valuable, none of it relevant on first contact.
4. **Wide diagrams.** The data-storage graph and the messaging-architecture diagrams render too wide on GitHub's rendered markdown column (~900px). They wrap awkwardly and obscure the layered story.
5. **No positioning story.** Visitors familiar with [pwrdrvr/openclaw-codex-app-server](https://github.com/pwrdrvr/openclaw-codex-app-server) need to know this project is its successor and what changed. Visitors who aren't need a one-sentence "messaging-platform-first coding agent."

The license flip ([c9b25009](https://github.com/pwrdrvr/PwrAgent/commit/c9b25009)) was the prerequisite for going public. Documentation is the welcome surface. Without this rewrite, opening the repo to the public publishes a contributor-facing scratchpad rather than a product.

## Proposed Solution

Three files change, one is born, one is optional, and a couple of conventions are codified:

| File | State today | Target |
|---|---|---|
| [README.md](README.md) | 308 lines, dev-focused, no images | ~150 lines, user-focused, screenshot-led, links downstream for depth |
| [ARCHITECTURE.md](ARCHITECTURE.md) | does not exist | New top-level doc that absorbs data-storage layout, messaging architecture summary, and process model. Wide diagrams are split into narrower, layered diagrams. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 43 lines | Expanded to absorb workspace layout, dev diagnostics (heap, CPU profiling), testing/replay workflow, internal agent-core endpoint coverage |
| `docs.pwragent.ai` | not configured | **Optional, gated.** A minimal GitHub-Pages-served single page that redirects/links to the GitHub README. Buys the domain a presence without committing to [#311](https://github.com/pwrdrvr/PwrAgent/issues/311). |
| Existing detail docs (`docs/messaging-*.md`, `docs/state-layout.md`, `docs/desktop-release-runbook.md`, etc.) | Already where they belong | Unchanged. Linked from ARCHITECTURE.md and CONTRIBUTING.md as deep dives. |

The README's job is to make a stranger want to try the app. The ARCHITECTURE doc's job is to satisfy the engineer who decides "yes, but how does it actually work." CONTRIBUTING owns everything someone needs to run, hack on, and ship the project. None of these files duplicate content — each links to its successor.

## Scope

### In scope

- Rewriting [README.md](README.md) end-to-end against a screenshot-led template.
- Capturing 4–6 product screenshots in `docs/assets/` (or `assets/`, decision below) at consistent dimensions.
- Creating a new top-level [ARCHITECTURE.md](ARCHITECTURE.md).
- Expanding [CONTRIBUTING.md](CONTRIBUTING.md) to absorb dev/internal content from README.
- Splitting two wide diagrams (data storage graph + messaging architecture graph) into narrower, layered alternatives. Edits land in ARCHITECTURE.md; the source-of-truth diagrams in [docs/messaging-architecture.md](docs/messaging-architecture.md) may also be re-laid-out in the same pass if the splits are reusable there.
- A one-paragraph positioning blurb on the OpenClaw lineage (see "Positioning" below).
- Adding a `## Status` / "alpha, expect breakage" callout where it's actually useful — early in README, not buried at line 9.
- **Removing the MIT license badge** from the README header. License disclosure stays in the `## License` section at the bottom and in [LICENSE](LICENSE); the yellow SPDX shield doesn't fit the project's visual identity.
- Wiring `docs.pwragent.ai` to a GitHub-Pages-served Jekyll site under `docs-site/` (or `gh-pages` branch) with a small set of messaging-operator pages. See the `docs.pwragent.ai` section below. DNS will be configured the morning after this lands.

### Out of scope (explicit non-goals)

- **The [#311](https://github.com/pwrdrvr/PwrAgent/issues/311) versioned docs site.** No Docusaurus / VitePress / Starlight / Cloudflare Pages / microapps-core build. Defer.
- **Marketing/landing/pricing site.** The `docs.pwragent.ai` stub is technical, not commercial.
- **Per-version docs.** The README and ARCHITECTURE.md describe `main`. Older versions point at their git-tag README.
- **Re-architecting `docs/` content.** Existing deep-dive docs (`messaging-*.md`, `state-layout.md`, `config-file-evolution.md`, etc.) stay where they are. We link to them.
- **Logo/brand work.** Use whatever the desktop app currently ships. Don't open a brand workstream.
- **Translations.** English only.
- **Heavy AI/chatbot doc features** flagged in [#311](https://github.com/pwrdrvr/PwrAgent/issues/311). Out.

## Positioning narrative (OpenClaw lineage)

The README should mention the predecessor exactly once, in a short paragraph near the end (something like a "## Background" or "## Origins" section), worded so it doesn't read as "this is the OpenClaw spinoff." Draft target:

> PwrAgent grew out of [openclaw-codex-app-server](https://github.com/pwrdrvr/openclaw-codex-app-server), a PwrDrvr LLC project that brought Codex into Telegram and Discord. PwrAgent supersedes it: a desktop-first, thread-centric coding-agent shell with first-class messenger integration, and a generic messaging protocol the project has been incubating. That protocol is now stable enough that the next step is bringing it back upstream into OpenClaw.

Two beats: "here's where it came from, and it's replaced now" plus "the messaging protocol is heading back to OpenClaw." No marketing tone. The rest of the README sells the product on its own.

## User-focused README structure

Target shape — what a first-time visitor sees, in order:

1. **One-line tagline** + (optional) "alpha" badge. **No MIT badge** — the SPDX MIT shield renders yellow and clashes with the project palette. License lives at the bottom of the README and in [LICENSE](LICENSE); that's enough.
2. **Hero screenshot** (the recents/threads view, populated, looking alive).
3. **Two-paragraph pitch.** What it is, who it's for. Lead with the messenger-bound-threads angle — that's the differentiator.
4. **"What you can do" section** — 4 short rows, each with a small screenshot or caption:
   - **Monitor bound threads from your messenger.** Screenshot: thread row with messenger badge.
   - **See messenger status at a glance.** Screenshot: messenger status indicator / settings card.
   - **Pair the desktop with a chat bot.** Screenshot or short caption: pairing flow.
   - **Closed-by-default safety.** Screenshot or caption: approval gate UI / closed state.
5. **Quick Start.** macOS install path; `pnpm install && pnpm dev` for source builds. Two sub-blocks max.
6. **Status & roadmap.** "Alpha. macOS only today. Watch the repo for releases."
7. **Background / origins.** OpenClaw paragraph from above.
8. **Deeper reading.** Links: ARCHITECTURE.md, CONTRIBUTING.md, SECURITY.md, the relevant `docs/` deep dives.
9. **License.** One line.

That's it. No diagrams. No env-var tables. No endpoint matrices. No diagnostics blocks. Total length: ~150 lines or less.

### Screenshot capture list

Capture set, all from the running desktop app, consistent window size (suggest 1440×900 macOS), light theme by default and dark theme variants where useful. Store under `docs/assets/screenshots/` (confirmed). Naming: `screenshot-<topic>.png`.

1. `screenshot-recents-hero.png` — Recents lens populated with several threads, at least one with a messenger badge.
2. `screenshot-bound-thread.png` — A thread detail view with the linked messenger context visible.
3. `screenshot-messenger-status.png` — Settings or status surface showing Telegram/Discord/Mattermost connection state.
4. `screenshot-pairing.png` — The pairing/binding flow (or a clean settings-card view if there is no dedicated wizard).
5. `screenshot-closed-by-default.png` — Approval gate / closed-thread surface that conveys "the agent isn't acting on its own."
6. *(optional)* `screenshot-multi-directory-thread.png` — Demonstrate multi-directory thread linking.

If any of those surfaces aren't yet visually convincing enough to ship publicly, drop the row from the README rather than ship a confusing screenshot. Better to show three good ones than six mixed.

## ARCHITECTURE.md structure

A new top-level [ARCHITECTURE.md](ARCHITECTURE.md). Target length: ~200–300 lines, link-heavy.

Outline:

1. **Process model.** Electron main + renderer + Codex App Server child process (Grok-backed today). One narrow diagram, ~3 nodes wide.
2. **Storage layers.** Replaces the wide data-storage Mermaid currently in README. Three narrower diagrams, one per layer:
   - Desktop state (sqlite WAL: messaging, overlay, secrets).
   - Agent-core threads (rollout.jsonl + thread.toml per thread).
   - Protocol captures (dev-only).
   Plus the existing storage-table.
3. **Messaging layer summary.** ~half a page that says "the messaging protocol is provider-agnostic; here are the layers; here's where to read more." One narrow stacked diagram with three boxes: `interface → providers → desktop orchestration`. Detailed content stays in [docs/messaging-architecture.md](docs/messaging-architecture.md).
4. **Dependency boundaries.** Restate the layered hierarchy from [CLAUDE.md](CLAUDE.md). One narrow vertical diagram (leaves at the bottom, app at the top). Link to `.dependency-cruiser.cjs`.
5. **Where things live (workspace map).** Brief tree: `apps/desktop`, `packages/shared`, `packages/agent-core`, `packages/messaging/*`.
6. **Cross-references.** Links to messaging deep dives, state-layout, release runbook, etc.

### Diagram splitting plan

The two wide diagrams to redo:

**A. README data-storage graph** (currently 6 nodes wide across three subgraphs):

Split into three narrower diagrams, each <=3 columns wide:

- **A1 — Desktop main-process stores** (vertical: Shell → MsgStore/OvlStore/SecStore → state.db; ConfigTOML as a side node).
- **A2 — Agent-core thread storage** (vertical: GrokSrv → RolloutJSONL / ThreadTOML / GrokConfig).
- **A3 — Protocol captures (dev-only)** (vertical: Observer → CaptureJSONL + index.json).

Connecting the three is the existing IPC/JSON-RPC story — describe in prose under the three diagrams, not as a fourth wide graph.

**B. Messaging architecture diagram** (in [docs/messaging-architecture.md](docs/messaging-architecture.md)):

Audit the existing diagrams in that file; whichever read as the widest, split along the same axis (layers → providers → callback paths) into two or three narrower diagrams. If the existing diagrams already fit GitHub's column width, leave them alone — but the README's data-storage graph is the load-bearing problem, fix that one first.

Mermaid direction: prefer `graph TB` (top-bottom) over `graph LR` (left-right) for anything with more than 2 nodes per row. Subgraphs containing >3 nodes wide are the failure mode to avoid.

## CONTRIBUTING.md additions

Expand current 43-line file with the dev/internal sections currently in README:

- **Workspace map** (the `apps/desktop` / `packages/*` list).
- **Messaging integration developer notes** (the four-bullet block about messaging architecture docs).
- **Testing workflow.** Move the protocol-capture / replay-fixture workflow here. Reference the project-local [desktop E2E fixture seeding skill](.agents/skills/desktop-e2e-fixture-seeding/SKILL.md).
- **Dev diagnostics.** Heap diagnostics + Startup CPU profiling sections move here verbatim.
- **Agent-core internal notes.** Codex App Server endpoint coverage matrix, runtime config keys, live smoke coverage commands. (This is internal-API depth; not for the README, not for ARCHITECTURE — it belongs with the people working on it.)
- **PR conventions** (already present; keep).
- **Dependency boundary enforcement** (already present; keep, but link to ARCHITECTURE.md's deeper write-up).

If CONTRIBUTING.md grows past ~250 lines, that's fine — contributors will read it. The README must not.

## docs.pwragent.ai via GitHub Pages

**Confirmed.** User will configure DNS (`docs.pwragent.ai` CNAME → `pwrdrvr.github.io`) the morning after this lands. The PR ships the Pages source so the site is live the moment DNS resolves.

Minimum-viable shape for v1 of the site:

- A Jekyll-on-Pages source under a `docs-site/` directory in this repo (or `gh-pages` branch — pick whichever Pages config the repo's GitHub settings already prefer; default to `gh-pages` branch if no preference is set).
- Single `index.md` with: project name, one-line pitch, hero screenshot, "Get the app" + "GitHub repo" links, and a short table of contents pointing at the long-form pages below.
- A small set of long-form pages that have a real home for the first time:
  - `/messaging/telegram.md` — detailed Telegram bot setup, allowlists, what the options mean, recommended defaults.
  - `/messaging/discord.md` — detailed Discord bot setup, same shape.
  - `/messaging/mattermost.md` — detailed Mattermost setup, including the Cloudflare-Tunnel / Tailscale-Funnel guidance currently in [docs/messaging-platform-integration.md](docs/messaging-platform-integration.md).
  - `/messaging/overview.md` — provider-agnostic concepts: bound threads, allowlists, capability profiles, callback delivery models. Lifted from [docs/messaging-architecture.md](docs/messaging-architecture.md) but pitched at *operators* (people running the app), not contributors.
- A `CNAME` file containing `docs.pwragent.ai`.
- Default `minima` theme (Pages' built-in). No custom theme work.
- TLS: GitHub Pages issues automatically once DNS resolves.
- No versioning. No sidebar trees. No search. No analytics. Anything fancier is [#311](https://github.com/pwrdrvr/PwrAgent/issues/311) creep — defer.

**Source-of-truth decision:** the messaging-provider operator content (Telegram, Discord, Mattermost setup) moves to the Pages site as its *new* home. The existing [docs/messaging-platform-integration.md](docs/messaging-platform-integration.md) either (a) becomes a redirect-style stub pointing at `docs.pwragent.ai/messaging/`, or (b) is split — operator content moves to Pages, contributor/architecture content stays in `docs/` linked from ARCHITECTURE.md. **Prefer (b)** so contributors don't have to leave the repo to understand the messaging layer, while operators get a polished site.

GitHub Pages TOS allows this since the page is non-commercial — pure project documentation. The constraint flagged in [#311](https://github.com/pwrdrvr/PwrAgent/issues/311) (TOS forbids primary SaaS commerce) does not apply.

This is **not** [#311](https://github.com/pwrdrvr/PwrAgent/issues/311). No Docusaurus / VitePress / Starlight. No versioned `/v1.0/` tree. No path migration story. Just markdown rendered by Pages' default theme. When [#311](https://github.com/pwrdrvr/PwrAgent/issues/311) actually ships, the content here ports forward; the URL structure may change and that's an acceptable cost (early-days redirects are cheap).

## System-Wide Impact

- **Internal links.** README currently has ~15 markdown links into `docs/`. Verify each survives the move (links from README → `docs/state-layout.md`, etc., still resolve; new links from ARCHITECTURE.md and CONTRIBUTING.md to the same files are added).
- **External links pointing at the README.** Any external doc, blog post, or [pwrdrvr/openclaw-codex-app-server](https://github.com/pwrdrvr/openclaw-codex-app-server) reference that deep-links to a README anchor (`#data-storage-architecture`, `#testing`, `#heap-diagnostics`) breaks. Audit before merge; if any are load-bearing, add anchor redirects via a "## Moved" note in README, or rename targets gently.
- **Existing PRs / branches.** Any open PR that edits README will need rebase. Communicate before the rewrite lands.
- **Desktop app "About" / Help links.** If the desktop renderer links to README anchors, audit those (search for `github.com/pwrdrvr/PwrAgent` / `README` in `apps/desktop/`).
- **Search/SEO.** Going from "internal scratchpad" to "user-facing landing" is a positive surface-area change; nothing to mitigate.

## Acceptance Criteria

- [ ] [README.md](README.md) is ≤200 lines, opens with tagline + hero screenshot + two-paragraph pitch, contains zero Mermaid diagrams, and contains the OpenClaw-lineage paragraph.
- [ ] At least three screenshots committed under `docs/assets/screenshots/` and referenced from README.
- [ ] [ARCHITECTURE.md](ARCHITECTURE.md) exists, describes process model, storage layers (three split diagrams), messaging layer summary, dependency boundaries, and links to the existing deep dives.
- [ ] [CONTRIBUTING.md](CONTRIBUTING.md) absorbs workspace map, testing/replay workflow, dev diagnostics, internal agent-core notes, and links cleanly back to ARCHITECTURE.md.
- [ ] All Mermaid diagrams in README and ARCHITECTURE.md render within GitHub's content column without horizontal scroll on a 1280px viewport (manual visual check).
- [ ] No content from the old README is silently dropped — every section is either kept (in another file) or explicitly decided to be removed (e.g., redundant info already in `docs/`).
- [ ] OpenClaw-lineage paragraph appears once, in the README, and mentions both:
  - That PwrAgent supersedes [pwrdrvr/openclaw-codex-app-server](https://github.com/pwrdrvr/openclaw-codex-app-server).
  - That the messaging protocol developed here is intended to flow back into OpenClaw.
- [ ] No reference to issue [#311](https://github.com/pwrdrvr/PwrAgent/issues/311)'s docs-site solution exists in README, ARCHITECTURE, or CONTRIBUTING. (#311 is still tracked separately.)
- [ ] No MIT badge in the README header (license stays at the bottom).
- [ ] `docs-site/` (or `gh-pages` branch) source committed with: `index.md`, `messaging/overview.md`, `messaging/telegram.md`, `messaging/discord.md`, `messaging/mattermost.md`, `CNAME` containing `docs.pwragent.ai`, default theme. Pages-readiness verified via the GitHub Pages build (site renders before DNS lands).
- [ ] [docs/messaging-platform-integration.md](docs/messaging-platform-integration.md) is split: operator content moves to `docs-site/messaging/`; contributor/architecture content stays in `docs/` linked from ARCHITECTURE.md. No content is lost in the split.
- [ ] Internal-link audit: every link in the rewritten README + new ARCHITECTURE.md + updated CONTRIBUTING.md resolves to an existing file in the repo.
- [ ] Commit is one PR titled `docs: open-source-ready README + architecture split` (matches repo's Conventional-Commit scope rules per [CLAUDE.md](CLAUDE.md)).

## Success Metrics

- A stranger landing on the GitHub repo can answer "what is this and would I try it?" in <60 seconds. (Self-check: have a non-team reader skim it; ask them to summarize.)
- README size drops from 308 to ≤200 lines while signal-per-line goes up.
- Zero diagrams in README require horizontal scrolling on GitHub's default rendered column.
- ARCHITECTURE.md and CONTRIBUTING.md fully cover the technical detail removed from README — no orphaned content.

## Dependencies & Risks

- **Depends on:** MIT license flip ([c9b25009](https://github.com/pwrdrvr/PwrAgent/commit/c9b25009)) — done.
- **Risk: screenshot decay.** Screenshots committed today drift as the UI evolves. Mitigation: keep the set small (≤6), prefer screenshots of surfaces that are visually stable, and add a one-line note in CONTRIBUTING.md ("if you change a surface shown in README screenshots, regenerate the screenshot in the same PR").
- **Risk: anchor-link breakage.** External or internal deep links to old README anchors break. Mitigation: pre-merge audit (see System-Wide Impact).
- **Risk: scope creep into [#311](https://github.com/pwrdrvr/PwrAgent/issues/311).** The optional `docs.pwragent.ai` page must stay minimal — single page, default theme. Resist the urge to "while we're at it" build a sitemap. The whole point of this plan is to not be [#311](https://github.com/pwrdrvr/PwrAgent/issues/311).
- **Risk: the OpenClaw lineage paragraph reads wrong.** Two failure modes: (a) too much OpenClaw, making PwrAgent sound like a spinoff; (b) too little, leaving OpenClaw users confused about whether to migrate. Mitigation: draft both versions, prefer (b)-leaning unless the user pushes back.
- **Risk: Pages CNAME collides with future hosting.** If we later move docs to Cloudflare Pages per [#311](https://github.com/pwrdrvr/PwrAgent/issues/311), the `docs.pwragent.ai` CNAME needs to flip. That's cheap (one DNS change), not a blocker.

## Implementation order

This is one PR, but ordering inside it matters because of the link audit:

1. **Draft new ARCHITECTURE.md** by lifting the storage section, splitting diagrams, and adding the process model + dependency-boundary content.
2. **Expand CONTRIBUTING.md** by moving dev diagnostics, testing, workspace map, agent-core notes from README.
3. **Capture screenshots.** Run the desktop app against a populated replay fixture (or a local profile with realistic data) and capture the six surfaces. Iterate until they read well.
4. **Rewrite README.md** against the screenshot-led template. Link forward to ARCHITECTURE.md and CONTRIBUTING.md.
5. **Link audit.** Grep the repo for `README.md#` anchors; grep `apps/desktop/` for hardcoded README URLs.
6. **Visual QA.** Open the rendered preview on GitHub for all three files; check diagram widths on a narrow viewport.
7. **Pages site.** Add `docs-site/` source + `CNAME`, port operator-facing messaging content from `docs/messaging-platform-integration.md`, verify GitHub Pages build succeeds in repo settings. DNS happens out-of-band (user the morning after).

## Sources & References

### Internal references

- [README.md](README.md) — current content to rewrite/relocate
- [CONTRIBUTING.md](CONTRIBUTING.md) — file to expand
- [CLAUDE.md](CLAUDE.md) — Conventional-Commit scope rules; documents the dependency-boundary architecture that ARCHITECTURE.md will summarize
- [docs/messaging-architecture.md](docs/messaging-architecture.md) — existing layered messaging write-up to summarize and link from ARCHITECTURE.md
- [docs/messaging-adapter-contract.md](docs/messaging-adapter-contract.md)
- [docs/messaging-adding-a-provider.md](docs/messaging-adding-a-provider.md)
- [docs/messaging-platform-integration.md](docs/messaging-platform-integration.md)
- [docs/state-layout.md](docs/state-layout.md)
- [docs/desktop-release-runbook.md](docs/desktop-release-runbook.md)
- [docs/third-party-license-notices.md](docs/third-party-license-notices.md)
- [docs/UI-THEME.md](docs/UI-THEME.md), [docs/design/desktop-style-guide.md](docs/design/desktop-style-guide.md) — referenced from ARCHITECTURE.md for renderer style story

### External references

- [pwrdrvr/openclaw-codex-app-server](https://github.com/pwrdrvr/openclaw-codex-app-server) — predecessor project the README references
- [GitHub Pages custom domain docs](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site) — for the optional `docs.pwragent.ai` step

### Related issues / commits

- [c9b25009](https://github.com/pwrdrvr/PwrAgent/commit/c9b25009) — MIT license flip (prerequisite)
- [#311](https://github.com/pwrdrvr/PwrAgent/issues/311) — the full versioned-docs-site initiative this plan is **explicitly not** doing
