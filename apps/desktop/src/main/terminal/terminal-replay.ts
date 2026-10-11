import { TerminalControlTail } from "./terminal-control-tail";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import type { Terminal } from "@xterm/headless";
import type { TerminalSnapshot } from "../../shared/integrated-terminal";
import { clampTerminalColumns, clampTerminalRows } from "./pty-resize";

export const TERMINAL_SNAPSHOT_LIMIT = 512 * 1024;
const RAW_LIMIT = 256 * 1024;

export type TerminalOutputFrame = { seq: number; timestamp: number; data: string };

/**
 * What a resumed terminal's replay starts with: the saved screen, then a dim
 * divider, so the new shell's first prompt lands under the old history and
 * nobody mistakes the old output for the new shell's.
 */
export function restoredHistoryPrelude(snapshot: { data: string }): string {
  // The serializer replays the saved program's state: an alternate screen
  // (vim, less) and terminal modes such as mouse reporting. The new shell
  // starts in a plain terminal, so leave all of that first.
  const leaveAltScreen = snapshot.data.includes("\x1b[?1049h") ? "\x1b[?1049l" : "";
  return `${snapshot.data}${leaveAltScreen}${PLAIN_TERMINAL_MODES}\r\n`
    + "\x1b[2m── restored history · new shell ──\x1b[0m\r\n";
}

/** Attributes off, cursor shown, and every mode the serializer can restore
 *  returned to its default (see `SerializeAddon._serializeModes`). */
const PLAIN_TERMINAL_MODES = "\x1b[0m\x1b[?25h\x1b[?1l\x1b[?66l\x1b[?2004l\x1b[4l\x1b[?6l\x1b[?45l"
  + "\x1b[?1004l\x1b[?7h\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l";

/** Authoritative screen and bounded raw output, independent of renderer lifetime.
 * Never wire headless onData to a PTY: parsing output can generate replies. */
export class TerminalReplay {
  private readonly terminal: Terminal;
  private readonly serializer = new serialize.SerializeAddon();
  private queue: Promise<void> = Promise.resolve();
  private frames: TerminalOutputFrame[] = [];
  private rawChars = 0;
  private parsedSeq = 0;
  private readonly controlTail = new TerminalControlTail();
  private parsedTail = "";
  private seq = 0;
  private updatedAt = 0;
  pendingCharacters = 0;

  whenDrained(): Promise<void> { return this.queue; }

  constructor(cols: number, rows: number) {
    // Both packages ship CommonJS. Default imports also work in the externalized
    // production ESM bundle; named imports only worked through Vitest's loader.
    this.terminal = new headless.Terminal({
      cols: clampTerminalColumns(cols),
      rows: clampTerminalRows(rows),
      scrollback: 2_000,
      allowProposedApi: true,
    });
    this.terminal.loadAddon(this.serializer);
  }

  append(data: string, timestamp = Date.now()): TerminalOutputFrame {
    const frame = { seq: ++this.seq, timestamp, data };
    const tail = this.controlTail.append(data);
    this.pendingCharacters += data.length;
    // Drop whole frames, never slice through ANSI or a surrogate pair.
    if (data.length <= RAW_LIMIT) {
      this.frames.push(frame);
      this.rawChars += data.length;
    } else {
      this.frames = [];
      this.rawChars = 0;
    }
    while (this.rawChars > RAW_LIMIT || this.frames.length > 4096) {
      this.rawChars -= this.frames.shift()!.data.length;
    }
    this.queue = this.queue.then(() => new Promise<void>((resolve) => {
      this.terminal.write(data, () => {
        this.pendingCharacters -= data.length;
        this.parsedTail = tail;
        this.parsedSeq = frame.seq;
        this.updatedAt = timestamp;
        resolve();
      });
    }));
    return frame;
  }

  resize(cols: number, rows: number): void {
    this.queue = this.queue.then(() => {
      this.terminal.resize(clampTerminalColumns(cols), clampTerminalRows(rows));
    });
  }

  snapshot(): Promise<TerminalSnapshot> {
    // Insert serialization into the same queue as parsing. Later writes must
    // not advance the screen past the watermark while serialization awaits.
    const result = this.queue.then(() => {
      let scrollback = 2_000;
      let data = this.serializer.serialize({ scrollback });
      while (Buffer.byteLength(data) > TERMINAL_SNAPSHOT_LIMIT && scrollback > 0) {
        scrollback = Math.floor(scrollback / 2);
        data = this.serializer.serialize({ scrollback });
      }
      const truncated = scrollback < 2_000;
      if (Buffer.byteLength(data) > TERMINAL_SNAPSHOT_LIMIT) {
        // A pathological screen with an SGR change per cell can exceed the
        // byte cap even without scrollback. Keep safe text, never cut ANSI.
        data = this.plainText().slice(-64 * 1024).replace(/\n/g, "\r\n");
      }
      return {
        data, pendingEscape: this.parsedTail || undefined, seq: this.parsedSeq, timestamp: this.updatedAt,
        cols: this.terminal.cols, rows: this.terminal.rows, truncated,
      };
    });
    this.queue = result.then(() => undefined);
    return result;
  }

  /** Raw reads are event deltas. Plain reads are screen snapshots, not deltas. */
  read(afterSeq = 0, maxChars = 16_384): {
    frames: TerminalOutputFrame[]; nextSeq: number; truncated: boolean; hasMore: boolean;
  } {
    const limit = Math.max(1, Math.min(64 * 1024, Math.floor(maxChars) || 16_384));
    const frames: TerminalOutputFrame[] = [];
    let chars = 0;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > this.seq) throw new Error("Invalid terminal cursor.");
    let nextSeq = Math.max(afterSeq, (this.frames[0]?.seq ?? this.seq + 1) - 1);
    let truncated = afterSeq < (this.frames[0]?.seq ?? this.seq + 1) - 1;
    for (const frame of this.frames) {
      if (frame.seq <= afterSeq) continue;
      if (chars + frame.data.length > limit) {
        if (frames.length) break;
        // Oversize frames explicitly report loss and advance, rather than
        // producing an unbounded tool result or a cursor that never progresses.
        truncated = true;
        nextSeq = frame.seq;
        break;
      }
      frames.push({ ...frame });
      chars += frame.data.length;
      nextSeq = frame.seq;
    }
    return { frames, nextSeq, truncated, hasMore: nextSeq < this.seq };
  }

  range(): { firstSeq: number; lastSeq: number; firstTimestamp: number | null; lastTimestamp: number | null } {
    return {
      firstSeq: this.frames[0]?.seq ?? this.seq + 1, lastSeq: this.seq,
      firstTimestamp: this.frames[0]?.timestamp ?? null,
      lastTimestamp: this.frames.at(-1)?.timestamp ?? null,
    };
  }

  async readPlain(): Promise<{ data: string; seq: number; timestamp: number; truncated: boolean }> {
    const result = this.queue.then(() => {
      const text = this.plainText();
      let start = Math.max(0, text.length - 64 * 1024);
      if (/[\uDC00-\uDFFF]/.test(text[start] ?? "")) start++;
      return { data: text.slice(start), seq: this.parsedSeq, timestamp: this.updatedAt, truncated: start > 0 };
    });
    this.queue = result.then(() => undefined);
    return result;
  }

  private plainText(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join("\n").trimEnd();
  }

  async dispose(): Promise<void> {
    await this.queue;
    this.terminal.dispose();
  }
}
