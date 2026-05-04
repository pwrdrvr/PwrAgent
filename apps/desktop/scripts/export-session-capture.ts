import path from "node:path";
import {
  exportSessionCapture,
  type ExportSessionCaptureOptions,
} from "../src/main/testing/fixture-derivation";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const captureRoot =
    optionalString(args["capture-root"])
    ?? process.env.PWRAGENT_PROTOCOL_CAPTURE_ROOT?.trim();
  if (!captureRoot) {
    throw new Error(
      "Missing --capture-root and PWRAGENT_PROTOCOL_CAPTURE_ROOT is not set"
    );
  }

  const outputPath = requireString(args, "output");
  const options: ExportSessionCaptureOptions = {
    captureRoot: path.resolve(captureRoot),
    outputPath: path.resolve(outputPath),
    captureId: optionalString(args["capture-id"]),
    sessionId: optionalString(args.session),
    threadId: optionalString(args.thread),
    backend: parseBackend(args.backend),
  };

  const exported = await exportSessionCapture(options);
  console.log(`Exported ${exported.captureId} to ${exported.outputPath}`);
  console.log(`Source capture: ${exported.sourcePath}`);
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

function printUsage(): void {
  console.log(`Usage:
  pnpm --filter @pwragent/desktop export:session-capture -- \\
    --capture-root /path/to/protocol-captures \\
    --session codex:thread-123 \\
    --output /tmp/thread-123.raw.capture.jsonl

  Or:
  pnpm --filter @pwragent/desktop export:session-capture -- \\
    --capture-root /path/to/protocol-captures \\
    --capture-id 2026-04-18T15-00-00-000Z-codex \\
    --output /tmp/session.raw.capture.jsonl`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
