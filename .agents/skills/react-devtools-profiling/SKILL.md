---
name: react-devtools-profiling
description: Profile the PwrAgent Electron renderer with standalone React DevTools and Computer Use. Use for investigating navigation render storms, component render reasons, or comparing controlled UI recordings; not for general CPU or memory profiling.
---

# React DevTools Profiling

Use real UI interactions to connect a reproducible navigation symptom to React
commits and component render reasons. Profiling does not authorize product fixes.

## Setup and target identity

Read [Profiling the Renderer with React DevTools](../../../apps/desktop/AGENTS.md#profiling-the-renderer-with-react-devtools)
for current setup, build modes, connection diagnostics, and packaging constraints.
[electron.vite.config.ts](../../../apps/desktop/electron.vite.config.ts) is the
implementation source of truth. Use the standalone frontend; do not install it
as a repository dependency or recreate the documented bridge setup.

Use [pwragent-dev-profile](../pwragent-dev-profile/SKILL.md) to manage the app in
the assigned checkout. Start the standalone bridge before restarting the app
with `PWRAGENT_DEV_REACT_DEVTOOLS=1`. Verify its actual displayed/listening
endpoint and match the app's host/port variables to it. Do not trust an accepted
CLI flag alone: one observed standalone 7.0.1 installation invoked with
`--port 8098` still displayed and listened on 8097. Treat that as a diagnostic
example, not a universal flag contract. Do not take over another profiling
session's endpoint or operate a dev app another agent is currently exploring.

Select the exact checkout-local `appPath` emitted as the dev-profile script's
Computer Use target. Verify the `PwrAgent` window and its AX URL against the
emitted `rendererUrl`; a generic Electron name or bundle ID is ambiguous.
Confirm the renderer console's bridge line names the intended checkout and
endpoint. Identify the standalone React DevTools window separately. If the
target cannot be verified, resolve that before recording. Auxiliary PwrAgent
windows can replace the bridge connection; recheck attachment after opening one.

Use the development build first for named prop/hook attribution and render
counts. Development durations are not production costs, and uneven overhead
makes duration rankings unreliable. When timing is explicitly needed, follow
the source document's production profiling build procedure and label the build,
instrumentation, machine, and scenario in results. Do not ship a bridged or
profiling build.

## Record through Computer Use

Use the available Computer Use tool's documented native app operations. Inspect
fresh UI state before selecting controls: AX element IDs can change after
navigation, HMR, or a dialog. Use current screenshots when AX does not expose a
control; do not carry coordinates or element IDs across changed layouts.

In standalone DevTools, open settings, select **Profiler**, and enable
**Record why each component rendered** before starting the recording. Confirm
the Profiler is connected to the intended renderer. After a short recording,
select a commit and component to verify render reasons were captured; an export
without attribution cannot establish callback-only amplification.

Define the starting lens, selected thread, expanded directories, sidebar state,
window size, scroll position, and relevant data/loading state. Record the
checkout commit, build mode, React/DevTools versions, and interaction count.
Use fixture data where practical. On an operator profile, preserve drafts and
content: do not type into the composer, submit messages, rename/archive threads,
or change data to manufacture a scenario. Thread selection may mark a thread
read; account for that transition when comparing repeats.

Warm up the route and allow initial loading to settle unless cold loading is
the scenario under investigation. Start recording, perform a bounded sequence,
allow its updates to settle, then stop before inspecting the profile. Keep
unrelated exploration outside the recording. If the operator intervenes, HMR
fires, or attachment changes, mark the run contaminated and repeat from the
defined start once control is available; do not silently include it in a pair.

Choose scenarios that exercise the reported symptom, keeping distinct actions
in separate recordings when attribution would otherwise be ambiguous:

| Scenario | Repeatable sequence and observations |
| --- | --- |
| Scroll a list | Scroll the same container down and back over the same range with a recorded number of gestures. Distinguish newly mounted virtualized rows from updates to already visible rows; note loading and measurement changes. |
| Select threads | Select a fixed sequence and return to the start. Separate selection/read-state updates, content loading, and context changes from renders of unrelated cards. |
| Expand/collapse directories | Toggle the same directories the same number of times. Separate child mounts/unmounts from retained rows re-rendering. |
| Change lenses | Follow a fixed lens sequence and return. Record expected changes in membership, counts, and selection; a lens switch need not preserve the same component instances. |
| Hide/show the sidebar | Repeat a fixed number of toggles. Scope conclusions to those toggles; they do not establish behavior for scrolling, thread selection, or directory expansion. |
| Card-height transients | Observe the affected card during selection, expansion, or scrolling, then after settling. Note clipping, jumps, and height recovery with the action/commit sequence. If necessary, use a separate visual run to capture the transient without adding inspection actions to the profile. |

## Attribute and compare

Inspect commit flamegraphs/ranked views and **why rendered** details for the
affected components and their parents. Record renders per component, commits
per interaction, and the named changed props, hooks, or context. Count mounts
separately from updates and use the same counting method in comparison runs.
Avoid double-counting nested component durations as independent work.

Separate these cases before suggesting an optimization:

- Necessary data/state/context updates: selection, visible membership, loading,
  counts, and layout measurements may legitimately change. Verify what consumers
  use; a context change can also be broader than necessary.
- Callback-only amplification: render reasons show only function-valued props
  changing while relevant data stays stable. Check the current source to confirm
  the props are callbacks and trace identity changes through the parent. Report
  missing or ambiguous attribution as uncertainty, not proof.
- Mounts and parent-driven updates: virtualization, keys, and conditional UI
  can replace instances. An absent render reason or changed hook index alone
  does not prove a callback problem; inspect ownership and the corresponding
  source before assigning a cause.

For an authorized before/after comparison, repeat the same sequence, counts,
starting state, build mode, and viewport at both revisions. Reverify the target
after each restart. Keep data churn or different loading states visible as
limitations. Report exact scope and counts, not extrapolated improvements to
unmeasured navigation. A card-height defect needs visual evidence as well as
React attribution: fewer commits alone do not prove layout stability, and a
React profile alone does not measure browser layout/paint cost.

## Export and report

Export each recording through DevTools to an ignored checkout-local `.local/`
directory with distinct scenario/revision filenames. In the native Save dialog,
navigate to the destination folder, then enter only the filename in **Save As**.
An absolute path typed into that field has produced a colon-containing filename
in Downloads. Verify the actual saved path, nonempty file, and parseable profile
before relying on it; preserve the original export privately.

Treat exports, screenshots, component props, paths, and thread titles as operator
data. Do not commit or attach raw captures. Sanitized numerical findings may
enter a PR; show any non-contrived screenshot to the operator and obtain approval
before attaching it under the repository's screenshot policy.

Report the scenario, build/target identity, interaction count, relevant render
counts and reasons, visual observations, and remaining uncertainty. Link private
artifacts locally when useful. Restore navigation where practical without
overwriting operator changes, and stop only profiling processes this task owns,
using the dev-profile skill for app shutdown when needed.
