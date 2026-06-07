/**
 * PwrAgent live smoke eval — `pnpm eval:smoke`.
 *
 * Launches the REAL app against a throwaway profile + a clone of this repo at a
 * pinned SHA, then drives each available backend (Codex + every installed ACP
 * agent) through a small matrix using the real preload IPC:
 *
 *   1. "What is this project?"  in Default Access  → expect a non-empty answer
 *   2. "Build the project"      in Default Access  → expect ≥1 approval request
 *   3. "Run one unit test"      in Full Access     → expect the turn to complete
 *
 * Prints a pass/fail grid and exits non-zero if the core check (1) fails for any
 * available backend. Real LLMs are non-deterministic, so (2)/(3) are reported
 * but only gate the exit code when EVAL_STRICT=1. Every run also banks raw
 * ACP/Codex transcripts (protocol capture) for the Phase B / KTD-P3 harness.
 *
 * This is LOCAL-ONLY: it needs your installed, authenticated agents + Codex
 * login. It is deliberately NOT part of the CI e2e suite.
 *
 * Useful env knobs:
 *   EVAL_SHA=<commit>          checkout this commit in the clone (default HEAD)
 *   EVAL_BACKENDS=codex,acp:gemini   limit to these backends
 *   EVAL_SCENARIOS=whatis,build,fulltest   limit to these scenarios
 *   EVAL_TURN_TIMEOUT_MS=180000   per-turn timeout
 *   EVAL_STRICT=1              fail the run if any scenario (not just whatis) fails
 *   EVAL_KEEP_TEMP=1           keep the temp profile/clone/captures dirs
 */
import path from "node:path";
import { launchLiveApp } from "./lib/live-app";
import { LiveDriver, type BackendSummary, type ExecutionMode, type BackendKind } from "./lib/driver";
import { UiDriver } from "./lib/ui-driver";

type ScenarioId = "whatis" | "build" | "fulltest";

type Scenario = {
  id: ScenarioId;
  column: string;
  mode: ExecutionMode;
  prompt: string;
  timeoutMs: number;
  /** Classify the turn outcome into a grid cell. */
  grade: (o: {
    status: string;
    answer: string;
    approvals: number;
    error?: string;
  }) => { mark: "pass" | "warn" | "fail"; note: string };
};

const TURN_TIMEOUT = Number(process.env.EVAL_TURN_TIMEOUT_MS ?? 180_000);

const SCENARIOS: Scenario[] = [
  {
    id: "whatis",
    column: "Default · what is this?",
    mode: "default",
    prompt:
      "What is this project? Answer in one short sentence based on the files in the working directory.",
    timeoutMs: TURN_TIMEOUT,
    grade: (o) => {
      if (o.status === "completed" && o.answer.length > 0) {
        return { mark: "pass", note: truncate(o.answer, 48) };
      }
      if (o.status === "completed") return { mark: "fail", note: "empty answer" };
      if (o.status === "timeout") return { mark: "fail", note: "timeout" };
      return { mark: "fail", note: o.error ?? "failed" };
    },
  },
  {
    id: "build",
    column: "Default · build → approval",
    mode: "default",
    prompt:
      "Build this project by running its build command in the terminal. If you need to install dependencies first, do that too.",
    timeoutMs: TURN_TIMEOUT,
    grade: (o) => {
      if (o.approvals > 0) {
        return { mark: "pass", note: `${o.approvals} approval(s)` };
      }
      if (o.status === "failed") return { mark: "fail", note: o.error ?? "failed" };
      if (o.status === "timeout") return { mark: "warn", note: "timeout, no approval" };
      return { mark: "warn", note: "no approval requested" };
    },
  },
  {
    id: "fulltest",
    column: "Full · run one unit test",
    mode: "full-access",
    prompt:
      "Run exactly ONE unit test from this repository (your choice) in the terminal and tell me whether it passed or failed. Do not run the whole suite.",
    timeoutMs: Math.max(TURN_TIMEOUT, 240_000),
    grade: (o) => {
      if (o.status === "completed") return { mark: "pass", note: truncate(o.answer, 40) || "completed" };
      if (o.status === "timeout") return { mark: "fail", note: "timeout" };
      return { mark: "fail", note: o.error ?? "failed" };
    },
  },
];

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

const MARK_GLYPH: Record<string, string> = { pass: "✅", warn: "⚠️ ", fail: "❌", skip: "·" };

async function main(): Promise<void> {
  const wantBackends = (process.env.EVAL_BACKENDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const wantScenarios = (process.env.EVAL_SCENARIOS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as ScenarioId[];
  const scenarios = wantScenarios.length
    ? SCENARIOS.filter((s) => wantScenarios.includes(s.id))
    : SCENARIOS;

  const driveUi = process.env.EVAL_DRIVE_UI === "1";
  console.log(
    `▶ PwrAgent live smoke eval — launching real app… ${driveUi ? "(UI-drive)" : "(IPC-drive)"}`,
  );
  const app = await launchLiveApp({ keepTemp: process.env.EVAL_KEEP_TEMP === "1" });
  console.log(`  profile root : ${app.pwragentHome}`);
  console.log(`  clone (@${app.sha.slice(0, 10)}) : ${app.clonePath}`);
  console.log(`  captures     : ${app.capturesDir}`);

  const driver = new LiveDriver(app.page);
  const ui = new UiDriver(app.page, app.capturesDir);
  const dirLabel = path.basename(app.clonePath);

  /**
   * Create a thread for a cell. In UI-drive mode this drives the composer
   * (open launchpad → assert+select provider → assert+select access mode →
   * type prompt → Start), which BOTH creates the thread and starts the turn,
   * then discovers the new threadId. On any UI failure it screenshots and
   * falls back to IPC creation so the grid still completes. Returns the
   * threadId plus a short tag describing how it was created.
   */
  const createThread = async (
    backend: BackendKind,
    mode: ExecutionMode,
    prompt: string,
  ): Promise<{ threadId: string; tag: string }> => {
    if (driveUi) {
      try {
        const before = new Set(await driver.listThreadIds(backend));
        await ui.openLaunchpad(dirLabel);
        const providerOffered = await ui.selectProvider(backend);
        const modes = await ui.selectAccessMode(mode);
        await ui.typePrompt(prompt);
        await ui.clickStart();
        // Discover the id of the thread the UI just created.
        let threadId: string | undefined;
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          const fresh = (await driver.listThreadIds(backend)).find((id) => !before.has(id));
          if (fresh) {
            threadId = fresh;
            break;
          }
          await app.page.waitForTimeout(500);
        }
        if (!threadId) {
          throw new Error("could not discover UI-created threadId via listThreads");
        }
        console.log(
          `    ↳ UI: provider ${providerOffered ? "✓" : "(fixed)"}, modes [${modes.join(", ")}]`,
        );
        return { threadId, tag: "UI" };
      } catch (uiErr) {
        const msg = uiErr instanceof Error ? uiErr.message : String(uiErr);
        console.error(`    ✖ UI drive failed (${msg}); falling back to IPC`);
        await ui.screenshot(`ui-fallback-${backend.replace(/[:]/g, "_")}-${mode}`);
      }
    }
    // IPC path (default, or UI fallback).
    const threadId = await driver.startThread(backend, app.clonePath, mode);
    await driver.setExecutionMode(backend, threadId, mode).catch(() => undefined);
    await app.focusThread(backend, threadId);
    await driver.startTurn(backend, threadId, prompt, mode);
    return { threadId, tag: driveUi ? "IPC(fallback)" : "IPC" };
  };

  // Cells keyed `${backend}::${scenarioId}` → graded result.
  const cells = new Map<string, { mark: string; note: string }>();
  let coreFailures = 0;
  let strictFailures = 0;
  const strict = process.env.EVAL_STRICT === "1";

  try {
    await driver.waitReady();
    console.log("  bridge ready; discovering backends…");
    await driver.refreshAcpAgents().catch(() => undefined);

    const reg = await driver.registerDirectory(app.clonePath);
    if (!reg.ok) {
      throw new Error(`registerDirectoryFromDisk failed: ${reg.reason} — ${reg.message}`);
    }

    const { backends } = await driver.listBackends();
    let usable = backends.filter(
      (b: BackendSummary) => b.available && (b.capabilities?.createThread ?? true),
    );
    if (wantBackends.length) {
      usable = usable.filter((b) => wantBackends.includes(b.kind));
    }
    usable.sort((a, b) => (a.kind === "codex" ? -1 : b.kind === "codex" ? 1 : a.kind.localeCompare(b.kind)));

    const unavailable = backends.filter((b) => !b.available);
    console.log(
      `  usable backends: ${usable.map((b) => b.kind).join(", ") || "(none)"}`,
    );
    if (unavailable.length) {
      console.log(
        `  unavailable    : ${unavailable
          .map((b) => `${b.kind}${b.unavailableReason ? ` (${b.unavailableReason})` : ""}`)
          .join(", ")}`,
      );
    }
    if (!usable.length) {
      throw new Error(
        "No usable backends. Are your agents installed/authenticated and Codex logged in?",
      );
    }

    for (const backend of usable) {
      console.log(`\n── ${backend.label} [${backend.kind}] ──`);
      for (const sc of scenarios) {
        const key = `${backend.kind}::${sc.id}`;
        process.stdout.write(`  • ${sc.column} … `);
        // Track the step so a thrown error names exactly what failed.
        let step = "createThread";
        try {
          const created = await createThread(backend.kind, sc.mode, sc.prompt);
          step = "waitForTurn";
          const outcome = await driver.waitForTurn(backend.kind, created.threadId, undefined, {
            timeoutMs: sc.timeoutMs,
            onLog: (m) => console.log(m),
          });
          const graded = sc.grade(outcome);
          // Tag how the thread was created so the grid shows UI vs IPC/fallback.
          const tagged = { ...graded, note: `[${created.tag}] ${graded.note}` };
          cells.set(key, tagged);
          console.log(`${MARK_GLYPH[graded.mark]} ${tagged.note}`);
          // Surface diagnostics whenever the cell isn't a clean pass so the
          // reason is visible (e.g. why codex requested no approval, or what a
          // failed/timed-out turn actually did).
          if (graded.mark !== "pass") {
            console.log(
              `    ↳ status=${outcome.status} approvals=${outcome.approvals}` +
                (outcome.error ? ` error=${outcome.error}` : ""),
            );
            if (outcome.methods.length) {
              console.log(
                `    ↳ methods: ${[...new Set(outcome.methods)].join(", ")}`,
              );
            }
          }
          if (sc.id === "whatis" && graded.mark === "fail") coreFailures += 1;
          if (graded.mark === "fail") strictFailures += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const note = `${step}: ${message}`;
          cells.set(key, { mark: "fail", note: truncate(note, 48) });
          console.log(`${MARK_GLYPH.fail} ${truncate(note, 48)}`);
          // Full, untruncated error so IPC rejections (e.g. an unsupported
          // mode for a backend) are actually diagnosable.
          console.error(
            `    ✖ ${step} threw for ${backend.kind} / ${sc.id}:\n      ${
              err instanceof Error ? (err.stack ?? err.message) : String(err)
            }`,
          );
          if (sc.id === "whatis") coreFailures += 1;
          strictFailures += 1;
        }
      }
    }

    printGrid(usable.map((b) => b.kind), scenarios, cells);
  } finally {
    await app.cleanup();
  }

  console.log(`\nTranscripts (for KTD-P3 replay): ${app.capturesDir}`);
  if (process.env.EVAL_KEEP_TEMP === "1") {
    console.log("(EVAL_KEEP_TEMP=1 — temp dirs preserved)");
  }

  const failed = strict ? strictFailures > 0 : coreFailures > 0;
  console.log(
    failed
      ? `\n✖ FAIL — ${strict ? `${strictFailures} scenario failure(s)` : `${coreFailures} backend(s) couldn't answer "what is this project?"`}`
      : "\n✔ PASS — core checks green",
  );
  process.exit(failed ? 1 : 0);
}

function printGrid(
  backendKinds: string[],
  scenarios: Scenario[],
  cells: Map<string, { mark: string; note: string }>,
): void {
  console.log("\n┌─ Results ────────────────────────────────────────────");
  const backendWidth = Math.max(8, ...backendKinds.map((k) => k.length));
  for (const sc of scenarios) {
    console.log(`│ ${sc.column}`);
    for (const kind of backendKinds) {
      const cell = cells.get(`${kind}::${sc.id}`) ?? { mark: "skip", note: "—" };
      console.log(
        `│   ${kind.padEnd(backendWidth)}  ${MARK_GLYPH[cell.mark] ?? "·"}  ${cell.note}`,
      );
    }
  }
  console.log("└──────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("\n✖ smoke eval crashed:", err);
  process.exit(2);
});
