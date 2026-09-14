import { getMainLogger } from "../log";

const log = getMainLogger("pwragent:federation-transport");
let expiresAt = 0;
const WINDOW_MS = 60_000;
type FrameFields = Record<string, string | number | boolean | undefined>;

/** Metadata only: never retain an envelope, payload, or closure over one. */
export class FederationTrafficHistory {
  private readonly records = new Map<number, { at: number; json: string; bytes: number }>();
  private sequence = 0;
  private bytes = 0;
  private dropped = 0;

  constructor(private readonly maxRecords = 4096, private readonly maxBytes = 4 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Traffic history limits must be positive integers.");
    }
  }

  record(direction: "sent" | "received", fields: FrameFields, now = Date.now()): void {
    this.prune(now);
    const bounded = Object.fromEntries(Object.entries(fields).slice(0, 40).map(([key, value]) =>
      [key, typeof value === "string" ? value.slice(0, 256) : value]));
    const json = JSON.stringify({ at: now, direction, ...bounded });
    const bytes = Buffer.byteLength(json);
    if (bytes > this.maxBytes) { this.dropped += 1; return; }
    while (this.records.size >= this.maxRecords || this.bytes + bytes > this.maxBytes) {
      this.removeOldest();
      this.dropped += 1;
    }
    this.records.set(++this.sequence, { at: now, json, bytes });
    this.bytes += bytes;
  }

  snapshot(now = Date.now()): string {
    this.prune(now);
    return [JSON.stringify({ type: "federation-traffic-history", capturedAt: now, windowMs: WINDOW_MS,
      records: this.records.size, bytes: this.bytes, capacityDropped: this.dropped }),
    ...[...this.records.values()].map((record) => record.json)].join("\n") + "\n";
  }

  private removeOldest(): void {
    const key = this.records.keys().next().value;
    if (key === undefined) return;
    this.bytes -= this.records.get(key)!.bytes;
    this.records.delete(key);
  }

  private prune(now: number): void {
    for (const record of this.records.values()) {
      if (record.at > now - WINDOW_MS) break;
      this.removeOldest();
    }
  }
}

const history = new FederationTrafficHistory();

export function recordFederationTraffic(direction: "sent" | "received", fields: FrameFields): void {
  history.record(direction, fields);
}

export function snapshotFederationTrafficHistory(): string {
  return history.snapshot();
}

/** Process-local diagnostic window; never persisted or extended by activity reads. */
export function federationTrafficCaptureUntil(now = Date.now()): number | undefined {
  return now < expiresAt ? expiresAt : undefined;
}

export function setFederationTrafficCapture(enabled: boolean): void {
  expiresAt = enabled ? Date.now() + WINDOW_MS : 0;
  log.info(enabled ? "federation detailed traffic capture started" : "federation detailed traffic capture stopped", {
    expiresAt: enabled ? expiresAt : undefined,
    durationMs: enabled ? WINDOW_MS : 0,
  });
}


let historyWrite: Promise<unknown> = Promise.resolve();

/** Snapshot at the trigger, then serialize atomic writes from multiple windows. */
export function saveFederationTrafficHistory(directory: string): Promise<string> {
  const contents = snapshotFederationTrafficHistory();
  const write = historyWrite.catch(() => undefined).then(async () => {
    const { writeFile, mkdir, rename } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
    const file = `${directory}/federation-traffic-${process.pid}.jsonl`;
    await writeFile(`${file}.tmp`, contents, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    return file;
  });
  historyWrite = write;
  return write;
}
