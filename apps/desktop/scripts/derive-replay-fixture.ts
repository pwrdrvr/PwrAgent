import path from "node:path";
import {
  deriveReplayFixtureFromCapture,
  type DeriveReplayFixtureOptions,
  type StringReplacement,
  writeReplayFixtureArtifacts,
} from "../src/main/testing/fixture-derivation";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const inputPath = requireString(args, "input");
  const outputDir = requireString(args, "output-dir");
  const scenario = requireString(args, "scenario");

  const options: DeriveReplayFixtureOptions = {
    capturePath: path.resolve(inputPath),
    scenario,
    backend: parseBackend(args.backend),
    sourceCaptureId: optionalString(args["source-capture-id"]),
    threadId: optionalString(args["thread-id"]),
    startSequence: parseInteger(args.start, "start"),
    endSequence: parseInteger(args.end, "end"),
    stepLabels: parseLabels(args.label),
    redactions: parseRedactions(args.redact),
  };

  const { fixture, rawCaptureRecords } = await deriveReplayFixtureFromCapture(
    options
  );
  const outputs = await writeReplayFixtureArtifacts({
    outputDir: path.resolve(outputDir),
    fixture,
    rawCaptureRecords,
  });

  console.log(`Wrote replay fixture: ${outputs.fixturePath}`);
  console.log(`Wrote raw capture: ${outputs.rawCapturePath}`);
  console.log(
    `Derived ${fixture.steps.length} replay steps from ${rawCaptureRecords.length} capture records`
  );
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

function parseInteger(
  values: string[] | undefined,
  name: string
): number | undefined {
  const value = optionalString(values);
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }

  return parsed;
}

function parseBackend(
  values: string[] | undefined
): "codex" | "grok" | undefined {
  const value = optionalString(values);
  if (!value) {
    return undefined;
  }
  if (value !== "codex" && value !== "grok") {
    throw new Error("--backend must be codex or grok");
  }
  return value;
}

function parseLabels(values: string[] | undefined): Record<number, string> | undefined {
  if (!values?.length) {
    return undefined;
  }

  const output: Record<number, string> = {};
  for (const value of values) {
    const separatorIndex = value.indexOf("=");
    if (separatorIndex < 1) {
      throw new Error(
        `Invalid --label ${value}. Use --label <sequence>=<step-id>`
      );
    }

    const sequence = Number.parseInt(value.slice(0, separatorIndex), 10);
    const label = value.slice(separatorIndex + 1).trim();
    if (!Number.isInteger(sequence) || sequence < 1 || !label) {
      throw new Error(
        `Invalid --label ${value}. Use --label <sequence>=<step-id>`
      );
    }

    output[sequence] = label;
  }

  return output;
}

function parseRedactions(values: string[] | undefined): StringReplacement[] | undefined {
  if (!values?.length) {
    return undefined;
  }

  return values.map((value) => {
    const separatorIndex = value.indexOf("=");
    if (separatorIndex < 0) {
      throw new Error(
        `Invalid --redact ${value}. Use --redact <match>=<replace>`
      );
    }

    return {
      match: value.slice(0, separatorIndex),
      replace: value.slice(separatorIndex + 1),
    };
  });
}

function printUsage(): void {
  console.log(`Usage:
  pnpm --filter @pwragnt/desktop derive:replay-fixture -- \\
    --input /path/to/raw.capture.jsonl \\
    --output-dir apps/desktop/e2e/fixtures/example \\
    --scenario example-scenario \\
    [--backend codex] \\
    [--thread-id thread-123] \\
    [--source-capture-id capture-123] \\
    [--start 10] \\
    [--end 40] \\
    [--label 12=initialize-1] \\
    [--redact /Users/me=/repo]`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
