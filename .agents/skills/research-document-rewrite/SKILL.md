---
name: research-document-rewrite
description: Drive a live PwrAgent native Research run (typically in `PWRAGENT_PROFILE=dev`) to evaluate the writing quality of a `.tex` or `.pdf` document, coordinate parallel workers to audit and rewrite it into a new file in an isolated worktree without modifying canonical drafts, capture lifecycle screenshots of the Research tracker, and verify before/after quality metrics. Use when repeating an end-to-end live Research test on a paper, manuscript, specification, or technical document.
---

# Research Document Evaluation and Rewrite

Use this skill to run a repeatable, end-to-end live test of PwrAgent's native **Research** feature on any `.tex` or `.pdf` document. A coordinating thread splits writing-quality evaluation and rewriting across parallel PwrAgent workers, reviews and revises candidate submissions, synthesizes a verified rewrite in an isolated worktree, and leaves canonical source files untouched.

## Guardrails

- **Use real native Research runs, not ad-hoc subagents.** A native Research run must start from a bound operator `intentId` created in the **Research** panel (`PwrAgent workers` → `Request research`) so `research_start`, `research_read`, `research_update`, worker tracking, and the Research window are actually exercised. Do not substitute `handoff_task` or manual subagent fan-out.
- **Never edit canonical source files on the project's default branch.** Keep the coordinating thread and workers in isolated worktrees, write the synthesized deliverable to a new path (for example `rewrites/<name>-rewrite.tex` or `rewrites/<name>-rewrite.md`), and verify the canonical checkout stays clean.
- **Use a real model only when the operator asks for a live run.** Live Research runs spend model usage across multiple concurrent workers; confirm the requested model, reasoning effort, max concurrent workers (1–8), and time bounds before starting.
- **Never target generic Electron or kill PIDs directly.** Use `.agents/skills/pwragent-dev-profile/scripts/pwragent-dev-profile.zsh` to start, inspect, or close `PWRAGENT_PROFILE=dev`, and target only the exact checkout-local `appPath` / `rendererUrl` it reports.

## 1. Prepare the Dev Profile and Target Document

1. **Check the target repository and document:**
   - Verify the target project's canonical branch is clean (`git status --short`).
   - Confirm the target `.tex` or `.pdf` path and inspect its size and structure (line/word count or page count, sections, macros/references, and any repo-local style guide or linter).
   - Check available local build/extraction tools (`pdflatex`, `latexmk`, or `tectonic` for `.tex`; `pdfinfo` / `pdftotext` or Python PDF readers for `.pdf`).
2. **Verify `PWRAGENT_PROFILE=dev` and Research enablement:**
   - Check `~/.pwragent/profiles/dev/config.toml` and ensure `research_enabled = true` is set under `[experimental]`.
   - Run `.agents/skills/pwragent-dev-profile/scripts/pwragent-dev-profile.zsh status --root "$PWD"`. Start or restart with `restart --root "$PWD"` if the dev app is not running or if you changed `config.toml`.
   - Confirm the target project is registered in the `dev` profile.

## 2. Create the Coordinating Thread (Before Starting Research)

Create a new thread in the target project on the `dev` instance with:
- The operator's requested backend, model, reasoning effort, and execution mode.
- **Isolated worktree** (`workspaceMode: "new_worktree"`).

Send an initial priming prompt instructing the coordinating thread to:
1. Read the target `.tex` or `.pdf` document (and any repo-local writing rubric, style guide, or mechanical checker) to inventory its sections, length, notation/citations, and baseline build or parse health.
2. Confirm readiness to coordinate up to `N` parallel workers with the operator's bounds (per-worker limit, run limit, and/or total worker time) and write the final rewrite to a new output file in its worktree without touching canonical files on the default branch.
3. **Wait** for the operator's bound Research panel request (`intentId`) before calling `research_start`.

Wait for the coordinator's brief readiness reply before submitting the Research panel form.

## 3. Configure and Launch via the Research Panel

1. Select the coordinating thread in the `dev` PwrAgent window and open the **Research** sidebar panel (flask icon).
2. On the **PwrAgent workers** tab, fill in:
   - **Objective**: State the document path, evaluation goals, rewrite target path, and preservation constraints. Example template:
     > Evaluate the writing quality of `<path-to-doc>` and produce a clearer, tighter, publication-ready rewrite at `<output-path>` in this worktree without modifying canonical files. Audit clarity, structure, flow, conciseness, active voice, notation/citation integrity, and any project style rules; preserve all technical/mathematical/factual meaning; verify the final document builds cleanly (for `.tex`) and report before/after quality metrics.
   - **Workers at once**: Requested concurrency (typically 4–8 depending on document length).
   - **Time limit / Per-worker time limit / Total worker time**: Match the operator's requested bounds (for example, `No limit` on run time and `20` minutes per-worker time limit).
   - **Worker workspaces**: Choose **Isolated worktrees**.
3. **Capture the Setup screenshot** before clicking **Request research** (and optionally a second screenshot right after clicking to show the armed/waiting state).
4. Click **Request research**. Verify the coordinating thread receives the bound `intentId` message and calls `research_start` with structured, non-overlapping approaches.

## 4. Recommended Approach Decomposition (`.tex` or `.pdf`)

Guide or verify that the coordinator partitions the work into disjoint, evidence-backed approaches rather than redundant full-document rewrites:

1. **Baseline & mechanical quality audit** (1 worker):
   - For `.tex`: baseline compile (`pdflatex`/`latexmk`/`tectonic`), warning/overfull/reference audit, macro and label inventory, plus any repo-local prose/terminology/style-guide linter.
   - For `.pdf`: page/section extraction (`pdfinfo`, `pdftotext`, or layout inspection), readability and structure audit, figure/table/caption/reference inventory, and extraction quirks.
2. **Disjoint section rewrites** (2–4 workers):
   - Partition contiguous sections so each worker rewrites a non-overlapping slice, posts findings (`research_update` with `action: "finding"` and workspace-relative evidence paths), and submits a candidate rewrite (`action: "submit"`).
3. **Faithfulness & technical-accuracy verifier** (1 worker):
   - Cross-check claims, equations, definitions, caveats, tables, figures, and citations/cross-references (`\ref`, `\eqref`, `\cite`, section numbers) against the original document so clarity edits never alter meaning.
4. **Structure, framing & reader-flow critic** (1 worker):
   - Review abstract/summary, introduction, transitions, signposting, section ordering, and conclusion for reader comprehension and narrative coherence.
5. **Coordinator review, revision, and synthesis**:
   - The coordinator inspects each candidate (`research_read`), exercises `research_update` with `action: "review"` (`accepted`, `revision_requested` when evidence/rules/faithfulness fall short, or `rejected`), calls `action: "finish"` once accepted candidates cover the work, and synthesizes the final rewrite at `<output-path>`.

## 5. Monitor and Capture Lifecycle Screenshots

Pop out the dedicated **Research window** from the Research panel header so both the full Research tracker and the side panel can be captured cleanly. Capture screenshots at four stages:

1. **Setup**: Research panel configured before clicking **Request research** (and optional waiting/armed shot).
2. **Running**: Active workers in flight, approaches populated, initial findings appearing (both Research window and main window with Research panel).
3. **Towards the end**: Most approaches submitted, review decisions (`accepted` / `revision_requested`) visible, findings accumulated (Research window, review/submissions view, and main panel).
4. **At the end**: Run in `Completed` state with final counts (findings, submissions, accepted) and synthesized output ready.

### macOS Screenshot Note

On macOS, `screencapture -x -l <windowId>` can return a stale backing-store image for an occluded Chromium/Electron window. Briefly raise/activate the target `dev` PwrAgent window right before capturing so Chromium flushes a fresh frame, and always inspect every saved screenshot image before presenting it.

## 6. Post-Run Verification and Reporting

1. **Verify the deliverable:**
   - For `.tex`: compile the rewritten file to PDF in the worktree (for example with `latexmk` or multi-pass `pdflatex`) and record page count, LaTeX error/warning count, and undefined-reference count.
   - For `.pdf` inputs rewritten to `.tex`/`.md`/`.pdf`: verify formatting, section completeness, citation/figure parity, and clean rendering.
   - Re-run any mechanical/readability/style checks used in the baseline audit to produce an objective before/after comparison.
   - Record deliverable path, line/word/page count, and SHA-256 checksum.
2. **Verify canonical repository hygiene:**
   - Run `git status --short` in the canonical target repo checkout and confirm no files on the default branch were modified.
3. **Record run telemetry and product observations:**
   - Report Run ID, status, elapsed duration, model/effort, worker concurrency/bounds, and counts of findings, submissions, revisions requested, and accepted candidates.
   - If the live run exposes any PwrAgent bugs or UX defects (for example stale queued notices, tracker glitches, or review-flow friction), file standalone PwrAgent to-do cards (`add_todo`) instead of leaving them only in the summary.
4. **Dev app cleanup:**
   - Leave `PWRAGENT_PROFILE=dev` running if the operator is still inspecting the run; when closing it, always use:
     ```bash
     .agents/skills/pwragent-dev-profile/scripts/pwragent-dev-profile.zsh close --root "$PWD"
     ```
