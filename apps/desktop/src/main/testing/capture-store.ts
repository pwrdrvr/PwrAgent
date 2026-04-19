import fs from "node:fs/promises";
import path from "node:path";

export type ProtocolCaptureEventRecord = {
  backend: "codex" | "grok";
  captureId: string;
  direction: "inbound" | "outbound";
  kind: "request" | "response" | "notification";
  method?: string;
  id?: string;
  sequence: number;
  timestamp: number;
  threadIds: string[];
  raw: string;
};

type CaptureIndexEntry = {
  backend: "codex" | "grok";
  captureId: string;
  createdAt: number;
  path: string;
  threadIds: string[];
  updatedAt: number;
};

export class ProtocolCaptureStore {
  private sequence = 0;
  private readonly threadIds = new Set<string>();
  private readonly createdAt: number;
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(
    private readonly params: {
      backend: "codex" | "grok";
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
      captureId: this.params.captureId,
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
      await this.writeIndex();
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
    await this.writeIndex();
    this.initialized = true;
  }

  private async writeIndex(): Promise<void> {
    const current = await readIndex(this.indexFilePath);
    const nextEntry: CaptureIndexEntry = {
      backend: this.params.backend,
      captureId: this.params.captureId,
      createdAt: this.createdAt,
      path: this.captureFilePath,
      threadIds: [...this.threadIds].sort(),
      updatedAt: Date.now()
    };
    current[this.params.captureId] = nextEntry;
    await fs.writeFile(this.indexFilePath, JSON.stringify(current, null, 2), "utf8");
  }
}

async function readIndex(filePath: string): Promise<Record<string, CaptureIndexEntry>> {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(contents) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, CaptureIndexEntry>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
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
