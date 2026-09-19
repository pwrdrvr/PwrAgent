import type { AppServerThreadTitleSource } from "@pwragent/shared";

type Inputs = readonly [string | undefined, string | undefined, string | undefined];
type Text = { title: string; titleSource: AppServerThreadTitleSource; summary?: string };

/** Per-provider derived text only. Every listing still reads fresh protocol metadata. */
export class ThreadListTextCache {
  private readonly entries = new Map<string, { inputs: Inputs; text: Text; bytes: number }>();
  private bytes = 0;

  constructor(private readonly maxEntries = 4_096, private readonly maxBytes = 8 * 1024 * 1024) {}

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  read(id: string, inputs: Inputs, normalize: () => Text): Text {
    const cached = this.entries.get(id);
    if (cached && inputs.every((value, index) => value === cached.inputs[index])) {
      this.entries.delete(id);
      this.entries.set(id, cached);
      return { ...cached.text };
    }
    if (cached) {
      this.entries.delete(id);
      this.bytes -= cached.bytes;
    }
    const text = normalize();
    // Bound retained UTF-16 text as well as entry overhead. Large individual
    // previews are processed but cannot evict the whole working set.
    const bytes = 2 * (id.length + inputs.reduce((sum, value) => sum + (value?.length ?? 0), 0)
      + text.title.length + (text.summary?.length ?? 0));
    if (bytes <= this.maxBytes && this.maxEntries > 0) {
      while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
        const oldest = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(oldest)!.bytes;
        this.entries.delete(oldest);
      }
      this.entries.set(id, { inputs: [...inputs], text: { ...text }, bytes });
      this.bytes += bytes;
    }
    return text;
  }
}
