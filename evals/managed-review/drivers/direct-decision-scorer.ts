/**
 * Standalone direct decision batch executor for managed-review eval scoring.
 *
 * Uses PwrAgent's exact System One (`jev`, `local`/Clef) and OpenAI Decisions
 * wire clients so `--mode direct` produces output files 100% compatible with
 * `decision-file-batches.mjs --record` and `aggregate-eval-scores.mjs`.
 *
 * For zero-key proxy execution through a running PwrAgent instance's saved
 * Settings secrets, use `--mode mcp` (the default in `score.mjs`) with
 * `decisions_invoke`.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DECISION_JEV_DEFAULT_MODEL,
  DECISION_JEV_ENDPOINT,
  DECISION_LOCAL_DEFAULT_ENDPOINT,
  DECISION_LOCAL_DEFAULT_MODEL,
} from "@pwragent/shared/decision-models";
import {
  OPENAI_DECISIONS_MODEL,
  type OpenAIDecisionQuestion,
} from "@pwragent/shared/openai-decisions";
import {
  buildSystemOneDecisionRequest,
  postSystemOneDecision,
} from "@pwragent/desktop-main/openai-decisions/system-one-decisions";
import { postOpenAIDecision } from "@pwragent/desktop-main/openai-decisions/openai-decisions-client";
import { collectDecisionFileBatches } from "./decision-file-batches.mjs";

type BatchDefinition = {
  provider?: "jev" | "local" | "openai";
  prefix?: string;
  questions: OpenAIDecisionQuestion[];
};

function parseArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1]!;
  }
  return fallback;
}

function writeAtomicJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function buildOpenAIBody(definition: BatchDefinition, input: unknown, model: string) {
  return {
    model,
    ...(definition.prefix ? { prefix: definition.prefix } : {}),
    input,
    questions: definition.questions,
  };
}

async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const idx = next;
      next += 1;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]!, idx);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main(): Promise<void> {
  const scoringDir = path.resolve(parseArg("--scoring", ""));
  if (!scoringDir || !process.argv.includes("--scoring")) {
    throw new Error("Usage: direct-decision-scorer.js --scoring <dir> [--concurrency 8] [--decision-endpoint <url>] [--decision-model <id>]");
  }
  const concurrency = Math.max(1, Number(parseArg("--concurrency", "8")));
  const endpointOverride = parseArg("--decision-endpoint", process.env.PWRAGENT_DECISION_ENDPOINT ?? "") || undefined;
  const modelOverride = parseArg("--decision-model", process.env.PWRAGENT_DECISION_MODEL ?? "") || undefined;
  const timeoutMs = Math.max(1000, Number(parseArg("--timeout-ms", "60000")));

  const plan = collectDecisionFileBatches(scoringDir, false) as {
    complete: number;
    pending: Array<{
      batchType: string;
      chunkIndex: number;
      count: number;
      arguments: {
        definition: BatchDefinition;
        inputsFile: string;
        outputFile: string;
      };
    }>;
  };

  if (plan.pending.length === 0) {
    console.log(JSON.stringify({ executed: 0, complete: plan.complete }));
    return;
  }

  let executed = 0;
  for (const entry of plan.pending) {
    const { definition, inputsFile, outputFile } = entry.arguments;
    const provider = definition.provider;
    if (!provider) {
      throw new Error(
        "Direct scoring batch has no explicit provider (prepared with --judge-provider default). "
        + "Re-prepare with --judge-provider jev, local, or openai, or score via --mode mcp.",
      );
    }
    const inputs = JSON.parse(fs.readFileSync(inputsFile, "utf8")) as unknown[];
    if (!Array.isArray(inputs) || inputs.length !== entry.count) {
      throw new Error(`Input count mismatch for ${entry.batchType}#${entry.chunkIndex}.`);
    }

    const resolvedModel = modelOverride
      ?? (provider === "jev"
        ? DECISION_JEV_DEFAULT_MODEL
        : provider === "local"
          ? DECISION_LOCAL_DEFAULT_MODEL
          : OPENAI_DECISIONS_MODEL);
    let observedModel: string | undefined;

    const batchId = `direct-${provider}-${randomUUID()}`;
    const results = await runPool(inputs, concurrency, async (input, index) => {
      if (provider === "jev" || provider === "local") {
        const endpoint = endpointOverride
          ?? (provider === "jev" ? DECISION_JEV_ENDPOINT : DECISION_LOCAL_DEFAULT_ENDPOINT);
        const apiKey = provider === "jev"
          ? (process.env.TYPESAFE_JEV_API_KEY?.trim() || process.env.JEV_API_KEY?.trim() || undefined)
          : (process.env.PWRAGENT_DECISION_LOCAL_API_KEY?.trim() || undefined);
        if (provider === "jev" && !apiKey && !endpointOverride) {
          throw new Error(
            "Direct Jev scoring requires TYPESAFE_JEV_API_KEY (or --decision-endpoint for a local proxy). "
            + "To score with PwrAgent's saved Jev credential without exposing a key, run with --mode mcp and invoke decisions_invoke.",
          );
        }
        const request = buildSystemOneDecisionRequest({
          questions: definition.questions,
          prefix: definition.prefix,
          input,
        });
        const response = await postSystemOneDecision({
          target: { endpoint: endpoint.replace(/\/+$/u, ""), model: resolvedModel, ...(apiKey ? { apiKey } : {}) },
          request,
          questions: definition.questions,
          timeoutMs,
        });
        if (!response.ok) {
          throw new Error(`Decision call failed (${provider} ${response.code}${response.status ? ` HTTP ${response.status}` : ""}): ${response.detail ?? "unknown error"}`);
        }
        if (!observedModel && "model" in response && typeof response.model === "string" && response.model.trim()) {
          observedModel = response.model.trim();
        }
        return { index, ok: true, answers: response.answers };
      }

      const apiKey = process.env.OPENAI_DECISIONS_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        throw new Error(
          "Direct OpenAI Decisions scoring requires OPENAI_DECISIONS_API_KEY or OPENAI_API_KEY. "
          + "To score via PwrAgent's saved credential without exposing a key, run with --mode mcp.",
        );
      }
      const response = await postOpenAIDecision({
        body: buildOpenAIBody(definition, input, resolvedModel) as never,
        apiKey,
        ...(endpointOverride ? { endpoint: endpointOverride } : {}),
        timeoutMs,
      });
      if (!response.ok) {
        throw new Error(`Decision call failed (openai ${response.code}${response.status ? ` HTTP ${response.status}` : ""}): ${response.detail ?? "unknown error"}`);
      }
      if (!observedModel && typeof response.body.model === "string" && response.body.model.trim()) {
        observedModel = response.body.model.trim();
      }
      const answers = Array.isArray(response.body.answers) ? response.body.answers : [];
      return { index, ok: true, answers };
    });

    writeAtomicJson(outputFile, {
      state: "completed",
      batchId,
      provider,
      model: observedModel ?? resolvedModel,
      count: inputs.length,
      succeeded: results.length,
      failed: 0,
      usage: { estimatedCostUsd: null },
      results,
    });
    executed += 1;
  }

  console.log(JSON.stringify({ executed, complete: plan.complete + executed }));
}

main().catch((error) => {
  process.stderr.write(`[direct-decision-scorer] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
