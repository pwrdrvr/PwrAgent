import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createVitest } from "vitest/node";

function hasOpaqueImport(source) {
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(callee) && callee.text === "require");
      if (isImport && !(node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]))) return true;
    }
    return ts.forEachChild(node, visit);
  }
  return visit(source);
}

export async function withVitestImpact(root, callback, config = "vitest.linux-ci.ts") {
  const ctx = await createVitest("test", {
    root,
    config: path.resolve(root, config),
    watch: false,
    run: true,
  });
  try {
    const specs = await ctx.globTestSpecifications();
    const fileOf = (spec) => path.relative(root, spec.moduleId).split(path.sep).join("/");
    const keyOf = (spec) => JSON.stringify([spec.project.name, fileOf(spec)]);
    const related = async (file) => {
      ctx.config.related = [path.resolve(root, file).split(path.sep).join("/")];
      return ctx.getRelevantTestSpecifications();
    };

    // The pinned Vitest considers transform errors affected even when no real
    // source is related. Never count those tests as evidence of graph coverage.
    let baseline;
    const select = async (changed) => {
      if (!specs.length || new Set(specs.map(keyOf)).size !== specs.length) {
        return { mode: "full", reason: "missing or ambiguous Vitest test inventory" };
      }
      for (const file of changed) {
        const source = ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
        if (hasOpaqueImport(source)) return { mode: "full", reason: "computed import in changed source", file };
      }
      baseline ??= await related(".local/ci/nonexistent-impact-graph-control");
      if (baseline.length) return { mode: "full", reason: "Vitest graph has unrelated transform or resolution errors", tests: baseline.length };

      const selected = new Map();
      for (const file of changed) {
        const affected = await related(file);
        if (!affected.length) return { mode: "full", reason: "no Vitest graph owner for changed source", file };
        for (const spec of affected) {
          const key = keyOf(spec);
          const entry = selected.get(key) ?? { project: spec.project.name, file: fileOf(spec), reasons: [] };
          entry.reasons.push({ file, reason: file === entry.file ? "edited test" : "Vitest related source" });
          selected.set(key, entry);
        }
      }

      const entries = [...selected.values()].sort((a, b) => keyOfEntry(a).localeCompare(keyOfEntry(b), "en"));
      const projects = Object.fromEntries(ctx.projects.map(({ name }) => [name, {
        total: specs.filter((spec) => spec.project.name === name).length,
        selected: entries.filter((entry) => entry.project === name).length,
      }]));
      const lanes = config === "vitest.linux-ci.ts" ? await linuxLaneEstimates(ctx, specs, selected, keyOf, fileOf) : undefined;
      return { mode: "selected", selected: entries, total: specs.length, projects, lanes };
    };
    return await callback(select);
  } finally {
    await ctx.close();
  }
}

const keyOfEntry = ({ project, file }) => JSON.stringify([project, file]);

async function linuxLaneEstimates(ctx, specs, selected, keyOf, fileOf) {
  const table = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
  const costs = {
    "desktop-main": table("./linux-unit-costs.json"),
    "desktop-renderer": table("./linux-renderer-unit-costs.json"),
  };
  const initialShard = ctx.config.shard;
  const count = 4;
  const metrics = (laneSpecs) => {
    let modeledMs = 0;
    let measuredFiles = 0;
    let unweightedFiles = 0;
    for (const spec of laneSpecs) {
      const weights = costs[spec.project.name];
      if (!weights) {
        unweightedFiles++;
        continue;
      }
      const measured = weights.files[fileOf(spec)];
      if (measured !== undefined) measuredFiles++;
      modeledMs += measured ?? weights.fallbackMs;
    }
    return { files: laneSpecs.length, modeledMs, measuredFiles, unweightedFiles };
  };
  try {
    const lanes = [];
    for (let index = 1; index <= count; index++) {
      ctx.config.shard = { index, count };
      const owned = await new ctx.config.sequence.sequencer(ctx).shard([...specs]);
      lanes.push({ lane: index, total: metrics(owned), selected: metrics(owned.filter((spec) => selected.has(keyOf(spec)))) });
    }
    return lanes;
  } finally {
    ctx.config.shard = initialShard;
  }
}
