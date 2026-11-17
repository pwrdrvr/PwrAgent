import path from "node:path";

/** Describe emitted files, not source imports: bundling can erase laziness. */
export function headlessOutputManifest(metafile, entries) {
  const outputs = metafile.outputs;
  const chunks = {};
  const sourceName = file => {
    const normalized = file.replaceAll("\\", "/");
    const at = normalized.lastIndexOf("node_modules/");
    return at < 0 ? normalized : normalized.slice(at);
  };
  for (const [file, output] of Object.entries(outputs)) {
    if (!/\.[cm]?js$/.test(file)) continue;
    chunks[path.basename(file)] = {
      ...(output.entryPoint ? { entryPoint: sourceName(output.entryPoint) } : {}),
      imports: output.imports.filter(item => !item.external && item.kind !== "dynamic-import").map(item => path.basename(item.path)),
      dynamicImports: output.imports.filter(item => !item.external && item.kind === "dynamic-import").map(item => path.basename(item.path)),
      inputs: Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([input]) => sourceName(input)),
    };
  }
  return { version: 1, entries: Object.fromEntries(Object.keys(entries).map(name => [name, `${name}.mjs`])), chunks };
}
