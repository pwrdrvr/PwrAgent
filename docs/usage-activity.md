# Usage Activity

Usage Activity is its own window. Open it from **PwrAgent → Usage Activity**
(Help → Usage Activity on Windows and Linux), the profile menu at the bottom
of the sidebar, **Usage Activity** in a thread's Pricing panel, or by clicking
the context moon beside the composer. It shows PwrAgent's pricing ledger beside
the account limits Codex reports. It is not a billing report, and it never
converts spend into a share of a quota.

The window reads as soon as it opens, again whenever the period or the
selected instances change, and again when it regains focus with data more than
a minute old. **Refresh** rereads at any time. A custom range reads once typing
pauses. Offline peers are shown but not selectable, so a read never waits on
them.

## Periods

- **Since reset** starts where the focused account's longest limit last
  restarted: the weekly limit, or the individual credit limit on a
  pay-per-token account. **5-hour window** starts where the 5-hour limit
  restarted. **Today**, **24 h**, **7 days** and **Custom** are clock windows.
- A limit's start is the later of its scheduled start (`resetAt` minus the
  window length) and the last reset PwrAgent observed. An individual credit
  limit states no window length; its window is taken as the calendar month
  before its reset.
- Before limits are known, the limit presets read a provisional window (8
  days, or 5 hours) and narrow it on the client. When the start lies earlier
  than what was read, the view reads once more from the start. Every read is
  bounded to 31 days. Turns that finished before a narrowed start are outside
  the window and are dropped, not listed as not counted.

## Totals

- The total includes only attributed turns and monitor intervals with both
  their recorded start and completion inside the selected half-open window.
  Pending ledger status does not exclude an otherwise completed, attributed
  turn. Cumulative counters, fork baselines, historical summaries and
  superseded rows do not contribute.
- Boundary-crossing, unfinished and unattributed rows remain inspectable
  through the **not counted** link, each with its reason. Their whole-row
  prices are never assigned to the window or prorated.
- A row with no recorded completion is read only while its last ledger update
  falls inside the window. A turn whose end was never observed (an interrupted
  turn, or an ACP turn that never reported one) recorded nothing after that
  update, so it no longer matches every later window.
- Monitor lines are written already finalized and carry no completion time;
  their write time is their completion.
- Cached input remains separate from uncached input. Cache-write tokens are
  a subset of uncached input; reasoning tokens are a subset of output.
  Unpriced rows contribute tokens, but not a fabricated dollar estimate.
- Provider thread/turn identities deduplicate monitor/live representations
  and copies on multiple instances. An attributed live turn takes precedence
  over its monitor representation; otherwise the newest copy wins.
- A helper thread's turns roll up into the root thread present in the window,
  following `parentThreadId` transitively. The row states how many helpers it
  includes and what they cost; the inspector marks each helper turn.
- Background helpers (Token Miser, title generation) write one monitor line
  per run: thousands a week, each worth a fraction of a cent. The owner sums
  the ones contained in the window into one line per parent thread, helper
  kind, model and rollup step, so they count toward the thread they worked
  for and cannot spend the row bound. The rollup step is the chart's bar
  width capped at an hour, on epoch boundaries, so a rollup never straddles a
  bar in any whole-hour time zone. The line id is derived from the window,
  so two owners sharing one ledger return the same rollup and it counts once.
- Each owner reads its own PwrAgent SQLite ledger. The read returns at most
  5,000 recent candidate rows for windows up to 31 days. Four owner reads may
  run concurrently. Capped results, unavailable peers and older peers lacking
  the RPC are reported as partial coverage. Remote reads use the existing
  `thread_detail` capability. Titles are fetched for the bounded result
  through the search-document identity index.

## Account limits

- When a Codex turn completes, its owner stamps the account's current limit
  reading on the turn's ledger row (`rate_limit_snapshot`). It rides the same
  completion `UPDATE` and commit, so it adds no write; the
  `completed-turn-usage-limit-reading` budget pins that. A reading holds each
  limit's used percent, used and limit amounts when stated, reset time and
  window length, plus the plan type and a hashed account key. No email or
  account identity leaves the owner.
- A read returns the owner's current reading and the distinct readings stamped
  on the window's turns. Together they form an observed history. Readings are
  account-wide: they include usage outside PwrAgent and are never split among
  threads.
- Owners reporting the same account key are merged into one account. Different
  accounts are never blended. An owner without a key stays on its own.
- A drop of more than one point between readings is a reset. It is
  **scheduled** when the earlier reading's reset time had passed, and
  **unexpected** otherwise, as when the provider or the operator restarts a
  limit early. An unexpected reset is placed at the reading where it was first
  seen and restarts the window from there.
- Pace is the current percent divided by the hours since the window began.
  With no known start, it is the slope across readings at least 30 minutes
  apart. The projection states the percent expected at the next reset, or,
  as a warning, when the limit would reach 100% and how long before the reset
  that is.
- Pay-per-token accounts report an **Individual limit** of credits used out of
  a limit, resetting at month end, plus a **Credits** row. Both are shown as
  reported.

## Chart and ranking

The chart stacks each completed turn's API-equivalent cost at its completion
time, by **Thread**, **Model**, **Provider** (OpenAI, xAI, …) or, with more
than one instance read, **Instance**. Bars are clock steps (15 or 30 minutes, 1, 2, 3, 6 or 12 hours, or a
day), the finest that keeps the window within 40 bars, starting on local
quarter hours, hours or midnight; only the first and last bar can be partial,
and a bar's width is its span. The readout and time filter name a bar by its
hours ("3 PM–4 PM"), with the day when it is not today. The five costliest threads each keep one color across the
chart, the ranking's swatch and its **When** strip; everything else is
**Other**. A legend entry opens its thread in the main window, on the instance
that owns it, as does **Open thread** in the inspector. The focused account's observed limit is drawn over the bars on its
own percent axis, broken at each reset, and resets are marked. On **Since
reset** and **5-hour window** the chart continues past **Now** toward the
reset with the pace as a dashed line, marking 100% where it gets there first.
The future takes at most 40% of the width, so the bars stay selectable; an
outcome beyond that edge is labelled at the edge. Clock periods show history
only. Bars are not
estimates of spend rate within a bucket. Selecting a bar filters the ranking
while the totals keep the full window. With Model, Provider or Instance chosen,
a legend entry narrows the ranking to that model, provider or instance's spend
instead of opening a thread. The grip under the ranking drags it taller or
shorter; the height is kept in this machine's local storage, never synced, and
a double-click returns it to filling the window.

Rows carry signals when the ledger observed them: cold replays (a warning at
three or more), peak context share (noted at 75%, a warning at 90%), fast mode
and included helpers. Unavailable instances are summed up in one line: peers running a
PwrAgent from before usage activity, offline peers, and owners that hit the
row bound. The raw errors sit under **Details**. Dismissing the line hides it
until a different set of instances is missing. Search and cost/token/time sorting operate on the loaded
snapshot and do not request more data or invoke analysis.

## Analysis

Selecting a thread opens its turns in the window. Once a turn has been
analyzed, the inspector splits into **Details** (the turns) and **Analysis**
(the answer, then the settings to run it again), and moves to Analysis when
the answer lands. **Analyze turn** makes one
explicit model call on the turn's owner, defaulting to GPT-6-Luna. It pages
back through thread history for that turn, at most five pages of ten turns.
If the turn is out of reach it reads the recent entries instead, and the
result says so. **Recent entries** reads the newest page only. Entries are then
trimmed to the operator's 1–100 entry and 1,000–40,000 character bounds.

Remote analysis requires `turn_control`; transcript-read permission alone
cannot start this model call. The owner supplies its available Codex model
choices. Analysis runs on Codex only: ACP agents such as Grok have no one-shot
structured call yet, though a Grok thread's transcript can be analyzed by a
Codex model. Only text and activity descriptions enter the prompt. Images,
full-history walks, automatic analysis fanout and Codex storage-file reads are
excluded. While it runs, the inspector shows the owner, the model and the
elapsed time; the thread list stays usable, and only a second analysis waits.
The answer, or the failure, stays with the thread and turn it read, and the
inspector scrolls to it when it arrives. The existing ephemeral structured helper disables execution,
delegation, web search and configured MCP tools. Analysis consumes model usage
from the owner's limit, reports unavailable transcripts/providers, and does not
persist its answer.

Validation covers ledger reads with zero SQLite commits, the limit reading's
zero added commits, timing boundaries, cumulative and monitor deduplication,
token subsets, helper rollup, reset detection and pace, missing peers,
turn-scoped paging and its fallback, owner-routed analysis, and server-side
prompt limits. Browser rendering uses contrived data; automated tests do not
invoke a real model.
