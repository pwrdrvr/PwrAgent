import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.resolve("vite"));
const { TraceMap, originalPositionFor } = require("@jridgewell/trace-mapping");

export function annotateBytecode(root, module, records) {
  const ast = ts.createSourceFile(module.file, module.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = [];
  const pending = [{ node: ast, parent: undefined }];
  while (pending.length) {
    let { node, parent } = pending.pop();
    if ((ts.isFunctionLike(node) && node.body) || ts.isClassLike(node)) {
      const frame = { node, start: node.getStart(ast), end: node.end, parent };
      functions.push(frame);
      parent = frame;
    }
    ts.forEachChild(node, (child) => { pending.push({ node: child, parent }); });
  }
  functions.sort((a, b) => a.start - b.start || b.end - a.end);
  function containing(position) {
    let low = 0;
    let high = functions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (functions[middle].start <= position) low = middle + 1;
      else high = middle;
    }
    let frame = functions[low - 1];
    while (frame && position >= frame.end) frame = frame.parent;
    return frame?.node;
  }
  const map = module.map ? new TraceMap(module.map) : undefined;
  const runtimeFiles = new Set(module.runtimeFiles ?? []);
  const runtimeHelpers = new Set();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const dependency = relative(root, resolve(dirname(resolve(root, module.file)), statement.moduleSpecifier.text)).replaceAll("\\", "/");
    if (!runtimeFiles.has(dependency)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (["t", "n"].includes(binding.propertyName?.text ?? binding.name.text)) runtimeHelpers.add(binding.name.text);
      }
    }
  }
  const runtimeChunk = runtimeFiles.has(module.file);
  if (!map && module.variant === "production" && !runtimeChunk) throw new Error(`Missing production source map: ${module.file}`);
  return records.map(({ positions, ...record }, index) => {
    const position = positions.find((value) => value > 0) ?? positions[0];
    const node = position === undefined ? undefined : containing(position);
    const location = ast.getLineAndCharacterOfPosition(position ?? 0);
    const originals = [];
    if (map) {
      for (const value of new Set([position, ...positions])) {
        if (value === undefined) continue;
        const point = ast.getLineAndCharacterOfPosition(value);
        const column = point.character - (point.line === 0 ? module.wrapperPrefixLength ?? 0 : 0);
        if (column < 0) continue;
        const candidate = originalPositionFor(map, { line: point.line + 1, column });
        if (candidate.source) {
          const absolute = resolve(dirname(resolve(root, module.file)), candidate.source);
          originals.push({ ...candidate, source: relative(root, absolute).replaceAll("\\", "/"), firstParty: absolute.startsWith(root + sep) && !absolute.includes(sep + "node_modules" + sep) });
        }
      }
    }
    // A compressor may merge code from multiple modules into one frame. Any
    // first-party contribution keeps the entire frame under the budget.
    const original = originals.find((point) => point.firstParty) ?? originals[0];
    const source = original?.source ?? module.source;
    const parent = node?.parent;
    const bundlerWrapper = parent && ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && runtimeHelpers.has(parent.expression.text) && parent.arguments.includes(node);
    const classification = runtimeChunk ? "synthetic-bundler-runtime"
      : index === 0 || (module.variant === "Vitest" && functions[0]?.node === node) ? "synthetic-module-wrapper"
        : bundlerWrapper ? "synthetic-bundler-wrapper"
          : source?.includes("node_modules/") ? "third-party"
            : source && node ? "first-party" : "unmapped";
    return { ...record, classification, source, locationKind: original ? "source-map" : "generated", line: original?.line ?? location.line + 1, column: original?.column ?? location.character, generatedLine: location.line + 1, generatedColumn: location.character, contributingSources: originals.length ? [...new Set(originals.map((point) => point.source))] : undefined, generatedPosition: position, generatedStart: node?.getStart(ast), generatedEnd: node?.end };
  });
}
