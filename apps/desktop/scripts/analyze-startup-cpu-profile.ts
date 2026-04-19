import path from "node:path";
import { analyzeStartupCpuProfileSession } from "../src/main/diagnostics/startup-cpu-analysis";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const sessionDir = requireString(args, "session-dir");
  const repoRoot = path.resolve(optionalString(args["repo-root"]) ?? process.cwd());
  const sessionDirectoryPath = path.resolve(sessionDir);

  const result = await analyzeStartupCpuProfileSession({
    sessionDirectoryPath,
    repoRoot,
    analysisPath: path.join(sessionDirectoryPath, "analysis.json"),
    summaryPath: path.join(sessionDirectoryPath, "summary.md"),
  });

  console.log(`Analyzed startup CPU session: ${result.sessionDirectoryPath}`);
  console.log(`Wrote ${result.analysisPath}`);
  console.log(`Wrote ${result.summaryPath}`);
}

type ParsedArgs = Record<string, string[]>;

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = ["true"];
      continue;
    }

    parsed[key] ??= [];
    parsed[key].push(next);
    index += 1;
  }

  return parsed;
}

function requireString(args: ParsedArgs, key: string): string {
  const value = optionalString(args[key]);
  if (!value) {
    throw new Error(`Missing required --${key}`);
  }

  return value;
}

function optionalString(values: string[] | undefined): string | undefined {
  const value = values?.at(-1)?.trim();
  return value ? value : undefined;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm --filter @pwragnt/desktop analyze:startup-cpu-profile -- \\
    --session-dir .local/startup-cpu-2026-04-19-0930-abc123

Optional:
  --repo-root /absolute/path/to/repo`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
