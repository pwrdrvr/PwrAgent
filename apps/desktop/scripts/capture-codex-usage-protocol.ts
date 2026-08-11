import fs from "node:fs/promises";
import path from "node:path";
import type {
  BackendAccountSummary,
  BackendRateLimitSummary,
} from "@pwragent/shared";
import { CodexAppServerClient } from "../src/main/codex-app-server/client";
import { ProtocolCaptureStore } from "../src/main/testing/capture-store";
import { createProtocolCaptureObserver } from "../src/main/testing/protocol-capture";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PROMPT =
  "Return a JSON object whose status is exactly: usage capture complete.";
const PROBE_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: {
      type: "string",
      const: "usage capture complete",
    },
  },
} as const;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const captureRoot = path.resolve(
    optionalString(args["capture-root"])
      ?? path.join(process.cwd(), ".local", "protocol-captures"),
  );
  const timeoutMs = optionalPositiveInteger(args["timeout-ms"]) ?? DEFAULT_TIMEOUT_MS;
  const prompt = optionalString(args.prompt) ?? DEFAULT_PROMPT;
  const codexHome = optionalString(args["codex-home"]);
  const captureId = [
    new Date().toISOString().replace(/[:.]/g, "-"),
    "codex-usage-probe",
  ].join("-");
  const store = new ProtocolCaptureStore({
    backend: "codex",
    backendInstance: "usage-probe",
    captureId,
    rootDir: captureRoot,
  });
  const client = new CodexAppServerClient({
    command: optionalString(args.command) ?? "codex",
    connectionObserver: createProtocolCaptureObserver({
      backend: "codex",
      store,
    }),
    env: codexHome
      ? {
          ...process.env,
          CODEX_HOME: path.resolve(codexHome),
        }
      : process.env,
    requestTimeoutMs: timeoutMs,
  });

  client.onRequest(() => ({ decision: "decline" }));

  let accountBefore: BackendAccountSummary | undefined;
  let rateLimitsBefore: BackendRateLimitSummary[] = [];
  let accountAfter: BackendAccountSummary | undefined;
  let rateLimitsAfter: BackendRateLimitSummary[] = [];
  let accountUsageBefore: unknown;
  let accountUsageAfter: unknown;
  let probe: Awaited<ReturnType<CodexAppServerClient["generateStructuredObject"]>> | undefined;

  try {
    accountBefore = await client.readAccount();
    rateLimitsBefore = await client.readRateLimits();
    accountUsageBefore = await readOptionalAccountUsage(client);
    probe = await client.generateStructuredObject({
      prompt,
      schema: PROBE_RESPONSE_SCHEMA,
      isMatch: (record) => record.status === "usage capture complete",
      timeoutMs,
    });
    accountAfter = await client.readAccount();
    rateLimitsAfter = await client.readRateLimits();
    accountUsageAfter = await readOptionalAccountUsage(client);
  } finally {
    await client.close().catch(() => undefined);
    await store.close();
  }

  const captureStats = await fs.stat(store.captureFilePath);
  const summary = {
    capturePath: store.captureFilePath,
    captureBytes: captureStats.size,
    probe,
    accountBefore: summarizeAccount(accountBefore),
    rateLimitsBefore,
    accountUsageBefore: summarizeAccountUsage(accountUsageBefore),
    accountAfter: summarizeAccount(accountAfter),
    rateLimitsAfter,
    accountUsageAfter: summarizeAccountUsage(accountUsageAfter),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function readOptionalAccountUsage(
  client: CodexAppServerClient,
): Promise<unknown> {
  try {
    return await client.readAccountUsage();
  } catch (error) {
    return {
      unavailable: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeAccountUsage(value: unknown): Record<string, unknown> {
  const root = asRecord(value);
  const summary = asRecord(root?.summary);
  const dailyUsageBuckets = Array.isArray(root?.dailyUsageBuckets)
    ? root.dailyUsageBuckets
    : undefined;
  if (root?.unavailable === true) {
    return {
      available: false,
      error: readString(root.error),
    };
  }
  return {
    available: Boolean(root),
    responseKeys: root ? Object.keys(root).sort() : [],
    summary: summary
      ? {
          lifetimeTokens: readFiniteNumber(summary.lifetimeTokens),
          peakDailyTokens: readFiniteNumber(summary.peakDailyTokens),
          longestRunningTurnSec: readFiniteNumber(summary.longestRunningTurnSec),
          currentStreakDays: readFiniteNumber(summary.currentStreakDays),
          longestStreakDays: readFiniteNumber(summary.longestStreakDays),
        }
      : undefined,
    dailyUsageBucketCount: dailyUsageBuckets?.length,
  };
}

function summarizeAccount(account: BackendAccountSummary | undefined): {
  type?: BackendAccountSummary["type"];
  planType?: string;
  requiresOpenaiAuth?: boolean;
  emailPresent: boolean;
} {
  return {
    type: account?.type,
    planType: account?.planType,
    requiresOpenaiAuth: account?.requiresOpenaiAuth,
    emailPresent: Boolean(account?.email),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function optionalString(values: string[] | undefined): string | undefined {
  const value = values?.at(-1)?.trim();
  return value ? value : undefined;
}

function optionalPositiveInteger(values: string[] | undefined): number | undefined {
  const value = optionalString(values);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

function printUsage(): void {
  const exampleRoot = path.join(".local", "protocol-captures");
  console.log(`Usage:
  pnpm --filter @pwragent/desktop capture:codex-usage -- \\
    --codex-home /path/to/codex-profile \\
    --capture-root ${exampleRoot}

The harness records every Codex App Server JSON-RPC frame while it:
  1. reads account, rate-limit, and usage state,
  2. starts one isolated ephemeral helper thread with profile capabilities disabled,
  3. runs one structured no-tools turn, and
  4. reads account, rate-limit, and usage state again.

Options:
  --codex-home <path>   Override CODEX_HOME for the app-server process.
  --capture-root <path> Output directory (default: ${exampleRoot}).
  --prompt <text>       Override the isolated probe prompt.
  --command <path>      Codex CLI command (default: codex).
  --timeout-ms <ms>     Request and turn timeout (default: ${DEFAULT_TIMEOUT_MS}).
  --help                Show this help.

Captures can contain account identity, paths, prompts, and model output. Keep
them under .local/ (gitignored), inspect them before sharing, and never commit
raw captures.`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
