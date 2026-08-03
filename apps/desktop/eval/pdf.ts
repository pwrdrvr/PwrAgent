/**
 * Local PDF handling eval — `pnpm eval:pdf`.
 *
 * Each question runs twice through real PwrAgent/Codex on GPT-5.6-Terra high:
 * once as the messaging-compatible `file` input and once as the three rendered
 * page images. The fixture PDFs are intentionally rasterized scans, so the
 * image condition sends the exact page pixels a PDF renderer would produce
 * without making this local-only eval depend on a machine-wide PDF utility.
 *
 * This requires a real Codex login and consumes subscription usage. It is not
 * a CI test and does not change production attachment behavior.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppServerTurnInputItem } from "@pwragent/shared";
import { launchLiveApp } from "./lib/live-app";
import { LiveDriver, type ModelOptions, type TurnOutcome } from "./lib/driver";

type InputCondition = "pdf-file" | "page-images";
type FixtureId = "harbor-gazette" | "roadster-equipment-record";
type CaseId = "heading" | "column" | "ocr" | "roof-state";

type Fixture = {
  id: FixtureId;
  label: string;
  pdfName: string;
  pageNames: string[];
};

type PdfEvalCase = {
  id: CaseId;
  fixture: FixtureId;
  label: string;
  prompt: string;
  required: string[];
  forbidden?: string[];
};

type Grade = {
  passed: boolean;
  earned: number;
  possible: number;
  missing: string[];
  forbidden: string[];
  note: string;
};

type Result = {
  caseId: CaseId;
  fixture: FixtureId;
  condition: InputCondition;
  outcome: TurnOutcome;
  grade: Grade;
  elapsedMs: number;
  commandOutputDeltas: number;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "pdf-fixtures");
const defaultModel: ModelOptions = {
  model: process.env.EVAL_PDF_MODEL?.trim() || "gpt-5.6-terra",
  reasoningEffort: process.env.EVAL_PDF_REASONING_EFFORT?.trim() || "high",
};
const turnTimeoutMs = Number(process.env.EVAL_PDF_TURN_TIMEOUT_MS ?? 300_000);

const FIXTURES: Fixture[] = [
  {
    id: "harbor-gazette",
    label: "Harbor Gazette",
    pdfName: "harbor-gazette.pdf",
    pageNames: [
      "harbor-gazette-page-1.png",
      "harbor-gazette-page-2.png",
      "harbor-gazette-page-3.png",
    ],
  },
  {
    id: "roadster-equipment-record",
    label: "Pioneer Roadster equipment record",
    pdfName: "roadster-equipment-record.pdf",
    pageNames: [
      "roadster-equipment-record-page-1.png",
      "roadster-equipment-record-page-2.png",
      "roadster-equipment-record-page-3.png",
    ],
  },
];

const CASES: PdfEvalCase[] = [
  {
    id: "heading",
    fixture: "harbor-gazette",
    label: "heading-local text",
    prompt:
      'In the attached Harbor Gazette, what exact sentence is directly below the heading "I LIKE CATS, NOT DOGS" on page 1? Reply with exactly one line: UNDER_HEADING: <sentence>. Do not use the neighboring column.',
    required: ["UNDER_HEADING: THE QUIET CHOICE IS A WINDOW LEDGE."],
  },
  {
    id: "column",
    fixture: "harbor-gazette",
    label: "left-column order",
    prompt:
      "On page 2 of the attached Harbor Gazette, list only the three codes in the left column headed FIELD NOTES, in visual top-to-bottom order. Reply with exactly one line: COLUMN_1: <code> | <code> | <code>. Do not include codes from the advertisement column.",
    required: ["COLUMN_1: SABLE-14 | MORROW-62 | VIOLET-08"],
    forbidden: ["CANARY-91", "JUNIPER-31", "EMBER-77"],
  },
  {
    id: "ocr",
    fixture: "harbor-gazette",
    label: "image-only OCR",
    prompt:
      "On page 3 of the attached Harbor Gazette, read the filing code inside the blue IMAGE-ONLY NOTICE panel. Reply with exactly one line: OCR_CODE: <code>. Do not use a code from another page.",
    required: ["OCR_CODE: ORCHID-47"],
  },
  {
    id: "roof-state",
    fixture: "roadster-equipment-record",
    label: "ordered equipment state",
    prompt:
      "Read the entire attached Pioneer Roadster equipment record. Apply the equipment rules in printed order: top-to-bottom in the left column, then top-to-bottom in the right column, then continue to the next page. Does the vehicle have a Soft Top at delivery? Reply with exactly these three lines:\nSOFT_TOP: Yes or No\nFINAL_ROOF: Soft Top or Hard Top\nROOF_RULES: STANDARD_SOFT_TOP > ADD_HARD_TOP > DELETE_SOFT_TOP",
    required: [
      "SOFT_TOP: NO",
      "FINAL_ROOF: HARD TOP",
      "ROOF_RULES: STANDARD_SOFT_TOP > ADD_HARD_TOP > DELETE_SOFT_TOP",
    ],
    forbidden: ["SOFT_TOP: YES", "FINAL_ROOF: SOFT TOP"],
  },
];

function normalize(value: string): string {
  return value.toUpperCase().replace(/\s+/g, " ").trim();
}

function truncate(value: string, length = 120): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function formatDuration(elapsedMs: number): string {
  return `${(elapsedMs / 1000).toFixed(elapsedMs < 10_000 ? 1 : 0)}s`;
}

function fixturePath(name: string): string {
  const result = path.join(fixturesDir, name);
  if (!existsSync(result)) {
    throw new Error(
      `Missing PDF eval fixture ${name}. Regenerate it with python3 apps/desktop/eval/pdf-fixtures/generate.py`,
    );
  }
  return result;
}

function inputFor(
  condition: InputCondition,
  fixture: Fixture,
  prompt: string,
): AppServerTurnInputItem[] {
  const promptInput: AppServerTurnInputItem = { type: "text", text: prompt };
  if (condition === "pdf-file") {
    const filePath = fixturePath(fixture.pdfName);
    return [
      promptInput,
      {
        type: "file",
        name: fixture.pdfName,
        mimeType: "application/pdf",
        data: readFileSync(filePath).toString("base64"),
        sizeBytes: statSync(filePath).size,
      },
    ];
  }

  return [
    promptInput,
    ...fixture.pageNames.map((name) => ({
      type: "image" as const,
      name,
      url: `data:image/png;base64,${readFileSync(fixturePath(name)).toString("base64")}`,
    })),
  ];
}

function grade(caseDef: PdfEvalCase, outcome: TurnOutcome): Grade {
  const possible = caseDef.required.length + (caseDef.forbidden?.length ?? 0);
  if (outcome.status !== "completed") {
    return {
      passed: false,
      earned: 0,
      possible,
      missing: caseDef.required,
      forbidden: [],
      note: outcome.status === "timeout" ? "timeout" : outcome.error ?? "turn failed",
    };
  }

  const answer = normalize(outcome.answer);
  const missing = caseDef.required.filter((marker) => !answer.includes(normalize(marker)));
  const forbidden = (caseDef.forbidden ?? []).filter((marker) => answer.includes(normalize(marker)));
  const earned = possible - missing.length - forbidden.length;
  const passed = missing.length === 0 && forbidden.length === 0;
  const details = [
    ...(missing.length ? [`missing ${missing.join(", ")}`] : []),
    ...(forbidden.length ? [`included ${forbidden.join(", ")}`] : []),
  ];
  return {
    passed,
    earned,
    possible,
    missing,
    forbidden,
    note: details.join("; ") || truncate(outcome.answer, 72) || "matched",
  };
}

function printResult(result: Result): void {
  const mark = result.grade.passed ? "pass" : "fail";
  console.log(
    `  ${result.condition.padEnd(12)} ${mark.padEnd(4)} ` +
      `${String(result.grade.earned).padStart(2)}/${result.grade.possible}  ` +
      `${formatDuration(result.elapsedMs)}; ${result.commandOutputDeltas} command-output event(s); ${result.grade.note}`,
  );
  if (!result.grade.passed && result.outcome.answer) {
    console.log(`    answer: ${truncate(result.outcome.answer, 220)}`);
  }
  if (result.outcome.methods.length) {
    console.log(`    events: ${[...new Set(result.outcome.methods)].join(", ")}`);
  }
}

function selectCases(): PdfEvalCase[] {
  const requested = (process.env.EVAL_PDF_CASES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean) as CaseId[];
  if (requested.length === 0) return CASES;

  const selected = CASES.filter((caseDef) => requested.includes(caseDef.id));
  const unknown = requested.filter((id) => !selected.some((caseDef) => caseDef.id === id));
  if (unknown.length) {
    throw new Error(`Unknown EVAL_PDF_CASES value(s): ${unknown.join(", ")}`);
  }
  return selected;
}

async function main(): Promise<void> {
  const cases = selectCases();
  const fixtures = new Map(FIXTURES.map((fixture) => [fixture.id, fixture]));
  const keepTemp = process.env.EVAL_KEEP_TEMP === "1";
  const strict = process.env.EVAL_PDF_STRICT === "1";
  const requireImageWin = process.env.EVAL_PDF_REQUIRE_IMAGE_WIN === "1";
  const results: Result[] = [];

  console.log("▶ PwrAgent PDF handling eval — launching real Codex app…");
  console.log(`  model        : ${defaultModel.model} (${defaultModel.reasoningEffort})`);
  console.log("  conditions   : PDF file reference vs pre-rendered page images");
  console.log(`  cases        : ${cases.map((caseDef) => caseDef.id).join(", ")}`);

  const app = await launchLiveApp({ keepTemp });
  const resultsPath = path.join(app.capturesDir, "pdf-eval-results.json");
  try {
    const driver = new LiveDriver(app.page);
    await driver.waitReady();
    const { backends } = await driver.listBackends();
    const codex = backends.find((backend) => backend.kind === "codex");
    if (!codex?.available || codex.capabilities?.createThread === false) {
      throw new Error(`Codex is unavailable: ${codex?.unavailableReason ?? "not installed or not logged in"}`);
    }

    for (const caseDef of cases) {
      const fixture = fixtures.get(caseDef.fixture);
      if (!fixture) throw new Error(`No fixture configured for ${caseDef.id}`);
      console.log(`\n── ${fixture.label} · ${caseDef.label} ──`);

      for (const condition of ["pdf-file", "page-images"] as const) {
        process.stdout.write(`  ${condition.padEnd(12)} running…\n`);
        const threadId = await driver.startThread(
          "codex",
          app.clonePath,
          "full-access",
          defaultModel,
        );
        await app.focusThread("codex", threadId);
        const startedAt = Date.now();
        const turnId = await driver.startTurnWithInput(
          "codex",
          threadId,
          inputFor(condition, fixture, caseDef.prompt),
          "full-access",
          defaultModel,
        );
        const outcome = await driver.waitForTurn("codex", threadId, turnId, {
          timeoutMs: turnTimeoutMs,
          onLog: (message) => console.log(message),
        });
        const commandOutputDeltas = outcome.methods.filter(
          (method) => method === "item/commandExecution/outputDelta",
        ).length;
        const result: Result = {
          caseId: caseDef.id,
          fixture: fixture.id,
          condition,
          outcome,
          grade: grade(caseDef, outcome),
          elapsedMs: Date.now() - startedAt,
          commandOutputDeltas,
        };
        results.push(result);
        printResult(result);
      }
    }

    const byCondition = (condition: InputCondition): { earned: number; possible: number } =>
      results
        .filter((result) => result.condition === condition)
        .reduce(
          (total, result) => ({
            earned: total.earned + result.grade.earned,
            possible: total.possible + result.grade.possible,
          }),
          { earned: 0, possible: 0 },
        );
    const raw = byCondition("pdf-file");
    const images = byCondition("page-images");
    const metrics = (condition: InputCondition): { averageElapsedMs: number; commandOutputDeltas: number } => {
      const matching = results.filter((result) => result.condition === condition);
      return {
        averageElapsedMs:
          matching.reduce((total, result) => total + result.elapsedMs, 0) / matching.length,
        commandOutputDeltas: matching.reduce(
          (total, result) => total + result.commandOutputDeltas,
          0,
        ),
      };
    };
    const rawMetrics = metrics("pdf-file");
    const imageMetrics = metrics("page-images");
    console.log("\n┌─ Comparison ──────────────────────────────────────────");
    console.log(
      `│ PDF file reference  ${raw.earned}/${raw.possible}; avg ${formatDuration(rawMetrics.averageElapsedMs)}; ` +
        `${rawMetrics.commandOutputDeltas} command-output event(s)`,
    );
    console.log(
      `│ Page images         ${images.earned}/${images.possible}; avg ${formatDuration(imageMetrics.averageElapsedMs)}; ` +
        `${imageMetrics.commandOutputDeltas} command-output event(s)`,
    );
    console.log(
      `│ ${images.earned > raw.earned ? "Image condition scored higher." : images.earned < raw.earned ? "Raw PDF condition scored higher." : "Conditions tied; inspect the answers and event logs."}`,
    );
    console.log("└──────────────────────────────────────────────────────");

    writeFileSync(
      resultsPath,
      JSON.stringify(
        {
          model: defaultModel,
          generatedAt: new Date().toISOString(),
          results,
          totals: { pdfFile: raw, pageImages: images },
          operations: { pdfFile: rawMetrics, pageImages: imageMetrics },
        },
        null,
        2,
      ),
    );

    const failedCases = results.filter((result) => !result.grade.passed).length;
    const failed = (strict && failedCases > 0) || (requireImageWin && images.earned <= raw.earned);
    if (failed) {
      if (requireImageWin && images.earned <= raw.earned) {
        console.log("\n✖ FAIL — EVAL_PDF_REQUIRE_IMAGE_WIN=1 but page images did not score higher.");
      } else {
        console.log(`\n✖ FAIL — ${failedCases} condition run(s) missed their expected markers.`);
      }
      process.exitCode = 1;
    } else {
      console.log("\n✔ COMPLETE — results reported; set EVAL_PDF_STRICT=1 to gate every marker.");
    }
  } finally {
    await app.cleanup();
  }

  console.log(`Results JSON: ${resultsPath}`);
  if (keepTemp) console.log("(EVAL_KEEP_TEMP=1 — temp profile, captures, and result JSON preserved)");
}

main().catch((error) => {
  console.error("\n✖ PDF eval crashed:", error);
  process.exit(2);
});
