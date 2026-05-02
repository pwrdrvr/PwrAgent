import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getMainLogger } from "../log";

export type ProtocolCaptureEventRecord = {
  backend: "codex" | "grok";
  backendInstance?: string;
  captureId: string;
  diagnostics?: ProtocolCaptureDiagnostics;
  direction: "inbound" | "outbound";
  kind: "request" | "response" | "notification";
  method?: string;
  id?: string;
  sequence: number;
  timestamp: number;
  threadIds: string[];
  raw: string;
};

export type ProtocolCaptureDiagnostics = {
  callerReason?: string;
  ownerId?: string;
};

export type ProtocolCaptureStringReplacement = {
  match: string;
  replace: string;
};

export type ProtocolCaptureEnvelope = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

export type CapturedProtocolEnvelopeRecord = {
  record: ProtocolCaptureEventRecord;
  envelope: ProtocolCaptureEnvelope;
};

type CaptureIndexEntry = {
  backend: "codex" | "grok";
  backendInstance?: string;
  captureId: string;
  createdAt: number;
  path: string;
  threadIds: string[];
  updatedAt: number;
};

const indexWriteQueues = new Map<string, Promise<void>>();
const protocolCaptureLog = getMainLogger("pwragnt:protocol-capture");

export async function readProtocolCaptureFile(
  filePath: string,
  redactions: ProtocolCaptureStringReplacement[] = [],
): Promise<CapturedProtocolEnvelopeRecord[]> {
  const contents = await fs.readFile(filePath, "utf8");
  const output: CapturedProtocolEnvelopeRecord[] = [];

  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid JSONL record ${index + 1} in ${filePath}: ${String(error)}`,
      );
    }

    const redactedRecord = applyReplacements(parsedLine, redactions) as ProtocolCaptureEventRecord;
    const record = validateCaptureRecord(redactedRecord, filePath, index + 1);
    const envelope = parseProtocolCaptureEnvelope(record.raw, filePath, record.sequence);

    output.push({
      record,
      envelope,
    });
  }

  return output.sort((left, right) => left.record.sequence - right.record.sequence);
}

export class ProtocolCaptureStore {
  private sequence = 0;
  private readonly threadIds = new Set<string>();
  private readonly createdAt: number;
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(
    private readonly params: {
      backend: "codex" | "grok";
      backendInstance?: string;
      captureId: string;
      rootDir: string;
    }
  ) {
    this.createdAt = Date.now();
  }

  get captureFilePath(): string {
    return path.join(this.params.rootDir, `${this.params.captureId}.jsonl`);
  }

  get indexFilePath(): string {
    return path.join(this.params.rootDir, "index.json");
  }

  async append(params: {
    direction: "inbound" | "outbound";
    diagnostics?: ProtocolCaptureDiagnostics;
    raw: string;
    envelope: {
      id?: string | number | null;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
  }): Promise<ProtocolCaptureEventRecord> {
    const record: ProtocolCaptureEventRecord = {
      backend: this.params.backend,
      backendInstance: this.params.backendInstance,
      captureId: this.params.captureId,
      diagnostics: normalizeDiagnostics(params.diagnostics),
      direction: params.direction,
      kind: getEnvelopeKind(params.envelope),
      method: params.envelope.method?.trim() || undefined,
      id:
        params.envelope.id === null || params.envelope.id === undefined
          ? undefined
          : String(params.envelope.id),
      sequence: ++this.sequence,
      timestamp: Date.now(),
      threadIds: extractThreadIds(params.envelope),
      raw: params.raw
    };

    for (const threadId of record.threadIds) {
      this.threadIds.add(threadId);
    }

    const nextWrite = this.writeQueue.then(async () => {
      await this.ensureInitialized();
      await fs.appendFile(this.captureFilePath, `${JSON.stringify(record)}\n`, "utf8");
      await this.writeIndexQueued();
    });
    this.writeQueue = nextWrite;
    await nextWrite;

    return record;
  }

  async close(): Promise<void> {
    await this.writeQueue;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(this.params.rootDir, { recursive: true });
    await this.writeIndexQueued();
    this.initialized = true;
  }

  private async writeIndexQueued(): Promise<void> {
    const previousWrite = indexWriteQueues.get(this.indexFilePath) ?? Promise.resolve();
    const nextWrite = previousWrite
      .catch(() => undefined)
      .then(() => this.writeIndex());
    indexWriteQueues.set(this.indexFilePath, nextWrite);

    try {
      await nextWrite;
    } finally {
      if (indexWriteQueues.get(this.indexFilePath) === nextWrite) {
        indexWriteQueues.delete(this.indexFilePath);
      }
    }
  }

  private async writeIndex(): Promise<void> {
    const current = await readIndex(this.indexFilePath);
    const nextEntry: CaptureIndexEntry = {
      backend: this.params.backend,
      backendInstance: this.params.backendInstance,
      captureId: this.params.captureId,
      createdAt: this.createdAt,
      path: this.captureFilePath,
      threadIds: [...this.threadIds].sort(),
      updatedAt: Date.now()
    };
    current[this.params.captureId] = nextEntry;
    await writeJsonFileAtomically(this.indexFilePath, current);
  }
}

async function readIndex(filePath: string): Promise<Record<string, CaptureIndexEntry>> {
  let contents: string;
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }

  if (!contents.trim()) {
    protocolCaptureLog.warn("protocol capture index was empty; resetting index", {
      path: filePath
    });
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    protocolCaptureLog.warn("protocol capture index was invalid JSON; resetting index", {
      path: filePath,
      error: message
    });
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    protocolCaptureLog.warn("protocol capture index had unexpected shape; resetting index", {
      path: filePath
    });
    return {};
  }
  return parsed as Record<string, CaptureIndexEntry>;
}

async function writeJsonFileAtomically(
  filePath: string,
  value: Record<string, CaptureIndexEntry>,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

function getEnvelopeKind(envelope: {
  id?: string | number | null;
  method?: string;
  result?: unknown;
  error?: unknown;
}): "request" | "response" | "notification" {
  if (envelope.method?.trim()) {
    return envelope.id === null || envelope.id === undefined ? "notification" : "request";
  }

  if (envelope.id !== null && envelope.id !== undefined) {
    return "response";
  }

  return "notification";
}

function validateCaptureRecord(
  value: ProtocolCaptureEventRecord,
  filePath: string,
  lineNumber: number,
): ProtocolCaptureEventRecord {
  if (value.backend !== "codex" && value.backend !== "grok") {
    throw new Error(
      `Invalid capture record ${lineNumber} in ${filePath}: unsupported backend`,
    );
  }
  if (!value.captureId?.trim()) {
    throw new Error(
      `Invalid capture record ${lineNumber} in ${filePath}: missing captureId`,
    );
  }
  if (value.direction !== "inbound" && value.direction !== "outbound") {
    throw new Error(
      `Invalid capture record ${lineNumber} in ${filePath}: unsupported direction`,
    );
  }
  if (
    value.kind !== "request" &&
    value.kind !== "response" &&
    value.kind !== "notification"
  ) {
    throw new Error(
      `Invalid capture record ${lineNumber} in ${filePath}: unsupported kind`,
    );
  }
  if (
    typeof value.sequence !== "number" ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 1
  ) {
    throw new Error(
      `Invalid capture record ${lineNumber} in ${filePath}: missing sequence`,
    );
  }
  if (!Array.isArray(value.threadIds)) {
    throw new Error(
      `Invalid capture record ${lineNumber} in ${filePath}: missing threadIds`,
    );
  }
  if (typeof value.raw !== "string" || !value.raw.trim()) {
    throw new Error(
      `Invalid capture record ${lineNumber} in ${filePath}: missing raw envelope`,
    );
  }

  return value;
}

function parseProtocolCaptureEnvelope(
  raw: string,
  filePath: string,
  sequence: number,
): ProtocolCaptureEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON-RPC envelope for sequence ${sequence} in ${filePath}: ${String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Invalid JSON-RPC envelope for sequence ${sequence} in ${filePath}: expected object`,
    );
  }

  return parsed as ProtocolCaptureEnvelope;
}

function normalizeDiagnostics(
  diagnostics: ProtocolCaptureDiagnostics | undefined,
): ProtocolCaptureDiagnostics | undefined {
  const callerReason = diagnostics?.callerReason?.trim();
  const ownerId = diagnostics?.ownerId?.trim();
  if (!callerReason && !ownerId) {
    return undefined;
  }

  return {
    ...(callerReason ? { callerReason } : {}),
    ...(ownerId ? { ownerId } : {}),
  };
}

function extractThreadIds(envelope: {
  params?: unknown;
  result?: unknown;
  error?: unknown;
}): string[] {
  const found = new Set<string>();

  visit(envelope.params, found);
  visit(envelope.result, found);
  visit(envelope.error, found);

  return [...found].sort();
}

function visit(value: unknown, found: Set<string>): void {
  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      visit(entry, found);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  const directThreadId = record.threadId;
  if (typeof directThreadId === "string" && directThreadId.trim()) {
    found.add(directThreadId.trim());
  }

  const threadRecord = record.thread;
  if (threadRecord && typeof threadRecord === "object" && !Array.isArray(threadRecord)) {
    const nestedThreadId = (threadRecord as Record<string, unknown>).id;
    if (typeof nestedThreadId === "string" && nestedThreadId.trim()) {
      found.add(nestedThreadId.trim());
    }
  }

  for (const nested of Object.values(record)) {
    visit(nested, found);
  }
}

function applyReplacements(
  value: unknown,
  replacements: ProtocolCaptureStringReplacement[],
): unknown {
  if (replacements.length === 0) {
    return value;
  }

  if (typeof value === "string") {
    return replacements.reduce((current, replacement) => {
      if (!replacement.match) {
        return current;
      }
      return current.split(replacement.match).join(replacement.replace);
    }, value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => applyReplacements(entry, replacements));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      applyReplacements(entryValue, replacements),
    ]),
  );
}
