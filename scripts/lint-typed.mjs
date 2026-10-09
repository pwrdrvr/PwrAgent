import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { runOxlint } from "./oxlint.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export function typedLintFiles(directory = root) {
  const config = JSON.parse(readFileSync(resolve(directory, "oxlint.typed.json"), "utf8"));
  return [...globSync(config.overrides.flatMap((override) => override.files), {
    cwd: directory,
    exclude: config.ignorePatterns,
  })].sort();
}

// Oxlint honors disable comments in its typed pass. The old ESLint pass used
// --no-inline-config so a syntax-lint directive could not hide a lost receiver.
// Check parsed comments independently: even a file-wide disable cannot disable
// this guard, and strings, regexes and templates are never mistaken for comments.
export function typedSuppressionLines(filename, source) {
  if (!source.includes("eslint") && !source.includes("oxlint")) return [];
  const { comments } = parseSync(filename, source);
  return comments.filter(({ value }) => {
    const directive = value.split("--")[0].trim();
    const disable = /^(?:eslint|oxlint)-disable(?:-next-line|-line)?(?:\s+([\s\S]*))?$/.exec(directive);
    if (disable) {
      const rules = (disable[1] ?? "").trim().split(/[,\s]+/).filter(Boolean);
      return rules.length === 0 || rules.some((rule) =>
        rule === "unbound-method" || rule.endsWith("/unbound-method"));
    }
    return /^eslint\s/.test(directive) && directive.includes("unbound-method");
  }).map(({ start }) => source.slice(0, start).split("\n").length);
}

export function checkTypedSuppressions(directory = root) {
  const failures = [];
  for (const filename of typedLintFiles(directory)) {
    const source = readFileSync(resolve(directory, filename), "utf8");
    for (const line of typedSuppressionLines(filename, source)) {
      failures.push(`${filename}:${line}: typed lint cannot be suppressed inline; preserve the method receiver.`);
    }
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkTypedSuppressions();
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    process.exitCode = runOxlint("oxlint.typed.json", [
      "packages", ...globSync("apps/*/src", { cwd: root }),
    ]);
  }
}
