import { randomUUID } from "node:crypto";
import { lstat, open, opendir, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { splitMcpCommandLine } from "@pwragent/shared/contracts/mcp-connections";
import { readRecord } from "../app-server/backend-registry-notification-values";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import { TOKEN_MISER_OUTPUT_TTL_MS } from "./token-miser-output-cache";
import { takeUtf8Prefix } from "./token-miser-types";
import { BoundedCommandLines } from "./bounded-command-lines";
import type { BoundedCommandHelper } from "./bounded-command-helper";

export type BoundedCommandCaller = Pick<AgentToolCallContext, "backend" | "threadId" | "turnId">;
export type BoundedCommandDelivery = {
  caller: BoundedCommandCaller;
  objectId: string;
  itemId: string;
  originalBytes: number;
  deliveredBytes: number;
};
type Ticket = {
  handle: string;
  receipt: string;
  caller: BoundedCommandCaller;
  command: string;
  shell: string;
  file: FileHandle;
  lines: BoundedCommandLines;
  filename: string;
  unlinking?: Promise<void>;
  itemId?: string;
  processId?: string;
  status?: number;
  summary?: Promise<{ text: string; bytes: number }>;
  recorded?: boolean;
  helperIdentity?: string;
  intent?: string;
  lifetime: AbortController;
  timer: NodeJS.Timeout;
};

const isCommand = (value: string) =>
  value.length <= 512
  && /^(?:git diff(?: --cached)?|node --test [A-Za-z0-9_][A-Za-z0-9_./-]*\.test\.(?:js|cjs|mjs)|pnpm exec vitest run [A-Za-z0-9_][A-Za-z0-9_./-]*\.test\.tsx?)$/u.test(value)
  && !value.includes("..") && !/[\r\n]/u.test(value);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const scope = ({ backend, threadId, turnId }: BoundedCommandCaller) => JSON.stringify([backend, threadId, turnId]);

// Claude Bash has no cwd argument. Strip only a literal shell word followed by &&.
// Escaped characters and concatenated quotes cover paths with spaces and apostrophes.
const CLAUDE_CD_PREFIX = /^cd[ \t]+(?:[A-Za-z0-9_./-]|'[^'\r\n]*'|"[^"\\$\x60\r\n]*"|\\[^\r\n])+[ \t]+&&[ \t]+/u;
const CODEX_APPROVAL_WAIT_MS = 30_000;

function assertRetained(ticket: Ticket): void {
  if (ticket.lifetime.signal.aborted) throw new Error("Output expired or unavailable for this turn.");
}

function endsWithHighSurrogate(text: string) {
  const unit = text.charCodeAt(text.length - 1);
  return unit >= 0xd800 && unit <= 0xdbff;
}

async function commandSummary(ticket: Ticket, bytes: number, resolveHelper: (caller: BoundedCommandCaller) => BoundedCommandHelper | undefined,
  eligible: (caller: BoundedCommandCaller) => Promise<boolean>) {
  const sections: Array<{ heading: string; lines: string[]; removed: number; added: number }> = [];
  const isDiff = ticket.command.startsWith("git diff");
  let fileHeading = "";
  let collecting = false;
  let previous = "";
  let repeats = 0;
  let zeroTests = false;
  const headings = new Set<string>();
  const diagnostics = new Set<string>();
  const head: string[] = [];
  const tail: string[] = [];
  let lines = 0;
  let context = 0;
  for await (const line of ticket.lines.from()) {
    lines++;
    const preview = line.slice(0, 220);
    if (ticket.helperIdentity) {
      if (lines > 1 && preview === previous) repeats++;
      if (!isDiff && /^(?:# tests 0\s*$|1\.\.0\s*$|\s*No test files found\b|\s*No tests found\b)/iu.test(preview)) zeroTests = true;
      previous = preview;
      if (isDiff && line.startsWith("diff --git ")) {
        fileHeading = preview;
        collecting = false;
      }
      if (isDiff ? line.startsWith("@@ ") : /^(?:# Subtest: |not ok |FAIL\s)/u.test(line)) {
        collecting = sections.length < 6;
        if (collecting) sections.push({
          heading: takeUtf8Prefix([fileHeading, preview].filter(Boolean).join("\n"), 240),
          lines: [], removed: 0, added: 0,
        });
      } else if (collecting) {
        const section = sections[sections.length - 1]!;
        if (!isDiff || (line.startsWith("-") && section.removed < 2) || (line.startsWith("+") && section.added < 2)) {
          if (line.startsWith("-")) section.removed++;
          if (line.startsWith("+")) section.added++;
          section.lines.push(takeUtf8Prefix(preview, 100));
          collecting = section.lines.length < 4;
        }
      }
    }
    if (head.length < 9) head.push(preview);
    if (line.startsWith("diff --git ") && headings.size < 12) headings.add(preview);
    if (/^\s*(?:[✗×✖]|not ok\b|FAIL\b)|\b(?:AssertionError|Error:|expected:|actual:)/iu.test(line)) context = 4;
    if (context > 0) {
      if (diagnostics.size < 18) diagnostics.add(preview);
      context--;
    }
    if (tail.at(-1) !== preview) tail.push(preview);
    if (tail.length > 14) tail.shift();
  }
  const header = `${ticket.command} exited ${ticket.status}. ${lines} lines. Exact output: ${ticket.handle}.`;
  const facts = [...new Set([...diagnostics, ...headings, ...head, ...tail])].join("\n");
  let digest = header + "\n" + facts;
  if (Buffer.byteLength(digest) > 1450) {
    const first = takeUtf8Prefix(head[0] ?? "", 160);
    const last = takeUtf8Prefix(tail.at(-1) ?? "", 160);
    const middle = takeUtf8Prefix(facts, 1450 - Buffer.byteLength(header + first + last) - 3);
    digest = [header, first, middle, last].filter(Boolean).join("\n");
  }
  if (!ticket.helperIdentity || ticket.lifetime.signal.aborted || !await eligible(ticket.caller).catch(() => false)) return digest;
  const helper = resolveHelper(ticket.caller);
  if (helper?.identity !== ticket.helperIdentity) return digest;
  const excerpts = sections.map(section => takeUtf8Prefix([section.heading, ...section.lines].join("\n"), 240));
  // Keep room for diagnostics, changes away from the first hunk, and the actual tail.
  const detail = [takeUtf8Prefix([...diagnostics].join("\n"), 480), excerpts.join("\n"),
    takeUtf8Prefix(head.join("\n"), 240), takeUtf8Prefix(tail.slice(-4).join("\n"), 320)].filter(Boolean).join("\n");
  const sample = [takeUtf8Prefix([...diagnostics].join("\n"), 180), takeUtf8Prefix(head.join("\n"), 150),
    takeUtf8Prefix(tail.slice(-3).join("\n"), 180)].filter(Boolean).join("\n");
  const note = await helper.enrich({
    command: ticket.command, exitCode: ticket.status!, lines, bytes,
    repeatedLines: repeats, zeroTests, intent: ticket.intent, sample, detail,
  }, ticket.lifetime.signal, () => eligible(ticket.caller)).catch(() => undefined);
  return note ? digest + "\n" + note : digest;
}

/** Execution stays in the native shell. The owner only reads its own open file descriptor. */
export class BoundedCommandCapture {
  private readonly tickets = new Map<string, Ticket>();
  private readonly idsByHandle = new Map<string, string>();
  // Live assistant text is transient and scoped to the exact originating turn.
  private readonly intents = new Map<string, { itemId: string; text: string; bytes: number; full: boolean }>();
  private readonly preparations = new Map<AbortController, string>();
  private closed = false;
  private nextSweepAt = 0;
  private sweep?: Promise<void>;
  constructor(
    private readonly issueHandle: () => string,
    private readonly eligible: (caller: BoundedCommandCaller) => Promise<boolean>,
    private readonly approve: (caller: BoundedCommandCaller, command: string, helper: string | undefined, signal: AbortSignal) => Promise<boolean>,
    private readonly resolveHelper: (caller: BoundedCommandCaller) => BoundedCommandHelper | undefined = () => undefined,
    private readonly recordDelivery?: (delivery: BoundedCommandDelivery) => boolean,
  ) {}

  get pending() { return this.tickets.size > 0 || this.preparations.size > 0; }

  observeIntent({ backend, federationTarget, notification }: AgentEvent, captureEnabled: () => boolean) {
    if (federationTarget || (backend !== "codex" && backend !== "claude" && backend !== "acp:antigravity")) return;
    if (notification.method === "turn/started") {
      if (this.closed || this.intents.size >= 256 || !captureEnabled()) return;
      const turnId = readRecord(notification.params.turn)?.id;
      // A Codex start reservation has no assistant messages or matching native terminal event.
      if (typeof turnId !== "string" || (backend === "codex" && turnId.startsWith("pending:"))) return;
      const key = scope({ backend, threadId: notification.params.threadId, turnId });
      if (!this.intents.has(key)) this.intents.set(key, { itemId: "", text: "", bytes: 0, full: false });
      return;
    }
    if (!this.intents.size) return;
    if (notification.method !== "item/agentMessage/delta" && notification.method !== "item/completed") return;
    const { threadId, turnId } = notification.params;
    if (!turnId) return;
    const intent = this.intents.get(scope({ backend, threadId, turnId }));
    if (!intent) return;
    let text: string;
    let append = false;
    let itemId: string;
    if (notification.method === "item/agentMessage/delta") {
      const params = notification.params;
      // Antigravity also surfaces thought chunks as commentary. Only its message chunks are eligible.
      if (typeof params.delta !== "string" || typeof params.itemId !== "string" || params.stream || (backend === "acp:antigravity" && params.phase !== "final")) return;
      append = intent.itemId === params.itemId;
      if (append && intent.full) return;
      text = params.delta;
      itemId = params.itemId;
    } else {
      const item = "item" in notification.params ? readRecord(notification.params.item) : undefined;
      if (backend === "acp:antigravity" || item?.type !== "agentMessage" || typeof item.id !== "string"
        || typeof item.text !== "string" || !item.text) return;
      text = item.text;
      itemId = item.id;
    }
    if (!append) {
      intent.text = "";
      intent.bytes = 0;
    } else if (endsWithHighSurrogate(intent.text)) {
      // A UTF-16 surrogate pair may straddle two stream events. Revisit only that unit.
      text = intent.text.slice(-1) + text.slice(0, 385);
      intent.text = intent.text.slice(0, -1);
      intent.bytes -= 3;
    }
    const piece = takeUtf8Prefix(text, 384 - intent.bytes);
    intent.text += piece;
    intent.bytes += Buffer.byteLength(piece);
    intent.itemId = itemId;
    intent.full = piece.length < text.length || (intent.bytes === 384 && !endsWithHighSurrogate(intent.text));
  }

  forgetIntent(caller: BoundedCommandCaller) {
    if (this.intents.size) this.intents.delete(scope(caller));
  }

  async prepare(caller: BoundedCommandCaller, command: string, requestSignal?: AbortSignal) {
    const callerScope = scope(caller);
    const intent = this.intents.get(callerScope)?.text.trim() || undefined;
    if (!caller.turnId || process.platform === "win32" || !isCommand(command)
      || !["acp:antigravity", "claude", "codex"].includes(caller.backend)
      || !await this.eligible(caller)) throw new Error("Bounded command unavailable for this turn or command.");
    if (this.closed || this.tickets.size + this.preparations.size >= 24) throw new Error("Capture unavailable or busy.");
    const lifetime = new AbortController();
    this.preparations.set(lifetime, callerScope);
    // Leave headroom for Codex to receive the result before its dynamic-tool timeout.
    const deadline = caller.backend === "codex" ? AbortSignal.timeout(CODEX_APPROVAL_WAIT_MS) : undefined;
    const signal = AbortSignal.any([lifetime.signal, requestSignal, deadline].filter((value) => value !== undefined));
    const cancelled = Promise.withResolvers<boolean>();
    const abort = () => cancelled.resolve(false);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const helper = this.resolveHelper(caller);
      const approved = !signal.aborted && await Promise.race([this.approve(caller, command, helper?.label, signal), cancelled.promise]);
      if (deadline?.aborted) throw new Error("Approval timed out while awaiting permission to capture output. Use an ordinary bounded command or request capture again.");
      if (!approved || signal.aborted || this.closed || !await this.eligible(caller)) {
        throw new Error("Command capture was declined, cancelled, or the turn ended.");
      }
      if (!this.sweep && Date.now() >= this.nextSweepAt) {
        this.sweep = removeAbandonedCaptures().then(() => {
          this.nextSweepAt = Date.now() + TOKEN_MISER_OUTPUT_TTL_MS;
        }).catch(() => {}).finally(() => { this.sweep = undefined; });
      }
      await this.sweep;
      signal.throwIfAborted();
      const id = randomUUID();
      const handle = this.issueHandle();
      const receipt = randomUUID();
      const filename = path.join(tmpdir(), `pwragent-capture-${process.pid}-${randomUUID()}.log`);
      const file = await open(filename, "wx+", 0o600);
      const target = /^[\w./-]+$/u.test(filename) ? filename : quote(filename);
      // The native approval includes the original command and its output destination.
      // The receipt is emitted only after the command returns, including on failure.
      const shell = `test -f ${target} || exit 125; { if ${command}; then rc=0; else rc=$?; fi; } > ${target} 2>&1 || exit 125; echo pwragent-${receipt}:$rc; exit "$rc"`;
      const timer = this.expireAfterRetention(id);
      this.tickets.set(id, { handle, receipt, caller: { backend: caller.backend, threadId: caller.threadId, turnId: caller.turnId }, command, shell, filename, file, lines: new BoundedCommandLines(file), timer, intent, helperIdentity: helper?.identity, lifetime: new AbortController() });
      this.idsByHandle.set(handle, id);
      try {
        if (this.closed || !await this.eligible(caller) || signal.aborted || !this.tickets.has(id)) throw new Error("Capture closed.");
      } catch (error) {
        await this.remove(id);
        throw error;
      }
      return { objectId: handle, command: shell };
    } finally {
      signal.removeEventListener("abort", abort);
      this.preparations.delete(lifetime);
    }
  }

  private expireAfterRetention(id: string) {
    return setTimeout(() => { void this.remove(id).catch(() => {}); }, TOKEN_MISER_OUTPUT_TTL_MS).unref();
  }

  observe(caller: BoundedCommandCaller, item: { id: string; processId?: string; command?: string; completed: boolean; rejected?: boolean; output?: string }) {
    if (!this.tickets.size) return;
    const callerScope = scope(caller);
    const command = item.command;
    const directShell = caller.backend === "claude" ? command?.replace(CLAUDE_CD_PREFIX, "") : command;
    let loginShell: string | undefined;
    for (const [id, ticket] of this.tickets) {
      if (callerScope !== scope(ticket.caller) || ticket.status !== undefined) continue;
      if (!ticket.itemId && directShell
        && (directShell === ticket.shell || (loginShell ??= loginShellCommand(directShell)) === ticket.shell)) {
        ticket.itemId = item.id;
        ticket.processId = item.processId;
        clearTimeout(ticket.timer);
      }
      if (ticket.itemId !== item.id || !item.completed) continue;
      const receipt = new RegExp(`(?:^|\\n)pwragent-${ticket.receipt}:(\\d{1,3})(?:\\r?\\n|$)`, "u").exec(item.output ?? "");
      if (!item.rejected && receipt && Number(receipt[1]) <= 255) {
        ticket.status = Number(receipt[1]);
        // Start once at native completion, even when the parent never asks to inspect.
        ticket.summary = ticket.file.stat().then(async ({ size }) => ({
          text: await commandSummary(ticket, size, this.resolveHelper, this.eligible), bytes: size,
        }));
        // A turn can end and close the descriptor before any reader joins this promise.
        void ticket.summary.catch(() => {});
        ticket.timer = this.expireAfterRetention(id);
        // Readers use the owner's original descriptor. Remove the directory
        // entry as soon as the writer has finished, including on test failure.
        void this.unlinkFile(ticket).catch(() => {});
      } else {
        void this.remove(id).catch(() => {});
      }
    }
  }

  async endTurn(caller: BoundedCommandCaller, stop?: (matches: (terminal: { itemId: string; processId: string; command: string }) => boolean) => Promise<void>) {
    this.forgetIntent(caller);
    const callerScope = scope(caller);
    for (const [controller, owner] of this.preparations) {
      if (owner === callerScope) controller.abort();
    }
    const owned = [...this.tickets].filter(([, ticket]) => callerScope === scope(ticket.caller));
    const running = owned.map(([, ticket]) => ticket).filter((ticket) => ticket.status === undefined && ticket.itemId && ticket.processId);
    const cleanup = owned.map(([id]) => this.remove(id));
    if (stop && running.length) {
      // Codex can acknowledge turn/interrupt while a Unified Exec child still runs.
      // A recycled native process ID alone is insufficient authority to terminate it.
      cleanup.push(stop((terminal) => running.some((ticket) => ticket.itemId === terminal.itemId
        && ticket.processId === terminal.processId
        && (ticket.shell === terminal.command || loginShellCommand(terminal.command) === ticket.shell))));
    }
    await Promise.all(cleanup);
  }

  private async retained(caller: BoundedCommandCaller, id: string) {
    const ticket = this.tickets.get(this.idsByHandle.get(id) ?? id);
    if (!ticket || scope(caller) !== scope(ticket.caller) || !await this.eligible(caller)) {
      throw new Error("Output expired or unavailable for this turn.");
    }
    assertRetained(ticket);
    if (ticket.status === undefined) throw new Error("No native completion receipt for this command.");
    return ticket;
  }

  async readBytes(caller: BoundedCommandCaller, id: string, offset: number) {
    const ticket = await this.retained(caller, id);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid byte offset.");
    const totalBytes = (await ticket.file.stat()).size;
    const { buffer, bytesRead } = await ticket.file.read(Buffer.alloc(1024), 0, 1024, offset);
    assertRetained(ticket);
    return { totalBytes, offset, base64: buffer.subarray(0, bytesRead).toString("base64") };
  }

  async inspect(caller: BoundedCommandCaller, id: string, range?: { start: number; end?: number; query?: string }) {
    const ticket = await this.retained(caller, id);
    if (!range) {
      const { text, bytes } = await ticket.summary!;
      if (ticket.lifetime.signal.aborted || !await this.eligible(caller)) throw new Error("Output expired or unavailable for this turn.");
      assertRetained(ticket);
      if (!ticket.recorded && this.recordDelivery) {
        ticket.recorded = this.recordDelivery({ caller: ticket.caller, objectId: ticket.handle, itemId: ticket.itemId!,
          originalBytes: bytes, deliveredBytes: Buffer.byteLength(text) });
      }
      return text;
    }
    const { start, end, query } = range;
    if (!Number.isSafeInteger(start) || start < 1
      || (end !== undefined && (!Number.isSafeInteger(end) || end < start || end - start >= 200)) || (query !== undefined && (typeof query !== "string" || !query || query.length > 256))) {
      throw new Error("Invalid line range or query.");
    }
    const selected: string[] = [];
    let number = start - 1;
    for await (const line of ticket.lines.from(start)) {
      number++;
      if (query === undefined || line.includes(query)) selected.push(query ? `${number}: ${line}` : line);
      if (number === end || (end === undefined && selected.length >= 20)) break;
    }
    assertRetained(ticket);
    return takeUtf8Prefix(selected.join("\n"), 1450);
  }

  private async remove(id: string) {
    const ticket = this.tickets.get(id);
    if (!ticket) return;
    this.tickets.delete(id);
    this.idsByHandle.delete(ticket.handle);
    ticket.lifetime.abort();
    clearTimeout(ticket.timer);
    try {
      await this.unlinkFile(ticket);
    } finally {
      await ticket.file.close();
    }
  }

  private unlinkFile(ticket: Ticket): Promise<void> {
    return ticket.unlinking ??= unlink(ticket.filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return;
      ticket.unlinking = undefined;
      throw error;
    });
  }

  async close() {
    this.closed = true;
    for (const controller of this.preparations.keys()) controller.abort();
    this.intents.clear();
    await Promise.all([...this.tickets.keys()].map((id) => this.remove(id)));
  }
}

// Service launches can omit SHELL while Codex still resolves the account login shell.
let accountShell: string | null | undefined;
function isAccountShell(executable: string): boolean {
  if (accountShell === undefined) {
    try { accountShell = userInfo().shell; } catch { accountShell = null; }
  }
  return executable === accountShell;
}

export function loginShellCommand(display: string): string {
  const argv = splitMcpCommandLine(display);
  if (!argv || argv.length !== 3 || !["-c", "-lc"].includes(argv[1]!)) return "";
  const executable = argv[0]!;
  if (!path.isAbsolute(executable) || !["sh", "bash", "zsh"].includes(path.basename(executable))) return "";
  const directory = path.dirname(executable);
  return directory === "/bin" || directory === "/usr/bin" || executable === process.env.SHELL || isAccountShell(executable)
    ? argv[2]! : "";
}

// Swept on demand, at most once per retention interval after a successful sweep. A crashed owner may have left a name
// between allocating its descriptor and receiving the native completion event.
async function removeAbandonedCaptures() {
  const directory = tmpdir();
  const cutoff = Date.now() - TOKEN_MISER_OUTPUT_TTL_MS;
  for await (const entry of await opendir(directory)) {
    if (!entry.isFile()) continue;
    const match = /^pwragent-capture-([1-9]\d*)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.log$/u.exec(entry.name);
    if (!match) continue;
    try {
      process.kill(Number(match[1]), 0);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
    }
    const filename = path.join(directory, entry.name);
    const stat = await lstat(filename).catch(() => undefined);
    if (stat?.isFile() && stat.uid === process.getuid?.() && stat.birthtimeMs < cutoff) {
      await unlink(filename).catch(() => {});
    }
  }
}
