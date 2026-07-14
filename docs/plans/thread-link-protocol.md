# Thread Link Protocol (`pwragent://thread/…`)

Status: in progress
Date: 2026-07-14

## Problem

When an agent creates a thread via the `pwragent.handoff_task` tool, it reports
the result as prose containing a bare UUID:

> Created the PwrAgent handoff thread: `019f5d79-a595-73f2-84d9-a0976762c303`

That id is a dead end. The operator has to find the thread by hand. There is no
way for an agent — or a person — to *reference* a thread as a clickable target.

The root cause is not the missing link format. It is that **nothing in the
codebase authors that sentence.** `handoff_task` returns a JSON blob; the model
read `threadId` out of it and paraphrased. Any design that leaves the model to
assemble a URL from parts inherits that fragility.

## Design

### 1. The model copies a link, it does not construct one

`HandoffTaskResult` and `SendMessageToThreadResult` gain two additive fields:

- `threadUrl` — the canonical `pwragent://` URL.
- `threadLink` — a ready-made markdown link, `[<title>](<threadUrl>)`.

The `handoff_task` tool description instructs the model to reproduce
`threadLink` verbatim when it reports the new thread. Copying a string is a far
more reliable operation than assembling one.

### 2. Grammar

```
pwragent://thread/<threadId>[?backend=<kind>][&profile=<name>]
```

- **Thread id in the path.** It is the human-recognizable, greppable part, and
  it is what the model already holds.
- **Backend as an optional query param, not a path segment.** Backend kinds
  include `acp:<id>` — a colon that would need percent-encoding in a path,
  turning every ACP link into `pwragent://thread/acp%3Aclaude-code/019f…`. It
  can be optional because the renderer holds `snapshot.threads`, a flat list of
  every thread with its backend, id, and title, so an id alone resolves.
- **Profile optional.** Only meaningful for links that arrive from outside the
  app. A link naming a profile that is not the running one reports the mismatch
  rather than silently switching.
- **Reserved for later:** `pwragent://thread/<id>/turn/<turnId>` for
  message-level anchors. Not built now.

### 3. The scheme is navigation-only — permanently

**No action verbs. Ever.** Not `…/send?text=`, not `…/run`, not
`…/approve`.

Agent-authored markdown is attacker-influenceable content: a README, a fetched
web page, or a tool result can carry a prompt injection into a transcript. A
chip that navigates to a thread the operator already owns is harmless. A chip
that *acts* is a confused-deputy vulnerability. Declaring this while the scheme
is still empty costs nothing and keeps the feature permanently cheap to reason
about.

This rule decides the two existing scheme allowlists asymmetrically:

| Allowlist | `pwragent:` | Why |
|---|---|---|
| `isSafeMarkdownUrl` (`ThreadMarkdown.tsx`) | **added** | The renderer must see the href to render a chip. |
| `isSafeExternalOpenUrl` (`main/window.ts`) | **NOT added** | Our own scheme must never round-trip out through `shell.openExternal`. |

The chip `preventDefault`s and calls the existing `showThread`, exactly as
local-file links do today.

### 4. Rendering

A `ThreadChip` following the established `SkillChip` precedent — `ThreadMarkdown`
already swaps an `<a>` for a chip, so this is a second case of an existing
pattern, not a new mechanism. The chip renders the thread's **resolved title**,
not the raw uuid. An id that does not resolve degrades to plain text rather than
a dead chip.

Wiring is a small React context, not props. `ThreadMarkdown` also mounts in the
Activity window, Changelog window, and MarkdownFilesWindow, where no thread
navigation exists; a context with a null default gives those surfaces inert
chips for free, where prop-threading would mean five layers of `onShowThread`
(App → ThreadView → TranscriptList → TranscriptMessage → ThreadMarkdown).

The provider wraps the whole app and reads `navigation.threads`, which is a
fresh array on every snapshot patch (unread flips, `updatedAt` bumps, title
generation). To avoid re-rendering every transcript message on that churn, the
context value is keyed on a **membership signature** (the sorted set of
`backend:threadId` keys), not the array reference: identity changes only when a
link should flip between chip and plain text. Title/branch churn within stable
membership is not reflected until the next membership change — fine for a
reference chip, which points at a thread rather than mirroring its label live.

### 5. Retroactive linkification

Everything above only helps *future* handoffs. Existing transcripts carry the
thread id inside an inline code span, and `ThreadMarkdown` already overrides
`code`. When an inline code span's content is exactly a thread id that resolves
in `snapshot.threads`, render the chip.

This makes already-written transcripts clickable with no model cooperation, and
covers any model that ignores the link convention. False positives are
negligible: the value must resolve to a real thread the operator owns.

### 6. Copy Link

Thread row context menu gains **Copy Link**, writing the canonical `threadUrl`
to the clipboard. This gives the scheme a consumer beyond the agent — a thread
reference can be pasted into notes, an issue, or another thread's composer.

## Scope

**In:** in-app recognition only. The scheme is understood by the transcript
renderer; clicking routes through the existing `window:show-thread` path.

**Out — declined, not deferred:** OS-level registration
(`setAsDefaultProtocolClient`, an electron-builder `protocols` block, macOS
`open-url`, Windows/Linux `second-instance` argv, single-instance lock). The
scheme is not registered with the operating system, so `pwragent://` links are
inert outside PwrAgent. This keeps inbound URLs from arbitrary applications out
of the threat model entirely. Do not add it as a follow-on without an explicit
decision to reopen the question.

**Out:** messaging surfaces. A `pwragent://` link delivered to Telegram or
Discord is dead on a phone, and with no OS handler it stays that way.

## Work

- [x] `packages/shared/src/contracts/thread-link.ts` — grammar, build + parse,
      thread-id shape guard. Exported from the package index.
- [x] `HandoffTaskResult` / `SendMessageToThreadResult` gain `threadUrl` +
      `threadLink`; populated in `backend-registry.ts`.
- [x] `handoff_task` + `send_message_to_thread` tool descriptions instruct the
      model to reproduce `threadLink` verbatim.
- [x] `ThreadLinkContext` + `useThreadLink` in the renderer; provided from
      `App.tsx` over the navigation snapshot.
- [x] `ThreadChip` component + styles.
- [x] `ThreadMarkdown`: allow `pwragent:` in `isSafeMarkdownUrl`, render `a` →
      `ThreadChip`, linkify resolvable ids in inline `code`.
- [x] Thread row context menu → **Copy Link**.
- [x] Tests: grammar round-trip, chip rendering, inline-code linkification,
      unresolvable-id degradation, and that `pwragent:` never reaches
      `shell.openExternal`.
