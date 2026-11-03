import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { SourceMap } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function boundedFile(filename) {
  if (statSync(filename).size > 32 * 1024 * 1024) throw new Error("size-limit");
  return readFileSync(filename);
}

// Resolve only observed positions after tests. Never persist a raw source map,
// source contents, external source paths, or debugger/process output.
export function childProcessLocations(desktop, journalPath) {
  let journal;
  try { journal = boundedFile(journalPath); }
  catch { return { status: "journal-unavailable", locations: [], builds: [] }; }
  const builds = new Map();
  const locations = new Map();
  const sourceRoot = path.resolve(desktop, "src", "main");
  let omitted = 0;
  for (const line of journal.toString("utf8").split("\n")) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    for (const frame of Array.isArray(record.callSites) ? record.callSites : []) {
      const { file, line, column } = frame;
      if (typeof file !== "string" || !/^out\/main\/[A-Za-z0-9_./-]+\.js$/.test(file) || file.includes("..")) continue;
      if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) continue;
      const key = `${file}:${line}:${column}`;
      if (locations.has(key)) continue;
      if (locations.size >= 4096) { omitted++; continue; }
      let build = builds.get(file);
      if (!build) {
        try {
          const filename = path.resolve(desktop, file);
          const script = boundedFile(filename);
          const bytes = boundedFile(filename + ".map");
          build = { file, filename, map: new SourceMap(JSON.parse(bytes)), scriptSha256: digest(script), mapSha256: digest(bytes) };
        } catch { build = { file, unavailable: true }; }
        builds.set(file, build);
      }
      const location = { file, line, column, status: "unmapped" };
      if (build.map) {
        const entry = build.map.findEntry(line - 1, column - 1);
        if (typeof entry.originalSource === "string") {
          try {
            const original = entry.originalSource.startsWith("file:")
              ? fileURLToPath(entry.originalSource)
              : path.resolve(path.dirname(build.filename), entry.originalSource);
            const relative = path.relative(sourceRoot, original);
            if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
              Object.assign(location, { status: "mapped", source: "src/main/" + relative.replaceAll("\\", "/"),
                sourceLine: entry.originalLine + 1, sourceColumn: entry.originalColumn + 1 });
            }
          } catch { /* Unknown source schemes and external paths remain omitted. */ }
        }
      }
      locations.set(key, location);
    }
  }
  return { status: "complete", journalSha256: digest(journal), omitted,
    builds: [...builds.values()].map(({ file, scriptSha256, mapSha256, unavailable }) => ({ file, scriptSha256, mapSha256, unavailable })),
    locations: [...locations.values()] };
}
