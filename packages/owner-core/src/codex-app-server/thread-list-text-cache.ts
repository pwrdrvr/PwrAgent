import { createHash } from "node:crypto";
import type { AppServerThreadTitleSource } from "@pwragent/shared";

type Inputs = readonly [string | undefined, string | undefined, string | undefined];
type Text = { title: string; titleSource: AppServerThreadTitleSource; summary?: string };
type InputKey = string | undefined | { digest: string };

function inputKeys(inputs: Inputs): InputKey[] {
  const keys: InputKey[] = [];
  for (const value of inputs) {
    if (value === undefined || value.length <= 256) {
      keys.push(value);
    } else {
      // Preview and summary often share the same source. Hash it once per read.
      const previous = inputs.indexOf(value);
      keys.push(previous < keys.length ? keys[previous] : {
        // UTF-8 replaces lone surrogates; UTF-16 preserves every JS code unit.
        digest: createHash("sha256").update(value, "utf16le").digest("hex"),
      });
    }
  }
  return keys;
}

function sameInput(left: InputKey, right: InputKey): boolean {
  return typeof left === "object" && typeof right === "object"
    ? left.digest === right.digest : left === right;
}

/** Per-provider derived text only. Every listing still reads fresh protocol metadata. */
export class ThreadListTextCache {
  private readonly entries = new Map<string, { inputs: InputKey[]; text: Text; bytes: number }>();
  private bytes = 0;

  constructor(private readonly maxEntries = 4_096, private readonly maxBytes = 8 * 1024 * 1024) {}

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  read(id: string, inputs: Inputs, normalize: () => Text): Text {
    const keys = inputKeys(inputs);
    const cached = this.entries.get(id);
    if (cached && keys.every((value, index) => sameInput(value, cached.inputs[index]))) {
      this.entries.delete(id);
      this.entries.set(id, cached);
      return { ...cached.text };
    }
    if (cached) {
      this.entries.delete(id);
      this.bytes -= cached.bytes;
    }
    const text = normalize();
    // Bound retained UTF-16 keys and results as well as entry count. Long raw
    // inputs are never retained; an oversized result still bypasses admission.
    const bytes = 2 * (id.length + keys.reduce((sum, value) =>
      sum + (typeof value === "object" ? value.digest.length : value?.length ?? 0), 0)
      + text.title.length + (text.summary?.length ?? 0));
    if (bytes <= this.maxBytes && this.maxEntries > 0) {
      while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
        const oldest = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(oldest)!.bytes;
        this.entries.delete(oldest);
      }
      this.entries.set(id, { inputs: keys, text: { ...text }, bytes });
      this.bytes += bytes;
    }
    return text;
  }
}
