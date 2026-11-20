import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import ts from "typescript";
import { createVitest } from "vitest/node";
import { testSidePath } from "./pr-test-impact.mjs";

const codeFile = /\.[cm]?[jt]sx?$/;
// A test that lists directories can read a file that no module imports.
const enumeratesFiles = /readdirSync|readdir\(|opendir|globSync|fast-glob|tinyglobby|\bglob\(|ls-files/;
// A loader whose specifier is computed can load a file that it only names
// in a string, which the import graph never links.
const computedLoader = /\bimport\s*\(\s*(?:[^"'`\s)]|`[^`]*\$\{)|\brequire\s*\(\s*(?:[^"'`\s)]|`[^`]*\$\{)|createRequire/;
// A bundler, a worker or a TypeScript loader runs source that the Vitest
// graph never links to the test that started it.
const bundlesSource = /from "(?:esbuild|vite|rollup|rolldown)"/;
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
        // Vite can wrap external Node IDs in a browser URL. The wrapper
        // is not a filesystem import and node: builtins need no graph edge.
        const builtinId = specifier.replace(/^\/@id\//, "");
        if ((!specifier.startsWith(".") && linked.has(specifier)) || isBuiltin(builtinId)
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

const isPureBarrel = (source) => source.statements.length > 0
  && source.statements.every((statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier);
const hasExportModifier = (node) => ts.canHaveModifiers(node)
  && ts.getModifiers(node)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword);

function bindingNames(name, names) {
  if (ts.isIdentifier(name)) names.push(name.text);
  else name.elements.forEach((element) => ts.isBindingElement(element) && bindingNames(element.name, names));
}

/**
 * Narrows edges into pure re-export barrels of packages that declare
 * `"sideEffects": false`. An importer that names its bindings depends on the
 * modules that provide those names, as it does in the application bundle.
 */
async function refineBarrelEdges(root, edges, resolveBare) {
  const sources = new Map();
  const parse = (file) => {
    if (!sources.has(file)) {
      let source = null;
      try {
        source = ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, false);
      } catch {}
      sources.set(file, source);
    }
    return sources.get(file);
  };
  const packages = new Map();
  const sideEffectFree = (file) => {
    for (let directory = path.posix.dirname(file); directory !== "."; directory = path.posix.dirname(directory)) {
      if (!packages.has(directory)) {
        let declared;
        try {
          declared = JSON.parse(readFileSync(path.join(root, directory, "package.json"), "utf8")).sideEffects === false;
        } catch {}
        packages.set(directory, declared);
      }
      if (packages.get(directory) !== undefined) return packages.get(directory);
    }
    return false;
  };
  const resolveRelative = (from, specifier) => {
    if (!specifier.startsWith(".")) return undefined;
    const base = path.posix.join(path.posix.dirname(from), specifier);
    const stem = base.replace(/\.[cm]?js$/, "");
    const candidates = [base, ...extensions.map((extension) => `${stem}${extension}`),
      ...extensions.map((extension) => `${base}/index${extension}`)];
    // A module that only declares types has no runtime edge, so it is
    // absent from the graph while a barrel still forwards its names.
    return candidates.find((candidate) => edges.has(candidate))
      ?? candidates.find((candidate) => codeFile.test(candidate) && existsSync(path.join(root, candidate)));
  };
  const barrels = new Map();
  const barrel = (file) => {
    if (!barrels.has(file)) {
      const source = codeFile.test(file) && sideEffectFree(file) ? parse(file) : null;
      barrels.set(file, Boolean(source && isPureBarrel(source)));
    }
    return barrels.get(file);
  };

  // Every name a real module exports, including names it forwards.
  const declared = new Map();
  const declaredNames = (file, seen = new Set()) => {
    if (declared.has(file)) return declared.get(file);
    if (seen.has(file)) return new Set();
    seen.add(file);
    const names = new Set();
    const source = parse(file);
    if (!source) return undefined;
    for (const statement of source.statements) {
      if (ts.isExportAssignment(statement)) names.add("default");
      else if (ts.isExportDeclaration(statement)) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          statement.exportClause.elements.forEach(({ name }) => names.add(name.text));
        } else if (statement.exportClause) names.add(statement.exportClause.name.text);
        else {
          const target = statement.moduleSpecifier && resolveRelative(file, statement.moduleSpecifier.text);
          const forwarded = target && declaredNames(target, seen);
          if (!forwarded) return undefined;
          forwarded.forEach((name) => name !== "default" && names.add(name));
        }
      } else if (hasExportModifier(statement)) {
        if (ts.getModifiers(statement).some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword)) names.add("default");
        else if (ts.isVariableStatement(statement)) {
          const found = [];
          statement.declarationList.declarations.forEach(({ name }) => bindingNames(name, found));
          found.forEach((name) => names.add(name));
        } else if (statement.name) names.add(statement.name.text);
      }
    }
    declared.set(file, names);
    return names;
  };

  // name -> first module on the re-export chain that has code of its own.
  const provided = new Map();
  const providers = (file, seen = new Set()) => {
    if (provided.has(file)) return provided.get(file);
    if (seen.has(file)) return undefined;
    seen.add(file);
    const names = new Map();
    for (const statement of parse(file).statements) {
      const target = resolveRelative(file, statement.moduleSpecifier.text);
      if (!target) return undefined;
      const nested = barrel(target) ? providers(target, seen) : undefined;
      if (barrel(target) && !nested) return undefined;
      if (!statement.exportClause) {
        const forwarded = nested ?? declaredNames(target);
        if (!forwarded) return undefined;
        for (const name of forwarded.keys()) {
          if (name !== "default" && !names.has(name)) names.set(name, nested ? nested.get(name) : target);
        }
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const { name, propertyName } of statement.exportClause.elements) {
          const provider = nested ? nested.get((propertyName ?? name).text) : target;
          if (!provider) return undefined;
          names.set(name.text, provider);
        }
      } else names.set(statement.exportClause.name.text, target);
    }
    provided.set(file, names);
    return names;
  };

  const refined = new Map([...edges].map(([file, targets]) => [file, new Set(targets)]));
  const used = new Set();
  for (const [importer, targets] of edges) {
    for (const target of targets) {
      if (!barrel(target)) continue;
      const names = providers(target);
      const source = names && parse(importer);
      if (!source) continue;
      // Workspace packages are imported by name, so ask Vite where each
      // named module of this importer resolves.
      const bare = new Map();
      for (const statement of source.statements) {
        const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
          && statement.moduleSpecifier?.text;
        if (specifier && !specifier.startsWith(".")) bare.set(specifier, await resolveBare(specifier, importer));
      }
      const matches = (node) => node && ts.isStringLiteralLike(node)
        && (resolveRelative(importer, node.text) === target || bare.get(node.text) === target);
      const wanted = new Set();
      let whole = false;
      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) && matches(statement.moduleSpecifier)) {
          const clause = statement.importClause;
          if (!clause || clause.name) whole = true;
          else if (clause.isTypeOnly) continue;
          else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            clause.namedBindings.elements.forEach(({ name, propertyName }) => wanted.add((propertyName ?? name).text));
          } else whole = true;
        } else if (ts.isExportDeclaration(statement) && matches(statement.moduleSpecifier)) {
          if (statement.isTypeOnly) continue;
          if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            statement.exportClause.elements.forEach(({ name, propertyName }) => wanted.add((propertyName ?? name).text));
          } else whole = true;
        }
      }
      // A dynamic import, require or mock of the barrel uses all of it.
      const visit = (node) => {
        if (ts.isCallExpression(node) && node.arguments.some(matches)) whole = true;
        else ts.forEachChild(node, visit);
      };
      visit(source);
      // No named import explains this runtime edge: leave it alone.
      if (whole || !wanted.size || [...wanted].some((name) => !names.has(name))) continue;
      const narrowed = refined.get(importer);
      narrowed.delete(target);
      wanted.forEach((name) => narrowed.add(names.get(name)));
      used.add(target);
    }
  }
  return { refined, barrels: [...used].sort() };
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

export async function withVitestImpact(root, callback, config = "vitest.linux-ci.ts") {
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
      const resolved = new Map();
      const resolveBare = async (specifier, importer) => {
        if (!resolved.has(specifier)) {
          let file;
          for (const environment of environments) {
            const result = await environment.pluginContainer.resolveId(specifier, path.join(root, importer)).catch(() => null);
            if (result && path.isAbsolute(result.id)) {
              file = relative(result.id.replace(/[?#].*$/, ""));
              break;
            }
          }
          resolved.set(specifier, file);
        }
        return resolved.get(specifier);
      };
      const { refined, barrels } = await refineBarrelEdges(root, edges, resolveBare);
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
      const setupFiles = new Set(ctx.projects.flatMap(({ config: project }) => [
        ...project.setupFiles, ...project.globalSetup, ...project.snapshotSerializers,
      ]).map(relative));
      return graph = {
        edges, barrels, text, setupFiles,
        importers: reverse(edges), refinedImporters: reverse(refined),
      };
    };

    const select = async (changes) => {
      if (!specs.length || new Set(specs.map(keyOf)).size !== specs.length) {
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
      const { edges, importers, refinedImporters, barrels, text, setupFiles } = loaded;
      const specFiles = new Map(specs.map((spec) => [fileOf(spec), spec]));
      const specsAmong = (files) => [...files].filter((file) => specFiles.has(file));
      // Files that name a changed file in a string: by basename for data,
      // and by module path for code, where `index` is named by its directory.
      const literalOwners = (file, loadersOnly = false) => {
        const stem = path.posix.basename(file).replace(codeFile, "");
        const needle = !codeFile.test(file) ? path.posix.basename(file)
          : stem === "index" ? `/${path.posix.basename(path.posix.dirname(file))}` : `/${stem}`;
        return [...edges.keys()].filter((candidate) => candidate !== file && text(candidate).includes(needle)
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
          const wide = dependents(importers, file);
          specsAmong(wide).forEach((spec) => explained.add(spec));
          // A setup file reaches tests without an import edge, and a changed
          // barrel can rebind any name. Keep Vitest's answer for both.
          const exact = barrels.includes(file) || [...setupFiles].some((setup) => wide.has(setup));
          const narrow = exact ? wide : dependents(refinedImporters, file);
          const owners = specsAmong(narrow).filter((spec) => affected.has(spec));
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
        && !file.startsWith(e2eDirectory)
        && (edges.has(file) || codeFile.test(file) && (status === "D" || !isTypeOnly(root, file))));
      for (const file of edges.keys()) {
        const testSide = testSidePath.test(file) || specFiles.has(file);
        const reason = testSide && enumeratesFiles.test(text(file)) ? "always run: enumerates files"
          : product && (bundlesSource.test(text(file)) || testSide && loadsSource.test(text(file)))
            ? "runs on product changes: executes source outside the Vitest graph"
            : undefined;
        if (!reason) continue;
        for (const spec of specsAmong(dependents(importers, file))) add(spec, { file, reason });
      }

      const entries = [...selected.values()].sort((a, b) => keyOfEntry(a).localeCompare(keyOfEntry(b), "en"));
      const projects = Object.fromEntries(ctx.projects.map(({ name }) => [name, {
        total: specs.filter((spec) => spec.project.name === name).length,
        selected: entries.filter((entry) => entry.project === name).length,
      }]));
      const lanes = config === "vitest.linux-ci.ts" ? await linuxLaneEstimates(ctx, specs, selected, keyOf, fileOf) : undefined;
      return { mode: "selected", selected: entries, total: specs.length, projects, lanes, ignored, barrels };
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
