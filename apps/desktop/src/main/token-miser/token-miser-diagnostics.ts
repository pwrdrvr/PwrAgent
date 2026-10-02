import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { takeUtf8Prefix, utf8ByteLength, type TokenMiserObjectMetadata, type TokenMiserSummary } from "./token-miser-types";

const FLUSH_MS = 30_000;
const WINDOW_MS = 90_000;
const RETRY_MS = 45_000;
const MEMORY_BYTES = 8 * 1024 * 1024;
const QUEUE_BYTES = 4 * 1024 * 1024;
const FILE_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 32;

export type TokenMiserDiagnosticContext = {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
};
export type TokenMiserDiagnosticInvocation = {
  threadId: string;
  turnId: string;
  callId: string;
  toolName: string;
  input: string;
  output: string;
  codeMode: boolean;
};
export type TokenMiserDiagnosticGate = {
  metadata: TokenMiserObjectMetadata;
  before: ReturnType<typeof diagnosticExcerpt>;
  delivered: ReturnType<typeof diagnosticExcerpt>;
  summary: TokenMiserSummary;
  summaryExcerpt?: ReturnType<typeof diagnosticExcerpt>;
  input?: string;
  inputExcerpt?: ReturnType<typeof diagnosticExcerpt>;
  invocationCount?: number;
  invocations?: Array<{ toolName: string; toolInput: string; excerpt?: ReturnType<typeof diagnosticExcerpt>; identity?: { family: string; signature: string } }>;
  context?: TokenMiserDiagnosticContext;
};
type Event = { sequence: number; timestamp: number; turnId: string; kind: string; data: Record<string, unknown>; bytes: number };
type Anchor = {
  objectId: string; sequence: number; timestamp: number; families: Set<string>; signatures: Set<string>;
  repeats: number; exactRepeats: number; actions: number; summarized: boolean;
  retrievedBytes: number; burstId?: string;
  context?: TokenMiserDiagnosticContext;
};
type Thread = {
  events: Event[]; anchors: Anchor[]; context?: TokenMiserDiagnosticContext;
  burst?: { id: string; family: string; lastAt: number; recordedThrough: number; startedAt: number; firstSequence: number; objectId: string };
};

function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
export function diagnosticExcerpt(text: string, limit: number) {
  const bytes = utf8ByteLength(text);
  if (bytes <= limit) return { text, bytes, truncated: false };
  // Explicit head/tail coverage; never imply a full original survived clipping.
  const marker = "\n[middle omitted]\n";
  const partBytes = Math.max(0, Math.floor((limit - utf8ByteLength(marker)) / 2));
  const head = takeUtf8Prefix(text, partBytes);
  const buffer = Buffer.from(text);
  let tailStart = Math.max(0, buffer.length - partBytes);
  while (tailStart < buffer.length && (buffer[tailStart] & 0xc0) === 0x80) tailStart++;
  const tail = buffer.subarray(tailStart).toString("utf8");
  return { text: `${head}${marker}${tail}`, bytes, truncated: true, sha256: digest(text) };
}
const excerpt = diagnosticExcerpt;
export function diagnosticInvocationIdentity(toolName: string, input: string) {
  const name = toolName.replace(/^.*[._](?=exec_command|write_stdin|read_\w+_token_miser|search_token_miser)/, "");
  let command = "";
  try {
    const args = JSON.parse(input) as { cmd?: string; command?: string };
    command = typeof (args.cmd ?? args.command) === "string" ? (args.cmd ?? args.command)! : "";
  } catch { /* The original input remains available as an excerpt. */ }
  const commandFamily = command.trim().match(/^(\S+)(?:\s+(\S+))?/);
  const family = `${name}:${commandFamily?.[1] ?? ""}${commandFamily?.[1] === "git" ? ` ${commandFamily[2] ?? ""}` : ""}`;
  return { family, signature: digest(`${toolName}\n${input}`) };
}

/** Opt-in PwrAgent-owned evidence. No Codex storage and no SQLite writes. */
export class TokenMiserDiagnostics {
  private readonly threads = new Map<string, Thread>();
  private readonly samples = new Map<string, number>();
  private queue: string[] = [];
  private queuedBytes = 0;
  private retainedBytes = 0;
  private sequence = 0;
  private dropped = 0;
  private timer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();
  private fileBytes?: number;
  private closed = false;

  constructor(private readonly options: {
    filePath: string;
    isEnabled: () => boolean;
    onError?: (error: unknown) => void;
    now?: () => number;
    sampleEvery?: number;
    memoryBytes?: number;
    queueBytes?: number;
    fileBytes?: number;
    append?: (file: string, data: string) => Promise<void>;
  }) {}

  isEnabled(): boolean { return this.enabled(); }

  private enabled(): boolean {
    if (this.closed) return false;
    if (this.settingEnabled()) {
      this.timer ??= setInterval(() => { void this.flush(); }, FLUSH_MS);
      this.timer.unref();
      return true;
    }
    this.clear();
    return false;
  }

  private settingEnabled(): boolean {
    try { return this.options.isEnabled(); } catch (error) { this.reportError(error); return false; }
  }

  private reportError(error: unknown): void {
    try { this.options.onError?.(error); } catch { /* Diagnostics must fail open. */ }
  }

  private clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.threads.clear();
    this.samples.clear();
    this.queue = [];
    this.queuedBytes = this.retainedBytes = 0;
  }

  recordInvocation(invocation: TokenMiserDiagnosticInvocation): void {
    if (!this.enabled()) return;
    const identity = diagnosticInvocationIdentity(invocation.toolName, invocation.input);
    const thread = this.threads.get(invocation.threadId);
    for (const anchor of thread?.anchors ?? []) {
      anchor.actions++;
      if (anchor.summarized && this.now() - anchor.timestamp <= RETRY_MS && anchor.families.has(identity.family)
        && !/write_stdin|\bwait\b|poll/.test(identity.family)) {
        anchor.repeats++;
        if (anchor.signatures.has(identity.signature)) anchor.exactRepeats++;
        if (anchor.repeats >= 3 && thread) {
          if (!thread.burst || thread.burst.family !== identity.family || this.now() - thread.burst.lastAt > RETRY_MS) {
            thread.burst = {
              id: randomUUID(), family: identity.family, lastAt: this.now(), recordedThrough: -1,
              startedAt: anchor.timestamp, firstSequence: anchor.sequence - 3, objectId: anchor.objectId,
            };
          }
          thread.burst.lastAt = this.now();
          anchor.burstId = thread.burst.id;
        }
      }
    }
    if (thread?.burst?.family === identity.family && this.now() - thread.burst.lastAt <= RETRY_MS) {
      thread.burst.lastAt = this.now();
    }
    const retrieval = /(?:read_all|read|search|summarize)_token_miser|read_token_miser_segment/.test(invocation.toolName);
    this.push(invocation.threadId, invocation.turnId, retrieval ? "retrieval_attempt" : "tool", {
      callId: invocation.callId, toolName: invocation.toolName, codeMode: invocation.codeMode,
      ...identity, input: excerpt(invocation.input, 8_192), output: excerpt(invocation.output, 8_192),
      retrievalMode: retrieval
        ? invocation.toolName.includes("read_all") ? "all_requested"
          : invocation.toolName.includes("summarize") ? "focused_summary_requested" : "some_requested"
        : undefined,
    });
  }

  recordGate(gate: TokenMiserDiagnosticGate): void {
    if (!this.enabled()) return;
    const m = gate.metadata;
    const thread = this.thread(m.threadId);
    thread.context = gate.context;
    const identities = (gate.invocations?.length ? gate.invocations : [{ toolName: m.toolName, toolInput: gate.input ?? "" }])
      .map((invocation) => invocation.identity ?? diagnosticInvocationIdentity(invocation.toolName, invocation.toolInput));
    const event = this.push(m.threadId, m.turnId, "gate", {
      objectId: m.objectId, callId: m.toolUseId, groupId: m.groupId,
      groupMemberCount: m.groupMembers?.length,
      members: m.groupMembers?.slice(0, 64).map((member) => ({ objectId: member.objectId, toolCallId: member.toolCallId, toolName: member.toolName })),
      toolName: m.toolName, codeMode: m.toolName === "Code Mode", disposition: m.disposition,
      context: gate.context, helper: m.helperUsage ? {
        model: m.helperUsage.model, reasoningEffort: m.helperUsage.reasoningEffort, serviceTier: m.helperUsage.serviceTier,
        usage: excerpt(JSON.stringify(m.helperUsage.tokenUsage ?? {}), 8_192),
      } : undefined,
      baselineParentTokens: m.baselineParentTokens, originalBytes: m.originalCharacters,
      replacementBytes: m.replacementCharacters,
      before: gate.before,
      delivered: m.disposition === "passed_through" ? { sameAsBefore: true } : gate.delivered,
      summary: gate.summaryExcerpt ?? excerpt(JSON.stringify(gate.summary), 8_192),
      input: gate.inputExcerpt ?? (gate.input ? excerpt(gate.input, 8_192) : undefined),
      invocationCount: gate.invocationCount ?? gate.invocations?.length,
      invocations: gate.invocations?.slice(0, 64).map((invocation) => ({ toolName: invocation.toolName, input: invocation.excerpt ?? excerpt(invocation.toolInput, 4_096) })),
    });
    if (!event) return;
    thread.anchors.push({
      objectId: m.objectId, sequence: event.sequence, timestamp: this.now(),
      families: new Set(identities.map((i) => i.family)), signatures: new Set(identities.map((i) => i.signature)),
      summarized: m.disposition === "summarized", repeats: 0, exactRepeats: 0, actions: 0, retrievedBytes: 0,
      context: gate.context,
      burstId: thread.burst && this.now() - thread.burst.lastAt <= RETRY_MS
        && identities.some((i) => i.family === thread.burst?.family) ? thread.burst.id : undefined,
    });
  }

  recordRetrieval(metadata: TokenMiserObjectMetadata): void {
    if (!this.enabled()) return;
    const anchor = this.threads.get(metadata.threadId)?.anchors.find((a) => a.objectId === metadata.objectId);
    if (!anchor || metadata.retrievedCharacters <= anchor.retrievedBytes) return;
    const deliveredBytes = metadata.retrievedCharacters - anchor.retrievedBytes;
    anchor.retrievedBytes = metadata.retrievedCharacters;
    this.push(metadata.threadId, metadata.turnId, "retrieval_delivered", {
      objectId: metadata.objectId, deliveredBytes, totalDeliveredBytes: metadata.retrievedCharacters,
      focusedSummaryBytes: metadata.focusedSummaryCharacters ?? 0,
    });
  }

  recordNarration(threadId: string, turnId: string, phase: unknown, text: string): void {
    if (phase !== "commentary" || !text || !this.enabled()) return;
    this.push(threadId, turnId, "commentary", { text: excerpt(text, 4_096) });
  }

  endTurn(threadId: string): void {
    if (!this.enabled()) return;
    this.seal(threadId, "turn_end", true);
    this.sealBurstTail(threadId, "turn_end");
    this.removeThread(threadId);
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private thread(id: string): Thread {
    let thread = this.threads.get(id);
    if (!thread) { thread = { events: [], anchors: [] }; this.threads.set(id, thread); }
    return thread;
  }
  private push(threadId: string, turnId: string, kind: string, data: Record<string, unknown>): Event | undefined {
    const thread = this.thread(threadId);
    this.seal(threadId, "observation_window");
    const event: Event = {
      sequence: ++this.sequence, timestamp: this.now(), turnId, kind,
      data: { context: thread.context, contextSource: "last_accepted_gate", ...data }, bytes: 0,
    };
    event.bytes = utf8ByteLength(JSON.stringify(event)) * 3;
    thread.events.push(event);
    this.retainedBytes += event.bytes;
    while (thread.events.length > MAX_EVENTS) {
      const oldest = thread.events[0];
      this.seal(threadId, "ring_limit", false, oldest.sequence);
      this.sealBurstTail(threadId, "ring_limit", oldest.sequence);
      thread.events.shift();
      this.retainedBytes -= oldest.bytes;
    }
    while (this.retainedBytes > (this.options.memoryBytes ?? MEMORY_BYTES) && this.threads.size) {
      const id = this.threads.keys().next().value!;
      this.seal(id, "memory_limit", true);
      this.sealBurstTail(id, "memory_limit");
      this.removeThread(id);
    }
    return this.threads.has(threadId) ? event : undefined;
  }
  private removeThread(id: string): void {
    const thread = this.threads.get(id);
    this.retainedBytes -= thread?.events.reduce((sum, event) => sum + event.bytes, 0) ?? 0;
    this.threads.delete(id);
  }
  private seal(threadId: string, reason: string, all = false, through = -1): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.anchors = thread.anchors.filter((anchor) => {
      if (!all && anchor.sequence > through && this.now() - anchor.timestamp < WINDOW_MS && anchor.actions < 12) return true;
      const category = anchor.burstId ? "suspected_retry_burst"
        : anchor.retrievedBytes > 0 ? "recovered" : anchor.summarized ? "summarized_no_recovery_observed" : "passed_through";
      const count = this.samples.get(category) ?? 0;
      this.samples.set(category, count + 1);
      if (anchor.burstId || count % (this.options.sampleEvery ?? 8) === 0) {
        const burst = anchor.burstId && thread.burst?.id === anchor.burstId ? thread.burst : undefined;
        const through = burst?.recordedThrough ?? -1;
        const events = thread.events.filter((event) => event.sequence >= anchor.sequence - 3 && event.sequence > through);
        if (!events.length) return false;
        if (burst) burst.recordedThrough = events[events.length - 1].sequence;
        const row = `${JSON.stringify({
          version: 1, kind: "token_miser_chain", captureId: randomUUID(), burstGroupId: anchor.burstId,
          backend: "codex", provider: anchor.context?.provider ?? "unknown", threadId,
          context: anchor.context, objectId: anchor.objectId,
          category, classification: "observational_heuristic_not_correctness_or_financial_verdict",
          repeats: anchor.repeats, exactRepeats: anchor.exactRepeats, retrievedBytes: anchor.retrievedBytes,
          window: { reason, startedAt: anchor.timestamp, endedAt: this.now(), maxEvents: MAX_EVENTS },
          events: events.map(({ bytes: _bytes, ...event }) => event), droppedQueuedRecords: this.dropped,
        })}\n`;
        this.enqueue(row);
      }
      return false;
    });
  }

  private enqueue(row: string): void {
    this.queue.push(row);
    this.queuedBytes += utf8ByteLength(row);
    while (this.queuedBytes > (this.options.queueBytes ?? QUEUE_BYTES) && this.queue.length) {
      this.queuedBytes -= utf8ByteLength(this.queue.shift()!);
      this.dropped++;
    }
  }

  private sealBurstTail(threadId: string, reason: string, through = Infinity): void {
    const thread = this.threads.get(threadId);
    const burst = thread?.burst;
    if (!thread || !burst) return;
    const events = thread.events.filter((event) => event.sequence > burst.recordedThrough
      && event.sequence >= burst.firstSequence && event.sequence <= through
      && event.timestamp <= burst.lastAt + RETRY_MS);
    if (!events.length) return;
    burst.recordedThrough = events[events.length - 1].sequence;
    this.enqueue(`${JSON.stringify({
      version: 1, kind: "token_miser_chain", captureId: randomUUID(), burstGroupId: burst.id,
      backend: "codex", provider: thread.context?.provider ?? "unknown", threadId,
      context: thread.context, objectId: burst.objectId, category: "suspected_retry_burst",
      classification: "observational_heuristic_not_correctness_or_financial_verdict",
      continuation: true, window: { reason, startedAt: burst.startedAt, endedAt: this.now(), maxEvents: MAX_EVENTS },
      events: events.map(({ bytes: _bytes, ...event }) => event), droppedQueuedRecords: this.dropped,
    })}\n`);
  }

  /** Timer batches only; turn end seals in memory, never flushes per turn. */
  flush(): Promise<void> {
    if (!this.enabled()) return this.writing;
    for (const [id, thread] of this.threads) {
      this.seal(id, "observation_window");
      if (thread.burst && this.now() - thread.burst.lastAt >= RETRY_MS) this.sealBurstTail(id, "burst_idle");
    }
    this.writing = this.writing.then(async () => {
      if (!this.settingEnabled()) { this.clear(); return; }
      const rows = this.queue.splice(0);
      this.queuedBytes = 0;
      if (!rows.length) return;
      try { await this.write(rows.join("")); } catch (error) { this.dropped += rows.length; this.reportError(error); }
    });
    return this.writing;
  }
  private async write(data: string): Promise<void> {
    const file = this.options.filePath;
    const limit = this.options.fileBytes ?? FILE_BYTES;
    if (utf8ByteLength(data) > limit) throw new Error("Token Miser diagnostic batch exceeds the file budget.");
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    this.fileBytes ??= await fs.stat(file).then((stat) => stat.size, (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return 0;
    });
    if (this.fileBytes + utf8ByteLength(data) > limit) {
      const rename = async (from: string, to: string) => {
        try { await fs.rename(from, to); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      };
      await fs.rm(`${file}.2`, { force: true });
      await rename(`${file}.1`, `${file}.2`);
      await rename(file, `${file}.1`);
      this.fileBytes = 0;
    }
    if (!this.settingEnabled()) return;
    if (this.options.append) await this.options.append(file, data);
    else await fs.appendFile(file, data, { mode: 0o600 });
    this.fileBytes += utf8ByteLength(data);
    // Per-process names avoid concurrent append/rotation collisions. Bound
    // older instance logs too, so restarts cannot grow this directory forever.
    try {
      const directory = path.dirname(file);
      const names = (await fs.readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.jsonl(?:\.[12])?$/.test(entry.name));
      if (names.length > 24) {
        const own = new Set([file, `${file}.1`, `${file}.2`]);
        const candidates = await Promise.all(names.map(async (entry) => {
          const name = path.join(directory, entry.name);
          return { name, mtime: (await fs.stat(name)).mtimeMs };
        }));
        const oldest = candidates.filter((entry) => !own.has(entry.name)).sort((a, b) => a.mtime - b.mtime);
        for (const entry of oldest.slice(0, names.length - 24)) await fs.rm(entry.name, { force: true });
      }
    } catch (error) { this.reportError(error); }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.settingEnabled()) {
      for (const id of this.threads.keys()) {
        this.seal(id, "shutdown", true);
        this.sealBurstTail(id, "shutdown");
      }
      await this.flush();
    }
    this.closed = true;
    this.clear();
    await this.writing;
  }
}
