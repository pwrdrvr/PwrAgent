# Focused summaries of retained output

`summarize_token_miser_output` answers questions using selected preserved tool
output without sending that source through the parent context. It uses the same
configured helper model and structured-generation lifecycle as the Token Miser
gate. No model override is supplied by this tool.

The four existing search/read tools, their inputs, object IDs, and read behavior
are unchanged. The new tools are available through the unified PwrAgent catalog,
including tool discovery, Code Mode and MCP.

## Enablement

In **Settings → Experimental → Token Miser**, enable **Focused summaries**.
This additional feature defaults off, independently of ordinary Token Miser
summaries and the inherited per-thread default. The profile setting is
`[experimental].token_miser_focused_summaries_enabled`.

The global Token Miser experiment and the invoking thread's Token Miser setting
must also allow summaries. Turning focused summaries off hides the two new tools
from discovery and rejects new inference requests, including calls from threads
that already know the tool names. Existing segment references and the original
exact-read tools remain usable within their retention limits. A helper already
in flight retains its incurred usage accounting, but its answer is suppressed
if the switch is off when it completes.

This feature requires no additional changes to the custom Codex fork or its
protocol. PwrAgent's TypeScript adapter uses the existing structured-helper and
Code Mode delivery interfaces. It still requires the Token Miser-compatible
Codex build used by the main experiment. Automated tests exercise mocked helper
responses; answer quality and practical savings still need normal-use validation.

## Code Mode example

A build produced a retained object. Ask separate questions about its beginning,
its diagnostics, and its final status in one inference:

```js
const answers = await tools.pwragent__summarize_token_miser_output({
  requests: [
    {
      question: "Which build configuration and targets were selected?",
      selections: [{ objectId: "<output-id>", mode: "head", lines: 30 }],
    },
    {
      question: "Which failures recur, and what distinguishes them?",
      selections: [{
        objectId: "<output-id>", mode: "search",
        queries: ["error", "failed", "warning"], maxMatches: 60,
      }],
    },
    {
      question: "Did the build finish, and how many targets failed?",
      selections: [{ objectId: "<output-id>", mode: "tail", lines: 40 }],
    },
  ],
});
text(answers);
```

The returned authenticated string contains summaries, segment IDs and source
IDs, never selected source text. Emit the string unchanged. To emit only some
answers, request those answers in separate calls and emit only those returned
strings. A parsed/reconstructed string loses authenticated delivery accounting,
just as with the existing exact-output tools. Pending delivery authentication
lasts two minutes; emit responses promptly. Batches are atomic: a validation,
source or helper-response failure returns an error, not partial answers.

A question may combine several selections, including different original
objects from the same thread and turn. Use `mode: "lines"` with one-based
inclusive `startLine` and `endLine` for a middle range. For a grouped Code Mode
result, use its existing `groupId` and the member's existing `objectId` in the
selector; no preliminary read is necessary. Alternatively, use a known root
`sourceObjectId` as `objectId` with `memberId`.

Recover exact selected source using an answer's `segmentId`:

```js
text(await tools.pwragent__read_token_miser_segment({
  segmentId: "<segment-id>",
}));
// If nextCursor is present, pass it unchanged on the next read:
text(await tools.pwragent__read_token_miser_segment({
  segmentId: "<segment-id>", cursor: { spanIndex: 1, offset: 6000 },
}));
```

## Selection and provenance

Search uses the existing literal, case-insensitive, trimmed-query semantics.
Multiple queries form an OR; a matching line is selected once. The first
`maxMatches` matching lines in source order are selected, without implied
surrounding context. Head/tail default to 100 lines. Out-of-bounds ranges
intersect the available lines; an empty intersection or search retains an
empty span with line bounds zero.

Within an answer, overlapping or adjacent selections of the same source merge.
Sources preserve their first appearance order, then spans sort by offset. A
source's selected line terminators are preserved, including CRLF. Each exact
span identifies its original object, optional grouped member, inclusive line
bounds, and zero-based UTF-16 `[start,end)` offsets. Noncontiguous matches remain
separate JSON spans. Page `offset` is relative to that span; `text` is an exact
substring. `nextCursor` permits complete recovery without splitting Unicode
scalars or relying on parent output truncation.

Segment references contain only ownership, turn and source offsets. They share
the existing process-wide cache budget and expire after five minutes. Every
reread authorizes all source objects again. The next turn, archive, restart,
source eviction or reference eviction makes the reference unavailable; metadata
alone cannot resurrect source content. Wrong-owner and unavailable reads return
the same failure. There is no disk storage of selected text or questions.

## Bounds and helper isolation

| Boundary | Limit |
| --- | --- |
| Questions / selectors per batch | 16 / 16 total |
| Question size | 4,000 UTF-8 bytes each; 8,000 total |
| Head, tail or inclusive range | 2,000 lines per selector |
| Search queries | 16 per selector; 1,000 UTF-8 bytes each |
| Matching lines | 100 per selector; default 20 |
| Selected source | 60,000 UTF-8 bytes per batch, after overlap merging within each answer |
| Serialized helper prompt | 78,000 UTF-8 bytes, leaving room for system instructions under the existing 80 KB input ceiling |
| Helper answer | 1,000 UTF-8 bytes per question; invalid/oversized answers fail |
| Concurrent focused batches | 2 per service; excess calls fail immediately |
| Helper timeout | Existing configured summary timeout, default 45 seconds |
| Exact-source page | 6,000 source UTF-8 bytes / 16 spans |

One batch makes one inference. Repeated selections across different questions
are separate helper input, but never separate billing records for that
inference. Questions and selected text are explicitly untrusted data. Focused
helpers disable execution and delegation features, use the existing empty
environment and MCP isolation, and advertise no additional tools. Timeout cleanup
uses the existing helper interrupt/unsubscribe path. Source validity is checked
again after inference, so a late answer cannot revive an expired selection.

## Accounting

Helper inference and parent delivery have separate lifetimes:

- The actual reported helper usage produces one durable, parent-attributed
  monitor usage line per inference. Its model/service-tier rates price the
  work. Recording happens before answer validation and retention rechecks, so
  discarded or never-emitted answers still incur helper cost. Thread-level net
  Token Miser savings subtract this cost without inventing another source gate.
  An unpriced focused usage line suppresses the dollar savings estimate.
- Selecting source and retaining references do not record parent retrieval.
- Summary batches and exact-source pages use the existing authenticated
  delivery markers. Nested Code Mode calls do not confirm delivery; the outer
  model-visible boundary does, with its shared byte cap. A consumed marker
  cannot charge again. Multiple copies within one delivery count the bytes
  actually emitted each time, without repeating helper cost.
- Delivered summary JSON, including its provenance, contributes to the existing
  `retrievedCharacters` revealed-byte counter. The additive
  `focusedSummaryCharacters` counter records its summary subset. Exact-source
  delivery is the remainder. This preserves existing pricing/replay math.
- A combined batch is charged once to its first source object as an accounting
  anchor; its segment references retain all source lineage. Other source gates
  are not charged for the same output. This is a thread-total attribution rule,
  not a claim that the answer describes only its anchor.

Counters retain their historical `Characters` names but measure UTF-8 bytes.
Parent tokens remain estimates using the existing four-bytes-per-token rule.
If the helper protocol supplies no usage (including its existing failure or
timeout result), no measured inference cost can be synthesized. No paid or live
inference validation was used; helper results and usage were mocked.

The measured write budgets are zero commits for selection/reference creation,
one commit for an inference usage line (three SQL writes), and one commit for
an emitted batch (one SQL write). Fixtures observed 65,920 and 4,120 WAL bytes
respectively. At 100 emitted batches per day, that is approximately 7.0 MB/day;
at one batch per minute for eight hours, approximately 33.6 MB/day. Each emitted
exact-source page adds one existing retrieval commit (about 4.1 KB in this
fixture). There are no idle or per-source-line commits. WAL bytes vary with
page layout; the checked-in budgets assert deterministic commit/statement/row
counts.
