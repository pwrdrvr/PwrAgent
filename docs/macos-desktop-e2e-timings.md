# macOS Desktop E2E timing study

Measurements use GitHub-hosted `macos-26` VMs. The job retains its 15-minute limit, one Playwright worker, existing retry policy, four lanes, `9:12:12:14` shard weights, software rendering, and shutdown circuit.

## Same-run Spotlight A/B

[Experiment run 41769106839](https://github.com/pwrdrvr/PwrAgent/actions/runs/41769106839) ran three baseline and three indexing-disabled lane 4 jobs at commit `1be6898ddf3b84078964e2d711ab642b67f7d49f`. Each used a separate fresh VM with 3 CPUs and 7 GiB RAM, the same dependency cache, build, tests, and production settings. Indexing was disabled before checkout with `sudo mdutil -a -i off`. All six jobs collected 94 tests (91 executable and 3 platform skips).

| Treatment / sample | Job total | Setup | Build / discovery | Completed test time | Initial / pre-test load (1 min) | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| [Baseline / 1](https://github.com/pwrdrvr/PwrAgent/actions/runs/41769106839/job/126374357351) | 9:21 | 1:25 | 0:33 | 7:07 | 40.86 / 18.17 | 91 passed, 3 skipped |
| [Disabled / 1](https://github.com/pwrdrvr/PwrAgent/actions/runs/41769106839/job/126374356962) | 8:17 | 1:09 | 0:24 | 6:32 | 16.58 / 7.81 | 91 passed, 3 skipped |
| [Baseline / 2](https://github.com/pwrdrvr/PwrAgent/actions/runs/41769106839/job/126374357210) | 13:44 | 2:09 | 0:57 | 10:21 | 51.49 / 12.38 | 90 passed, 1 flaky, 3 skipped |
| [Disabled / 2](https://github.com/pwrdrvr/PwrAgent/actions/runs/41769106839/job/126374357357) | 8:06 | 1:11 | 0:40 | 6:05 | 8.75 / 5.67 | 91 passed, 3 skipped |
| [Baseline / 3](https://github.com/pwrdrvr/PwrAgent/actions/runs/41769106839/job/126374357257) | 10:05 | 1:13 | 0:33 | 8:02 | 21.40 / 9.86 | 91 passed, 3 skipped |
| [Disabled / 3](https://github.com/pwrdrvr/PwrAgent/actions/runs/41769106839/job/126374357283) | 9:45 | 1:20 | 0:29 | 7:41 | 38.71 / 12.76 | 90 passed, 1 flaky, 3 skipped |

| Median | Baseline | Indexing disabled | Change |
| --- | ---: | ---: | ---: |
| Total job | 10:05 | 8:17 | -17.9% |
| Setup | 1:25 | 1:11 | -16.5% |
| Build / discovery | 0:33 | 0:29 | -12.0% |
| Completed tests | 8:02 | 6:32 | -18.7% |

Spotlight processes were still present among the highest-CPU processes immediately before tests in every baseline sample (12, 6, and 9 processes in samples 1–3). All disabled samples had none in that snapshot, and `mdutil -a -s` confirmed indexing disabled. The measured fix disables indexing before checkout in the production macOS E2E job.

These are independent fresh VMs in one workflow, not paired measurements on the same VM. Initial load varied and duration ranges overlap; disabling indexing removes an observed competitor without eliminating host variance. The existing retry policy was exercised by `star-map-late-federation-health.spec.ts:37` in baseline sample 2 and `sidebar-hover-user-actions.spec.ts:183` in disabled sample 3. Their retry costs remain in the table.

| Lane 4 spec | Baseline median seconds | Disabled median seconds |
| --- | ---: | ---: |
| `sidebar-hover-user-actions.spec.ts` | 32.6 | 29.4 |
| `skill-autocomplete-interactions.spec.ts` | 31.6 | 24.9 |
| `thread-open-scroll-stability.spec.ts` | 31.4 | 29.3 |
| `thread-branch-drift.spec.ts` | 29.1 | 23.6 |
| `update-check.spec.ts` | 29.1 | 27.3 |
| `thread-image-fit.spec.ts` | 28.6 | 23.0 |
| `settings-rendering-diagnostics.spec.ts` | 21.7 | 22.0 |
| `workspace-handoff-flows.spec.ts` | 21.3 | 23.0 |
| `thread-title-reveal.spec.ts` | 21.0 | 16.1 |
| `thread-archive-shortcut.spec.ts` | 14.3 | 8.2 |

The baseline four-lane CI run at the same commit, [41769106845](https://github.com/pwrdrvr/PwrAgent/actions/runs/41769106845), finished in **7:49 / 6:40 / 10:34 / 8:42** for lanes 1–4.

## Before: job duration across runs

| Commit / CI run | Lane 1 | Lane 2 | Lane 3 | Lane 4 |
| --- | ---: | ---: | ---: | ---: |
| [0158b5eec](https://github.com/pwrdrvr/PwrAgent/actions/runs/41713710197) | 8:17 | 9:04 | 11:38 | 15:13 (cancelled) |
| [PR #3237](https://github.com/pwrdrvr/PwrAgent/actions/runs/41736725228) | 9:28 | 8:03 | 11:20 | 15:14 (cancelled) |
| [44ebb1978](https://github.com/pwrdrvr/PwrAgent/actions/runs/41751769597) | 8:28 | 8:00 | 9:52 | 10:47 |
| [d647e3f54](https://github.com/pwrdrvr/PwrAgent/actions/runs/41753436838) | 4:53 | 8:00 | 2:12 (failed) | 10:02 |
| [49ee877c2](https://github.com/pwrdrvr/PwrAgent/actions/runs/41756248552) | 7:40 | 7:53 | 11:48 | 6:25 |
| [6832a1421](https://github.com/pwrdrvr/PwrAgent/actions/runs/41756941895) | 7:26 | 7:39 | 8:44 | 9:44 |
| [78f5f564b](https://github.com/pwrdrvr/PwrAgent/actions/runs/41758428307) | 7:56 | 6:26 | 8:42 | 6:15 |
| [9495d3ad6](https://github.com/pwrdrvr/PwrAgent/actions/runs/41758957017) | 7:43 | 9:30 | 7:09 | 9:45 |
| [35e9bcaa9](https://github.com/pwrdrvr/PwrAgent/actions/runs/41759033869) | 5:13 | 5:47 | 11:23 | 8:29 |

## Setup, build, and tests

The latest baseline run separates into these phases. Test duration is the sum of displayed Playwright result durations; build includes test discovery up to `Running N tests`. The difference from total duration covers global setup/teardown, reporting, artifact upload, and rounding.

| Run / lane | Total job | Setup | Build / discovery | Completed test time |
| --- | ---: | ---: | ---: | ---: |
| [41759033869 / 1](https://github.com/pwrdrvr/PwrAgent/actions/runs/41759033869/job/126342144547) | 5:13 | 0:47 | 0:23 | 3:54 |
| [41759033869 / 2](https://github.com/pwrdrvr/PwrAgent/actions/runs/41759033869/job/126342144525) | 5:47 | 0:54 | 0:25 | 4:18 |
| [41759033869 / 3](https://github.com/pwrdrvr/PwrAgent/actions/runs/41759033869/job/126342144479) | 11:23 | 1:10 | 0:36 | 9:19 |
| [41759033869 / 4](https://github.com/pwrdrvr/PwrAgent/actions/runs/41759033869/job/126342144569) | 8:29 | 1:06 | 0:30 | 6:41 |
| [41736725228 / 4](https://github.com/pwrdrvr/PwrAgent/actions/runs/41736725228/job/126267899094) | 15:14 | 1:24 | 0:51 | 12:38 |
| [41713710197 / 4](https://github.com/pwrdrvr/PwrAgent/actions/runs/41713710197/job/126188453645) | 15:13 | 1:59 | 1:20 | 11:31 |

The seven recent main runs have median completed test times of **5:51**, **6:08**, **7:29**, **7:40** for lanes 1–4. The failed lane 3 is excluded from medians. Lane 4 collected 94 tests, compared with 62, 85, and 79 in the other lanes. Counts include platform-skipped tests because Playwright includes them when allocating shards.

## Per-spec durations by lane

These are medians of completed spec totals from the seven main runs above, excluding failed/cancelled lanes. Durations are seconds. The same spec can span lanes when its tests use parallel grouping; each entry measures only that lane’s assigned tests. Specs skipped on macOS have no completed duration and are omitted.

<details>
<summary>All measured spec durations</summary>

| Lane | Spec | Median seconds | Samples |
| --- | --- | ---: | ---: |
| 1 | `a11y.spec.ts` | 351.2 | 7 |
| 2 | `a11y.spec.ts` | 38.0 | 7 |
| 2 | `acp-runtime-modes.spec.ts` | 21.9 | 7 |
| 2 | `app-quit-lifecycle.spec.ts` | 9.1 | 7 |
| 2 | `appearance-broadcast.spec.ts` | 2.9 | 7 |
| 2 | `approval-notice-title.spec.ts` | 3.0 | 7 |
| 2 | `approval-pending.spec.ts` | 8.9 | 7 |
| 2 | `assistant-image-previews.spec.ts` | 4.7 | 7 |
| 2 | `async-question.spec.ts` | 3.3 | 7 |
| 2 | `codex-environment-setup.spec.ts` | 36.3 | 7 |
| 2 | `composer-chip-alignment.spec.ts` | 3.7 | 7 |
| 2 | `composer-draft-persistence-regression.spec.ts` | 17.6 | 7 |
| 2 | `composer-draft-settings.spec.ts` | 3.0 | 7 |
| 2 | `composer-hash-reference-search.spec.ts` | 3.8 | 7 |
| 2 | `composer-height-growth.spec.ts` | 3.6 | 7 |
| 2 | `composer-image-normalization.spec.ts` | 7.2 | 7 |
| 2 | `composer-image-thread-switch.spec.ts` | 17.1 | 7 |
| 2 | `composer-markdown-paste.spec.ts` | 41.2 | 7 |
| 2 | `context-rail-linked-directory-tooltips.spec.ts` | 3.3 | 7 |
| 2 | `directories-pin-drag-reorder.spec.ts` | 4.3 | 7 |
| 2 | `directory-launchpad-skills.spec.ts` | 59.5 | 7 |
| 2 | `directory-launchpad-transcript-sync.spec.ts` | 4.4 | 7 |
| 2 | `directory-launchpad-workspace.spec.ts` | 61.2 | 7 |
| 3 | `edited-changes-order.spec.ts` | 7.7 | 6 |
| 3 | `electron-fixture-isolation.spec.ts` | 9.8 | 6 |
| 3 | `execution-mode-routing.spec.ts` | 5.1 | 6 |
| 3 | `federation-activity.spec.ts` | 20.1 | 6 |
| 3 | `federation-remote-window.spec.ts` | 98.8 | 6 |
| 3 | `federation-services.spec.ts` | 6.6 | 6 |
| 3 | `focused-diff-zoom.spec.ts` | 7.7 | 6 |
| 3 | `html-file-preview.spec.ts` | 3.9 | 6 |
| 3 | `integrated-terminal.spec.ts` | 19.1 | 6 |
| 3 | `launchpad-composer-bounds.spec.ts` | 3.7 | 6 |
| 3 | `live-agent-messages.spec.ts` | 7.9 | 6 |
| 3 | `live-work-rail-sticky-gap.spec.ts` | 3.0 | 6 |
| 3 | `live-work-rail-toggle.spec.ts` | 3.0 | 6 |
| 3 | `macos-window-activation.spec.ts` | 16.2 | 6 |
| 3 | `managed-review.spec.ts` | 3.4 | 6 |
| 3 | `markdown-findings-table.spec.ts` | 4.0 | 6 |
| 3 | `mcp-elicitation.spec.ts` | 26.4 | 6 |
| 3 | `navigation-resume.spec.ts` | 7.3 | 6 |
| 3 | `new-thread-transcript-sync.spec.ts` | 10.3 | 6 |
| 3 | `onboarding-wizard.spec.ts` | 49.9 | 6 |
| 3 | `plan-autocomplete-order.spec.ts` | 3.0 | 6 |
| 3 | `provider-model-selectors.spec.ts` | 4.8 | 6 |
| 3 | `queued-review-release.spec.ts` | 6.7 | 6 |
| 3 | `quit-confirmation-dialog.spec.ts` | 14.1 | 6 |
| 3 | `renderer-recovery.spec.ts` | 13.6 | 6 |
| 3 | `rendering-diagnostics.spec.ts` | 77.7 | 6 |
| 3 | `request-user-input.spec.ts` | 6.7 | 6 |
| 3 | `review-command-flow.spec.ts` | 3.0 | 6 |
| 3 | `review-multiple-findings.spec.ts` | 2.8 | 6 |
| 3 | `review-output-rendering.spec.ts` | 6.0 | 6 |
| 4 | `review-tracking.spec.ts` | 8.1 | 7 |
| 4 | `sandboxer-hosted-setup.spec.ts` | 5.7 | 7 |
| 4 | `settings-rendering-diagnostics.spec.ts` | 20.5 | 7 |
| 4 | `sidebar-hover-user-actions.spec.ts` | 33.8 | 7 |
| 4 | `sidebar-resize-seam.spec.ts` | 3.8 | 7 |
| 4 | `skill-autocomplete-interactions.spec.ts` | 23.4 | 7 |
| 4 | `smoke.spec.ts` | 7.4 | 7 |
| 4 | `source-link-editor-open.spec.ts` | 3.2 | 7 |
| 4 | `stale-thinking-indicator.spec.ts` | 2.6 | 7 |
| 4 | `star-map-chat-card-history.spec.ts` | 5.8 | 7 |
| 4 | `star-map-composer-attachments.spec.ts` | 12.1 | 7 |
| 4 | `star-map-late-federation-health.spec.ts` | 10.1 | 7 |
| 4 | `star-map-project-pagination.spec.ts` | 5.4 | 7 |
| 4 | `star-map-thread-flow.spec.ts` | 11.6 | 7 |
| 4 | `tangerine-terminal-theme.spec.ts` | 10.2 | 7 |
| 4 | `thinking-scanner-sync.spec.ts` | 4.0 | 7 |
| 4 | `thread-archive-history.spec.ts` | 4.6 | 7 |
| 4 | `thread-archive-shortcut.spec.ts` | 11.7 | 7 |
| 4 | `thread-archive-worktree-cleanup.spec.ts` | 10.2 | 7 |
| 4 | `thread-branch-drift.spec.ts` | 22.6 | 7 |
| 4 | `thread-image-fit.spec.ts` | 24.5 | 7 |
| 4 | `thread-markdown-edge-cases.spec.ts` | 3.8 | 7 |
| 4 | `thread-markdown.spec.ts` | 7.5 | 7 |
| 4 | `thread-open-scroll-stability.spec.ts` | 28.7 | 7 |
| 4 | `thread-pending-wakes.spec.ts` | 3.1 | 7 |
| 4 | `thread-pricing-panel.spec.ts` | 2.8 | 7 |
| 4 | `thread-row-status.spec.ts` | 3.8 | 7 |
| 4 | `thread-title-generation.spec.ts` | 2.7 | 7 |
| 4 | `thread-title-reveal.spec.ts` | 15.7 | 7 |
| 4 | `thread-unread-regression.spec.ts` | 3.0 | 7 |
| 4 | `todo-dispatch-model.spec.ts` | 7.7 | 7 |
| 4 | `todo-list-rendering.spec.ts` | 6.0 | 7 |
| 4 | `todo-prompt-markdown.spec.ts` | 3.7 | 7 |
| 4 | `tooltip-layout-budget.spec.ts` | 6.4 | 7 |
| 4 | `transcript-activity-order.spec.ts` | 2.9 | 7 |
| 4 | `transcript-command-output.spec.ts` | 2.9 | 7 |
| 4 | `transcript-focus-ring.spec.ts` | 2.5 | 7 |
| 4 | `transcript-message-alignment.spec.ts` | 3.2 | 7 |
| 4 | `transcript-temporal-order.spec.ts` | 2.9 | 7 |
| 4 | `turn-lifecycle.spec.ts` | 11.8 | 7 |
| 4 | `update-check.spec.ts` | 27.3 | 7 |
| 4 | `visual-regression.spec.ts` | 8.2 | 7 |
| 4 | `workspace-handoff-dialog.spec.ts` | 5.6 | 7 |
| 4 | `workspace-handoff-flows.spec.ts` | 18.0 | 7 |

</details>

## Measurement method

- Fetch raw job metadata with `gh api repos/pwrdrvr/PwrAgent/actions/jobs/JOB_ID` and logs with `gh api --allow-escape-sequences repos/pwrdrvr/PwrAgent/actions/jobs/JOB_ID/logs`. Keep raw logs outside the repository.
- Total job time is `completed_at - started_at`; setup ends when `Run desktop replay-backed Electron tests` starts.
- Build/discovery ends at the timestamp of `Running N tests using 1 worker, shard K of 4`.
- Extract the final parenthesized duration from each completed `✓` or `✘` test-result line, group by spec and lane, then take medians across successful lanes. Include retry attempts when present.
- Cancelled jobs provide partial test totals; their unfinished work is not a successful sample.
- The HTML Playwright artifacts retain the full test results and exact millisecond durations for successful jobs. Log-derived durations are rounded by the list reporter.
