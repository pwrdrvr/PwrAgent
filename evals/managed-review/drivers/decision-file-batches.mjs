#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function completeDecisionAnswers(answers, questions) {
  return Array.isArray(answers) && answers.length === questions.length && questions.every((question) => {
    const answer = answers.find((item) => item?.name === question.name);
    if (!answer) return false;
    switch (question.type) {
      case "predicate":
        return Number.isFinite(answer.probability) && answer.probability >= 0 && answer.probability <= 1;
      case "choice":
        return question.choices.some((choice) => choice.value === answer.choice);
      case "score":
        return Number.isFinite(answer.score) && answer.score >= 0 && answer.score < question.levels.length;
      default:
        return false;
    }
  });
}

const SUPPORTED_DECISION_PROVIDERS = new Set(["jev", "local", "openai"]);

export function readDecisionOutput(file, count, definition) {
  const output = JSON.parse(fs.readFileSync(file, "utf8"));
  const providerMatches = definition.provider
    ? output.provider === definition.provider
    : SUPPORTED_DECISION_PROVIDERS.has(output.provider);
  if (output.state !== "completed" || output.count !== count || output.succeeded !== count || output.failed !== 0
    || !providerMatches || typeof output.batchId !== "string" || !output.batchId
    || !Array.isArray(output.results) || output.results.length !== count
    || output.results.some((item, index) => item.index !== index || item.ok !== true
      || !completeDecisionAnswers(item.answers ?? item.response?.answers, definition.questions))) {
    throw new Error("Decision output is incomplete or has an unexpected provider.");
  }
  return output;
}

export function collectDecisionFileBatches(scoring, record) {
  const manifest = JSON.parse(fs.readFileSync(path.join(scoring, "chunks-manifest.json"), "utf8"));
  const definitionsBytes = fs.readFileSync(path.join(scoring, "scoring-definitions.json"));
  const definitionSha256 = createHash("sha256").update(definitionsBytes).digest("hex");
  if (definitionSha256 !== manifest.definitionSha256) throw new Error("Decision definitions changed after preparation.");
  const definitions = JSON.parse(definitionsBytes);
  const summary = {};
  const pending = [];
  let complete = 0;

  for (const batchType of ["recall", "precision", "holistic"]) {
    summary[batchType] = [];
    const definition = definitions[batchType];
    for (const [chunkIndex, chunk] of manifest[batchType].entries()) {
      const inputsFile = path.resolve(chunk.file);
      const inputsSha256 = createHash("sha256").update(fs.readFileSync(inputsFile)).digest("hex");
      if (inputsSha256 !== chunk.inputsSha256) throw new Error("Decision inputs changed after preparation.");
      const outputFile = path.join(scoring, "decision-output", `${batchType}-${chunkIndex}-${definitionSha256}-${inputsSha256}.json`);
      let output;
      try {
        output = readDecisionOutput(outputFile, chunk.count, definition);
      } catch {
        pending.push({ batchType, chunkIndex, count: chunk.count, arguments: {
          definition, inputsFile, outputFile, inlineResults: false, concurrency: 8, detail: "compact",
        } });
        continue;
      }
      complete += 1;
      summary[batchType].push({
        batchType, chunkIndex, start: chunk.start, count: chunk.count,
        provider: output.provider,
        ...(typeof output.model === "string" && output.model.trim() ? { model: output.model.trim() } : {}),
        batchId: output.batchId, succeeded: output.succeeded, failed: output.failed,
        estimatedCostUsd: typeof output.usage?.estimatedCostUsd === "number" && Number.isFinite(output.usage.estimatedCostUsd)
          ? output.usage.estimatedCostUsd
          : null,
        definitionSha256, inputsSha256, outputFile,
      });
    }
  }

  if (record) {
    if (pending.length) throw new Error(`${pending.length} Decision file batches are missing or incomplete.`);
    const target = path.join(scoring, "decision-batches-summary.json");
    const scratch = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(scratch, `${JSON.stringify(summary, null, 2)}\n`);
    fs.renameSync(scratch, target);
    return { complete, recorded: true };
  }
  return { complete, pending };
}

if (
  process.argv[1]
  && path.basename(process.argv[1]) === "decision-file-batches.mjs"
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const scoring = process.argv[process.argv.indexOf("--scoring") + 1];
  if (!process.argv.includes("--scoring") || !scoring || scoring.startsWith("--")) {
    throw new Error("Usage: decision-file-batches.mjs --scoring <scoring-directory> [--record]");
  }
  console.log(JSON.stringify(collectDecisionFileBatches(path.resolve(scoring), process.argv.includes("--record")), null, 2));
}
