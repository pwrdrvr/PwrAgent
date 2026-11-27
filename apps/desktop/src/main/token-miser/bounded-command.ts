import { randomUUID } from "node:crypto";
import { lstat, open, opendir, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { splitMcpCommandLine } from "@pwragent/shared/contracts/mcp-connections";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import { TOKEN_MISER_OUTPUT_TTL_MS } from "./token-miser-output-cache";
import { takeUtf8Prefix } from "./token-miser-types";
import { BOUNDED_HELPER_TIMEOUT_MS, type BoundedCommandHelper } from "./bounded-command-helper";

type Caller = Pick<AgentToolCallContext, "backend" | "threadId" | "turnId">;
type Ticket = {
  handle: string;
  receipt: string;
  caller: Caller;
  command: string;
  shell: string;
  file: FileHandle;
  filename: string;
  unlinking?: Promise<void>;
  itemId?: string;
  processId?: string;
  status?: number;
  summary?: Promise<string>;
  helperIdentity?: string;
  lifetime: AbortController;
  timer: NodeJS.Timeout;
};

const isCommand = (value: string) =>
  value.length <= 512
  && /^(?:git diff(?: --cached)?|node --test [A-Za-z0-9_][A-Za-z0-9_./-]*\.test\.(?:js|cjs|mjs)|pnpm exec vitest run [A-Za-z0-9_][A-Za-z0-9_./-]*\.test\.tsx?)$/u.test(value)
  && !value.includes("..") && !/[\r\n]/u.test(value);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const scope = ({ backend, threadId, turnId }: Caller) => JSON.stringify([backend, threadId, turnId]);

// Keep one bounded preview per logical line. Exact byte pages also cover binary
// output and individual lines too long for a model-facing search result.
async function* linePreviews(file: FileHandle) {
  const size = (await file.stat()).size;
  if (!size) return;
  const buffer = Buffer.alloc(64 * 1024);
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let prefix = "";
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) throw new Error("Capture changed during retrieval.");
    offset += bytesRead;
    const parts = decoder.decode(buffer.subarray(0, bytesRead), { stream: offset < size }).split("\n");
    for (const [index, part] of parts.entries()) {
      prefix += part.slice(0, 2048 - prefix.length);
      if (index !== parts.length - 1) {
        yield prefix.replace(/\r$/u, "");
        prefix = "";
      }
    }
  }
  if (prefix) yield prefix;
}

async function commandSummary(ticket: Ticket, resolveHelper: () => BoundedCommandHelper | undefined) {
  const sections: Array<{ heading: string; lines: string[]; removed: number; added: number }> = [];
  const isDiff = ticket.command.startsWith("git diff");
  let fileHeading = "";
  let collecting = false;
  let previous = "";
  let repeats = 0;
  const headings = new Set<string>();
  const diagnostics = new Set<string>();
  const head: string[] = [];
  const tail: string[] = [];
  let lines = 0;
  let context = 0;
  for await (const line of linePreviews(ticket.file)) {
    lines++;
    const preview = line.slice(0, 220);
    if (ticket.helperIdentity) {
      if (preview === previous) repeats++;
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
  let selected: string | undefined;
  if (ticket.helperIdentity && sections.length > 1 && repeats < lines / 2
    && Buffer.byteLength([...diagnostics].join("\n")) < 900 && (await ticket.file.stat()).size >= 8192) {
    const helper = resolveHelper();
    if (helper?.identity === ticket.helperIdentity && !ticket.lifetime.signal.aborted) {
      const signal = AbortSignal.any([ticket.lifetime.signal, AbortSignal.timeout(BOUNDED_HELPER_TIMEOUT_MS)]);
      const aborted = Promise.withResolvers<undefined>();
      const finish = () => aborted.resolve(undefined);
      signal.addEventListener("abort", finish, { once: true });
      try {
        const excerpts = sections.map((section) => takeUtf8Prefix([section.heading, ...section.lines].join("\n"), 460));
        if (Buffer.byteLength(JSON.stringify({ command: ticket.command, excerpts })) <= 4096) {
          const index = await Promise.race([helper.select(ticket.command, excerpts, signal), aborted.promise]);
          if (index !== undefined && Number.isInteger(index)) selected = excerpts[index];
        }
      } catch {
        // The deterministic result remains available when the chosen provider fails.
      } finally {
        signal.removeEventListener("abort", finish);
      }
    }
  }
  const facts = new Set([...diagnostics, selected, ...headings, ...head, ...tail].filter(Boolean));
  return takeUtf8Prefix(`${ticket.command} exited ${ticket.status}. ${lines} lines.\n${[...facts].join("\n")}`, 1450);
}

/** Execution stays in the native shell. The owner only reads its own open file descriptor. */
export class BoundedCommandCapture {
  private readonly tickets = new Map<string, Ticket>();
  private readonly idsByHandle = new Map<string, string>();
  private preparing = 0;
  private closed = false;
  private sweep?: Promise<void>;
  constructor(
    private readonly issueHandle: () => string,
    private readonly eligible: (caller: Caller) => Promise<boolean>,
    private readonly approve: (caller: Caller, command: string, helper?: string) => Promise<boolean>,
    private readonly resolveHelper: () => BoundedCommandHelper | undefined = () => undefined,
  ) {}

  get pending() { return this.tickets.size > 0; }

  async prepare(caller: Caller, command: string) {
    if (!caller.turnId || process.platform === "win32" || !isCommand(command)
      || !["acp:antigravity", "claude", "codex"].includes(caller.backend)
      || !await this.eligible(caller)) throw new Error("Bounded command unavailable for this turn or command.");
    if (this.closed || this.tickets.size + this.preparing >= 24) throw new Error("Capture unavailable or busy.");
    this.preparing++;
    try {
      const helper = this.resolveHelper();
      if (!await this.approve(caller, command, helper?.label) || this.closed || !await this.eligible(caller)) {
        throw new Error("Command capture was declined, cancelled, or the turn ended.");
      }
      await (this.sweep ??= removeAbandonedCaptures().catch(() => { this.sweep = undefined; }));
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
      this.tickets.set(id, { handle, receipt, caller: { backend: caller.backend, threadId: caller.threadId, turnId: caller.turnId }, command, shell, filename, file, timer, helperIdentity: helper?.identity, lifetime: new AbortController() });
      this.idsByHandle.set(handle, id);
      try {
        if (this.closed || !await this.eligible(caller) || !this.tickets.has(id)) throw new Error("Capture closed.");
      } catch (error) {
        await this.remove(id);
        throw error;
      }
      return { objectId: handle, command: shell };
    } finally {
      this.preparing--;
    }
  }

  private expireAfterRetention(id: string) {
    return setTimeout(() => { void this.remove(id).catch(() => {}); }, TOKEN_MISER_OUTPUT_TTL_MS).unref();
  }

  observe(caller: Caller, item: { id: string; processId?: string; command?: string; completed: boolean; output?: string }) {
    if (!this.pending) return;
    for (const [id, ticket] of this.tickets) {
      if (scope(caller) !== scope(ticket.caller) || ticket.status !== undefined) continue;
      const command = item.command;
      if (!ticket.itemId && command && (command === ticket.shell || matchesLoginShell(command, ticket.shell))) {
        ticket.itemId = item.id;
        ticket.processId = item.processId;
        clearTimeout(ticket.timer);
      }
      if (ticket.itemId !== item.id || !item.completed || !item.output) continue;
      const receipt = new RegExp(`(?:^|\\n)pwragent-${ticket.receipt}:(\\d{1,3})(?:\\r?\\n|$)`, "u").exec(item.output);
      if (receipt && Number(receipt[1]) <= 255) {
        ticket.status = Number(receipt[1]);
        ticket.timer = this.expireAfterRetention(id);
        // Readers use the owner's original descriptor. Remove the directory
        // entry as soon as the writer has finished, including on test failure.
        void this.unlinkFile(ticket).catch(() => {});
      }
    }
  }

  async endTurn(caller: Caller, stop?: (matches: (terminal: { itemId: string; processId: string; command: string }) => boolean) => Promise<void>) {
    const owned = [...this.tickets].filter(([, ticket]) => scope(caller) === scope(ticket.caller));
    const running = owned.map(([, ticket]) => ticket).filter((ticket) => ticket.status === undefined && ticket.itemId && ticket.processId);
    const cleanup = owned.map(([id]) => this.remove(id));
    if (stop && running.length) {
      // Codex can acknowledge turn/interrupt while a Unified Exec child still runs.
      // A recycled native process ID alone is insufficient authority to terminate it.
      cleanup.push(stop((terminal) => running.some((ticket) => ticket.itemId === terminal.itemId
        && ticket.processId === terminal.processId
        && (ticket.shell === terminal.command || matchesLoginShell(terminal.command, ticket.shell)))));
    }
    await Promise.all(cleanup);
  }

  private async retained(caller: Caller, id: string) {
    const ticket = this.tickets.get(this.idsByHandle.get(id) ?? id);
    if (!ticket || scope(caller) !== scope(ticket.caller) || !await this.eligible(caller)) {
      throw new Error("Output expired or unavailable for this turn.");
    }
    if (ticket.status === undefined) throw new Error("No native completion receipt for this command.");
    return ticket;
  }

  async readBytes(caller: Caller, id: string, offset: number) {
    const ticket = await this.retained(caller, id);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid byte offset.");
    const totalBytes = (await ticket.file.stat()).size;
    const { buffer, bytesRead } = await ticket.file.read(Buffer.alloc(1024), 0, 1024, offset);
    return { totalBytes, offset, base64: buffer.subarray(0, bytesRead).toString("base64") };
  }

  async inspect(caller: Caller, id: string, range?: { start: number; end: number; query?: string }) {
    const ticket = await this.retained(caller, id);
    if (!range) {
      const text = await (ticket.summary ??= commandSummary(ticket, this.resolveHelper).catch((error) => {
        ticket.summary = undefined;
        throw error;
      }));
      if (ticket.lifetime.signal.aborted || !await this.eligible(caller)) throw new Error("Output expired or unavailable for this turn.");
      return text;
    }
    const { start, end, query } = range;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start
      || end - start >= 200 || (query !== undefined && (typeof query !== "string" || !query || query.length > 256))) {
      throw new Error("Invalid line range or query.");
    }
    const selected: string[] = [];
    let number = 0;
    for await (const line of linePreviews(ticket.file)) {
      if (++number < start) continue;
      if (query === undefined || line.includes(query)) selected.push(query ? `${number}: ${line}` : line);
      if (selected.length > end - start) break;
    }
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
    await Promise.all([...this.tickets.keys()].map((id) => this.remove(id)));
  }
}

function matchesLoginShell(display: string, command: string): boolean {
  const argv = splitMcpCommandLine(display);
  return !!argv && argv.length === 3 && ["/bin/bash", "/bin/zsh", "/bin/sh"].includes(argv[0]!)
    && ["-c", "-lc"].includes(argv[1]!) && argv[2] === command;
}

// Runs on first explicit capture only. A crashed owner may have left a name
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
