import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import ts from "typescript";
import { createVitest } from "vitest/node";
import { namesFile, testSidePath } from "./pr-test-impact.mjs";

const codeFile = /\.[cm]?[jt]sx?$/;
// A test that lists directories can read a file that no module imports.
const enumeratesFiles = /readdirSync|readdir\(|opendir|globSync|fast-glob|tinyglobby|\bglob\(|ls-files/;
// A loader whose specifier is computed can load a file that it only names
// in a string, which the import graph never links.
const computedLoader = /\bimport\s*\(\s*(?:[^"'`\s)]|`[^`]*\$\{)|\brequire\s*\(\s*(?:[^"'`\s)]|`[^`]*\$\{)|createRequire/;
// A bundler, a worker or a TypeScript loader runs source that the Vitest
// graph never links to the test that started it.
const bundlesSource = /(?:\bfrom\s*|\bimport\(\s*|\brequire\(\s*)["'](?:esbuild|vite|electron-vite|rollup|rolldown)["']/;
const loadsSource = /\bnew Worker\(|["'`]tsx["'`/]|--experimental-(?:strip|transform)-types/;
const e2eDirectory = "apps/desktop/e2e/";
const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function hasOpaqueImport(source) {
  function visit(node) {
    // A createRequire loader can escape, be aliased, or load a literal that
    // Vite will never see. Widen as soon as changed code references it.
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === "createRequire") return true;
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

async function findUnresolvedStaticImport(environments) {
  for (const environment of environments) {
    for (const module of environment.moduleGraph.idToModuleMap.values()) {
      const deps = module.transformResult?.deps;
      if (!module.file || !deps?.length) continue;
      const linked = new Set([...module.importedModules].flatMap(({ id, url }) => [id, url]));
      for (const specifier of deps) {
        // Vite encodes virtual and external IDs in transformResult.deps as
        // `/@id/<id>` with `\0` replaced by `__x00__` (Vite's `unwrapId`),
        // while `module.importedModules` stores the unwrapped ID (e.g. Oxc's
        // `\0@oxc-project+runtime@.../helpers/esm/usingCtx.js` helper for
        // `using` declarations) and node: builtins need no graph edge.
        const unwrapped = specifier.startsWith("/@id/")
          ? specifier.slice(5).replace("__x00__", "\0")
          : specifier;
        if ((!specifier.startsWith(".") && (linked.has(specifier) || linked.has(unwrapped)))
          || isBuiltin(unwrapped)
          || /^(?:https?:|data:)/.test(specifier)) continue;
        // SSR can preserve an unresolved static specifier without throwing.
        // External dependencies also lack an edge, so ask Vite to resolve
        // only the specifiers that the transform did not link.
        const resolved = await environment.pluginContainer.resolveId(specifier, module.id);
        if (!resolved || resolved.meta?.["vite:alias"]?.noResolved) return { specifier, importer: module.file };
      }
    }
  }
}

function reverse(edges) {
  const importers = new Map();
  for (const [from, targets] of edges) {
    for (const target of targets) {
      if (!importers.has(target)) importers.set(target, []);
      importers.get(target).push(from);
    }
  }
  return importers;
}

function dependents(importers, start) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    for (const importer of importers.get(stack.pop()) ?? []) {
      if (!seen.has(importer)) {
        seen.add(importer);
        stack.push(importer);
      }
    }
  }
  return seen;
}

function isTypeOnly(root, file) {
  if (/\.d\.[cm]?ts$/.test(file)) return true;
  if (!/\.[cm]?tsx?$/.test(file)) return false;
  const emitted = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve,
      isolatedModules: true, removeComments: true,
    },
  }).outputText;
  return emitted.replace(/export\s*\{\s*\};?/g, "").trim() === "";
}

// Deleting `name.ts` can silently repoint an unchanged import at `name.js`
// or `name/index.ts`, and the reverse for a deleted index file.
function deletionChangesResolution(root, file) {
  if (file.includes("/__mocks__/")) return true;
  const directory = path.posix.dirname(file);
  const stem = path.posix.basename(file).replace(codeFile, "");
  if (stem === path.posix.basename(file)) return false;
  let siblings = [];
  try {
    siblings = readdirSync(path.join(root, directory));
  } catch {}
  if (siblings.some((entry) => entry === stem || entry.replace(codeFile, "") === stem)) return true;
  return stem === "index" && extensions.some((extension) => existsSync(path.join(root, `${directory}${extension}`)));
}

export async function withVitestImpact(root, callback, config = "vitest.linux-ci.mts") {
  const ctx = await createVitest("test", {
    root,
    config: path.resolve(root, config),
    watch: false,
    run: true,
  });
  try {
    const relative = (file) => path.relative(root, file).split(path.sep).join("/");
    const specs = await ctx.globTestSpecifications();
    const fileOf = (spec) => relative(spec.moduleId);
    const keyOf = (spec) => JSON.stringify([spec.project.name, fileOf(spec)]);
    const related = async (files) => {
      ctx.config.related = files.map((file) => path.resolve(root, file).split(path.sep).join("/"));
      return ctx.getRelevantTestSpecifications();
    };

    // The pinned Vitest considers transform errors affected even when no real
    // source is related. Never count those tests as evidence of graph coverage.
    let graph;
    const loadGraph = async () => {
      if (graph) return graph;
      const baseline = await related([".local/ci/nonexistent-impact-graph-control"]);
      if (baseline.length) {
        return graph = { full: { mode: "full", reason: "Vitest graph has unrelated transform or resolution errors", tests: baseline.length } };
      }
      const environments = [...new Set(ctx.projects.flatMap((project) => Object.values(project.vite.environments)))];
      const unresolved = await findUnresolvedStaticImport(environments);
      if (unresolved) return graph = { full: { mode: "full", reason: "unresolved static import in Vitest graph", ...unresolved } };

      const edges = new Map();
      for (const environment of environments) {
        for (const module of environment.moduleGraph.idToModuleMap.values()) {
          if (!module.file || !path.isAbsolute(module.file) || module.file.includes("node_modules")) continue;
          const from = relative(module.file);
          if (!edges.has(from)) edges.set(from, new Set());
          for (const imported of module.importedModules) {
            if (!imported.file || !path.isAbsolute(imported.file) || imported.file.includes("node_modules")) continue;
            edges.get(from).add(relative(imported.file));
          }
        }
      }
      for (const spec of specs) if (!edges.has(fileOf(spec))) edges.set(fileOf(spec), new Set());
      const texts = new Map();
      const text = (file) => {
        if (!texts.has(file)) {
          let content = "";
          try {
            content = readFileSync(path.join(root, file), "utf8");
          } catch {}
          texts.set(file, content);
        }
        return texts.get(file);
      };
      return graph = { edges, text, importers: reverse(edges) };
    };

    const select = async (changes) => {
      // A file that two projects collect would need a selection per project.
      if (!specs.length || new Set(specs.map(fileOf)).size !== specs.length) {
        return { mode: "full", reason: "missing or ambiguous Vitest test inventory" };
      }
      const present = changes.filter(({ status }) => status !== "D");
      for (const { file } of present) {
        if (!codeFile.test(file)) continue;
        const source = ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
        if (hasOpaqueImport(source)) return { mode: "full", reason: "computed import in changed source", file };
      }
      const loaded = await loadGraph();
      if (loaded.full) return loaded.full;
      const { edges, importers, text } = loaded;
      const specFiles = new Map(specs.map((spec) => [fileOf(spec), spec]));
      const specsAmong = (files) => [...files].filter((file) => specFiles.has(file));
      // Files that name a changed file in a string.
      const literalOwners = (file, loadersOnly = false) => {
        const named = namesFile(file);
        return [...edges.keys()].filter((candidate) => candidate !== file && named(text(candidate))
          && (!loadersOnly || computedLoader.test(text(candidate))));
      };

      const selected = new Map();
      const add = (file, reason) => {
        const spec = specFiles.get(file);
        const key = keyOf(spec);
        const entry = selected.get(key) ?? { project: spec.project.name, file, reasons: [] };
        if (!entry.reasons.some((existing) => existing.file === reason.file && existing.reason === reason.reason)) {
          entry.reasons.push(reason);
        }
        selected.set(key, entry);
      };
      const ignored = [];

      // Vitest decides relevance: it knows mocks, setup files, snapshots and
      // configuration. The local graph only attributes and narrows its answer.
      const inGraph = present.filter(({ file }) => edges.has(file)).map(({ file }) => file);
      const affected = new Set((await related(inGraph)).map(fileOf));
      const explained = new Set();
      for (const spec of await related(present.filter(({ file }) => !edges.has(file)).map(({ file }) => file))) {
        add(fileOf(spec), { reason: "Vitest related input" });
      }
      for (const { status, file } of changes) {
        const reference = (owners) => {
          for (const owner of owners) {
            for (const spec of specsAmong(dependents(importers, owner))) {
              add(spec, { file, reason: `named in ${owner}` });
            }
          }
        };
        if (status === "D") {
          if (deletionChangesResolution(root, file)) {
            return { mode: "full", reason: "deleted file can change module resolution", file };
          }
          reference(literalOwners(file));
          ignored.push({ file, reason: "deleted; an unchanged importer fails resolution" });
          continue;
        }
        if (edges.has(file)) {
          const reached = specsAmong(dependents(importers, file));
          reached.forEach((spec) => explained.add(spec));
          const owners = reached.filter((spec) => affected.has(spec));
          if (!owners.length) return { mode: "full", reason: "no Vitest graph owner for changed source", file };
          owners.forEach((spec) => add(spec, { file, reason: spec === file ? "edited test" : "Vitest related source" }));
          if (codeFile.test(file)) reference(literalOwners(file, true));
          continue;
        }
        if (isTypeOnly(root, file)) {
          ignored.push({ file, reason: "type-only module" });
          continue;
        }
        const owners = literalOwners(file);
        if (owners.length) reference(owners);
        else if (file.startsWith(e2eDirectory)) ignored.push({ file, reason: "Playwright-only input" });
        else return { mode: "full", reason: "no unit owner for changed input", file };
      }
      // Vitest also selects through setup files, snapshots and environments.
      for (const file of affected) {
        if (!explained.has(file)) add(file, { reason: "Vitest related input" });
      }
      const product = changes.some(({ status, file }) => !testSidePath.test(file) && !specFiles.has(file)
        && !file.startsWith(e2eDirectory) && (status === "D" || !isTypeOnly(root, file)));
      for (const file of edges.keys()) {
        const testSide = testSidePath.test(file) || specFiles.has(file);
        const content = testSide || product ? text(file) : "";
        const reason = testSide && enumeratesFiles.test(content) ? "always run: enumerates files"
          : product && (bundlesSource.test(content) || testSide && loadsSource.test(content))
            ? "runs on product changes: executes source outside the Vitest graph"
            : undefined;
        if (!reason) continue;
        for (const spec of specsAmong(dependents(importers, file))) add(spec, { file, reason });
      }

      const entries = [...selected.values()].sort((a, b) => keyOfEntry(a).localeCompare(keyOfEntry(b), "en"));
      return { mode: "selected", selected: entries, total: specs.length, ignored };
    };
    // Whether everything that imports this file, directly or through other
    // modules, is a test input. Product code that imports it reaches E2E.
    select.testOnly = async (file) => {
      const loaded = await loadGraph();
      if (loaded.full) return false;
      const specFiles = new Set(specs.map(fileOf));
      return [...dependents(loaded.importers, file)].every((dependent) => testSidePath.test(dependent)
        || specFiles.has(dependent) || dependent.startsWith(e2eDirectory));
    };
    return await callback(select);
  } finally {
    await ctx.close();
  }
}

const keyOfEntry = ({ project, file }) => JSON.stringify([project, file]);
