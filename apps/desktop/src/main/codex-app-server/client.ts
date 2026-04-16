import path from "node:path";
import type {
  AppServerThreadSummary,
  LinkedDirectorySummary
} from "@pwragnt/shared";
import { JsonRpcConnection } from "./json-rpc";
import { StdioJsonRpcTransport } from "./stdio-transport";

const DEFAULT_PROTOCOL_VERSION = "1.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

type CodexClientOptions = {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
};

type CodexThreadSummary = Omit<AppServerThreadSummary, "source">;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickString(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function pickNumber(
  record: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function normalizeEpochTimestamp(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectText(entry));
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const directKeys = [
    "text",
    "message",
    "summary",
    "title",
    "content",
    "description",
    "reason"
  ];

  const output = directKeys.flatMap((key) => collectText(record[key]));
  for (const nestedKey of ["item", "thread", "response", "result", "data"]) {
    output.push(...collectText(record[nestedKey]));
  }
  return output;
}

function dedupeJoinedText(parts: string[]): string | undefined {
  const unique = [...new Set(parts.map((value) => value.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return undefined;
  }
  return unique.join("\n\n");
}

function extractThreadRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractThreadRecords(entry));
  }

  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const directId = pickString(record, ["id", "threadId", "thread_id", "conversationId"]);
  if (directId && !Array.isArray(record.items) && !Array.isArray(record.threads)) {
    return [record];
  }

  const output: Record<string, unknown>[] = [];
  for (const key of ["threads", "items", "data", "results"]) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      output.push(...nested.flatMap((entry) => extractThreadRecords(entry)));
    }
  }
  return output;
}

function isMethodUnavailableError(error: unknown, method?: string): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();

  if (normalized.includes("method not found") || normalized.includes("unknown method")) {
    return true;
  }

  if (!normalized.includes("unknown variant")) {
    return false;
  }

  if (!method) {
    return true;
  }

  return normalized.includes(`unknown variant \`${method.toLowerCase()}\``);
}

function deriveLinkedDirectories(projectKey?: string): LinkedDirectorySummary[] {
  if (!projectKey) {
    return [];
  }

  const normalizedPath = projectKey.trim();
  if (!normalizedPath) {
    return [];
  }

  return [
    {
      id: normalizedPath,
      path: normalizedPath,
      label: path.basename(normalizedPath) || normalizedPath
    }
  ];
}

function extractThreadsFromValue(value: unknown): CodexThreadSummary[] {
  const items = extractThreadRecords(value);
  const summaries = new Map<string, CodexThreadSummary>();

  for (const record of items) {
    const threadId =
      pickString(record, ["threadId", "thread_id", "id", "conversationId", "conversation_id"]) ??
      pickString(asRecord(record.thread) ?? {}, ["id", "threadId", "thread_id"]);

    if (!threadId) {
      continue;
    }

    const sessionRecord = asRecord(record.session);
    const projectKey =
      pickString(record, ["projectKey", "project_key", "cwd"]) ??
      pickString(sessionRecord ?? {}, ["cwd", "projectKey", "project_key"]);

    summaries.set(threadId, {
      id: threadId,
      title:
        pickString(record, ["title", "name", "headline"]) ??
        pickString(sessionRecord ?? {}, ["title", "name"]) ??
        "Untitled thread",
      summary:
        pickString(record, ["summary", "preview", "snippet", "text"]) ??
        dedupeJoinedText(collectText(record.messages ?? record.lastMessage ?? record.content)),
      linkedDirectories: deriveLinkedDirectories(projectKey),
      createdAt: normalizeEpochTimestamp(
        pickNumber(record, ["createdAt", "created_at"]) ??
          pickNumber(sessionRecord ?? {}, ["createdAt", "created_at"])
      ),
      updatedAt: normalizeEpochTimestamp(
        pickNumber(record, ["updatedAt", "updated_at", "lastActivityAt", "createdAt"]) ??
          pickNumber(sessionRecord ?? {}, ["updatedAt", "updated_at", "lastActivityAt"])
      ),
      gitBranch:
        pickString(asRecord(record.gitInfo) ?? {}, ["branch"]) ??
        pickString(asRecord(record.git_info) ?? {}, ["branch"]) ??
        pickString(asRecord(sessionRecord?.gitInfo) ?? {}, ["branch"]) ??
        pickString(asRecord(sessionRecord?.git_info) ?? {}, ["branch"])
    });
  }

  return [...summaries.values()].sort(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
  );
}

function buildThreadDiscoveryPayloads(filter?: string): unknown[] {
  return [
    {
      query: filter?.trim() || undefined,
      limit: 100
    },
    {
      filter: filter?.trim() || undefined,
      limit: 100
    },
    {}
  ];
}

async function requestWithFallbacks(params: {
  client: JsonRpcConnection;
  methods: string[];
  payloads: unknown[];
  timeoutMs: number;
}): Promise<unknown> {
  let lastError: unknown;

  for (const method of params.methods) {
    for (const payload of params.payloads) {
      try {
        return await params.client.request(method, payload, params.timeoutMs);
      } catch (error) {
        lastError = error;
        if (!isMethodUnavailableError(error, method)) {
          continue;
        }
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export class CodexAppServerClient {
  private readonly connection: JsonRpcConnection;
  private initialized = false;

  constructor(private readonly options: CodexClientOptions = {}) {
    this.connection = new JsonRpcConnection(
      new StdioJsonRpcTransport({
        command: options.command?.trim() || "codex",
        args: options.args ?? [],
        env: options.env
      }),
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    );
  }

  async close(): Promise<void> {
    this.initialized = false;
    await this.connection.close();
  }

  async listThreads(params?: { filter?: string }): Promise<AppServerThreadSummary[]> {
    await this.ensureInitialized();

    const result = await requestWithFallbacks({
      client: this.connection,
      methods: ["thread/list", "thread/loaded/list"],
      payloads: buildThreadDiscoveryPayloads(params?.filter),
      timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    });

    return extractThreadsFromValue(result).map((thread) => ({
      ...thread,
      source: "codex"
    }));
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.connection.connect();
    await this.connection.request("initialize", {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      clientInfo: { name: "pwragnt-desktop", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    await this.connection.notify("initialized", {});
    this.initialized = true;
  }
}
