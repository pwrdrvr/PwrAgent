import path from "node:path";
import { analyzeProtocolCaptureTraffic } from "../src/main/testing/protocol-capture-analysis";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const inputPath = requireString(args, "input");
  const outputPath = optionalString(args.output);
  const analysis = await analyzeProtocolCaptureTraffic({
    capturePath: path.resolve(inputPath),
  });
  const serialized = `${JSON.stringify(analysis, null, 2)}\n`;

  if (outputPath) {
    const resolvedOutputPath = path.resolve(outputPath);
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(resolvedOutputPath, serialized, "utf8"),
    );
    console.log(`Wrote ${resolvedOutputPath}`);
    return;
  }

  process.stdout.write(serialized);
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
  pnpm --filter @pwragent/desktop analyze:protocol-capture -- \\
    --input .local/protocol-captures/2026-05-02T14-34-22-432Z-grok-default.jsonl

Optional:
  --output .local/protocol-capture-analysis.json`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
