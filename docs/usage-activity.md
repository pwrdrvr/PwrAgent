# Usage Activity

Open **Federation Activity → Usage**, select instances and a local-time window,
then choose **Read usage**. This is an on-demand view of PwrAgent's pricing
ledger, not a billing or subscription-quota report.

- The total includes only attributed turns and monitor intervals with both
  their recorded start and completion inside the selected half-open window.
  Pending ledger status does not exclude an otherwise completed, attributed
  turn. Cumulative counters, fork baselines, historical summaries and
  superseded rows do not contribute.
- Boundary-crossing, unfinished and unattributed rows remain inspectable in
  a separate table. Their whole-row prices are never assigned to the window
  or prorated. Missing records do not imply zero usage.
- Cached input remains separate from uncached input. Cache-write tokens are
  a subset of uncached input; reasoning tokens are a subset of output.
  Unpriced rows contribute tokens, but not a fabricated dollar estimate.
- Provider thread/turn identities deduplicate monitor/live representations
  and copies on multiple instances. An attributed live turn takes precedence
  over its monitor representation; otherwise the newest copy wins.
- Each owner reads its own PwrAgent SQLite ledger, with no new persistence or
  repricing writes. The read returns at most 5,000 recent candidate rows for
  windows up to 31 days. Four owner reads may run concurrently. Capped results,
  unavailable peers and older peers lacking the RPC are reported as partial
  coverage. Remote reads use the existing `thread_detail` capability.
- Account rate-limit snapshots are the owner's last observed Codex account
  buckets. They may be stale and are never summed across owners or attributed
  to threads. The available account usage/rate-limit contracts do not establish
  a per-thread subscription quota conversion.

**Inspect → Analyze** makes one explicit model call on the selected row's
owner, defaulting to GPT-6-Luna. The owner supplies its available Codex model
choices. Analysis uses one recent protocol page (at most ten turns), then
selects the newest entries within the operator's 1–100 entry and
1,000–40,000 character bounds. The UI offers conservative presets. The recent
page may differ from the activity window; returned coverage states this.

Only text and activity descriptions enter the prompt. Images, full-history
walks, automatic analysis fanout and Codex storage-file reads are excluded.
The existing ephemeral structured helper disables execution, delegation,
web search and configured MCP tools. Analysis consumes model usage, reports
unavailable transcripts/providers, and does not persist its answer.

Validation covers ledger reads with zero SQLite commits, timing boundaries,
cumulative and monitor deduplication, token subsets, missing peers,
owner-routed analysis, and server-side prompt limits. Browser rendering uses
contrived data; automated tests do not invoke a real model.
