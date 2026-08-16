import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ignoredDirectories = new Set([
  ".git",
  ".agents",
  ".claude",
  ".local",
  ".vale",
  "node_modules",
  "out",
  "dist",
  "release-stage",
]);
const ignoredPrefixes = ["docs/plans/", "docs/brainstorms/", "docs/solutions/"];

function collectMarkdownFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(path, files);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const relativePath = relative(process.cwd(), path);
      if (!ignoredPrefixes.some((prefix) => relativePath.startsWith(prefix))) {
        files.push(relativePath);
      }
    }
  }
  return files;
}

const files = collectMarkdownFiles(".").sort();
const githubAnnotations = process.argv.includes("--github-annotations");
const minAlertLevel =
  process.argv.find((argument) => argument.startsWith("--minAlertLevel="))
  ?? "--minAlertLevel=warning";
const output = githubAnnotations ? "JSON" : "line";
const result = spawnSync(
  "vale",
  ["--config=.vale.ini", minAlertLevel, "--output=" + output, ...files],
  { encoding: "utf8" },
);

if (result.error?.code === "ENOENT") {
  console.error(
    "Vale is required for prose linting. Install it from https://vale.sh/docs/ or use the CI workflow.",
  );
  process.exit(1);
}

if (result.error) {
  throw result.error;
}

if (!githubAnnotations) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} else if (result.stdout.trim()) {
  const findings = JSON.parse(result.stdout);
  for (const [file, entries] of Object.entries(findings)) {
    for (const finding of entries) {
      const command = finding.Severity === "suggestion" ? "notice" : "warning";
      const message = `${finding.Check}: ${finding.Message}`
        .replace(/%/g, "%25")
        .replace(/\r/g, "%0D")
        .replace(/\n/g, "%0A")
        .replace(/:/g, "%3A");
      const column = finding.Span?.[0] ?? 1;
      console.log(`::${command} file=${file},line=${finding.Line},col=${column}::${message}`);
    }
  }
}

if (result.status !== 0) {
  process.exit(result.status);
}

console.log(`Vale checked ${files.length} Markdown files.`);
