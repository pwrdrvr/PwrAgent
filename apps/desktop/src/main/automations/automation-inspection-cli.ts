import type {
  AppServerBackendKind,
  AutomationInspectionOperationName,
  AutomationInspectionRequest,
  AutomationInspectionResponse,
  BackendAcpRuntimeCapabilities,
} from "@pwragent/shared";
import { AUTOMATION_INSPECTION_TOOL_NAMESPACE } from "@pwragent/shared";
import type { AutomationInspectionHandler } from "./automation-inspection-codex-tools.js";
import { isAutomationInspectionMcpToolName } from "./automation-inspection-mcp.js";

export const AUTOMATION_INSPECTION_MCP_COMMAND_ENV =
  "PWRAGENT_AUTOMATION_INSPECTION_MCP_COMMAND";

export type AcpMcpServerConfig = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type AutomationInspectionCliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function resolveAutomationInspectionMcpCommand(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[AUTOMATION_INSPECTION_MCP_COMMAND_ENV]?.trim() || undefined;
}

export function acpRuntimeSupportsAutomationInspectionMcp(
  runtimeCapabilities: BackendAcpRuntimeCapabilities | undefined,
): boolean {
  const mcp = runtimeCapabilities?.agentCapabilities?.mcp;
  return mcp?.http === true || mcp?.sse === true;
}

export function buildAutomationInspectionAcpMcpServers(params: {
  backend: AppServerBackendKind;
  command?: string;
  env?: Record<string, string | undefined>;
  runtimeCapabilities?: BackendAcpRuntimeCapabilities;
  threadId?: string;
}): AcpMcpServerConfig[] {
  if (
    !params.threadId ||
    !params.command ||
    !acpRuntimeSupportsAutomationInspectionMcp(params.runtimeCapabilities)
  ) {
    return [];
  }
  return [
    {
      name: AUTOMATION_INSPECTION_TOOL_NAMESPACE,
      command: params.command,
      args: [
        "automation-inspection-mcp",
        "--backend",
        params.backend,
        "--thread-id",
        params.threadId,
      ],
      env: compactEnv({
        ...params.env,
        PWRAGENT_AUTOMATION_BACKEND: params.backend,
        PWRAGENT_AUTOMATION_THREAD_ID: params.threadId,
      }),
    },
  ];
}

export async function runAutomationInspectionCli(params: {
  argv: string[];
  handler: AutomationInspectionHandler | undefined;
}): Promise<AutomationInspectionCliResult> {
  const parsed = parseAutomationInspectionCliArgs(params.argv);
  if (!parsed.ok) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${parsed.error}\n`,
    };
  }
  if (!params.handler) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "PwrAgent automation inspection is not available.\n",
    };
  }
  const response = await params.handler({
    operation: parsed.operation,
    context: {
      backend: parsed.backend,
      threadId: parsed.threadId,
    },
    args: parsed.args,
  } as AutomationInspectionRequest);
  return responseToCliResult(response);
}

function responseToCliResult(
  response: AutomationInspectionResponse,
): AutomationInspectionCliResult {
  const payload = response.ok ? response.data : response.error;
  return {
    exitCode: response.ok ? 0 : 1,
    stdout: `${JSON.stringify(payload, null, 2)}\n`,
    stderr: "",
  };
}

function parseAutomationInspectionCliArgs(argv: string[]):
  | {
      ok: true;
      operation: AutomationInspectionOperationName;
      backend: AppServerBackendKind;
      threadId: string;
      args: Record<string, unknown>;
    }
  | { ok: false; error: string } {
  const [operationValue, ...rest] = argv;
  if (!isAutomationInspectionMcpToolName(operationValue)) {
    return { ok: false, error: "Missing or unsupported automation inspection operation." };
  }
  const options = readOptions(rest);
  const backend = readString(options.backend);
  const threadId = readString(options["thread-id"] ?? options.threadId);
  if (!backend || !threadId) {
    return { ok: false, error: "Required options: --backend and --thread-id." };
  }
  const args = parseJsonObject(options.args, "args");
  if (!args.ok) {
    return args;
  }
  return {
    ok: true,
    operation: operationValue,
    backend: backend as AppServerBackendKind,
    threadId,
    args: args.value,
  };
}

function readOptions(argv: string[]): Record<string, string | undefined> {
  const options: Record<string, string | undefined> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = "true";
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function parseJsonObject(
  value: string | undefined,
  label: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!value) {
    return { ok: true, value: {} };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false, error: `--${label} must be a JSON object.` };
  } catch (error) {
    return {
      ok: false,
      error: `Invalid --${label} JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function compactEnv(
  env: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].length > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
