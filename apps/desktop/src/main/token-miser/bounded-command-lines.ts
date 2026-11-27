import type { FileHandle } from "node:fs/promises";

const BLOCK_BYTES = 64 * 1024;
const PREVIEW_LENGTH = 2048;

type Checkpoint = { offset: number; line: number };
type Page = { lines: string[]; nextOffset: number };

/** Completed capture. Keep byte offsets at block boundaries and just one page of previews. */
export class BoundedCommandLines {
  private readonly checkpoints: Checkpoint[] = [{ offset: 0, line: 1 }];
  private recent?: { offset: number; page: Promise<Page> };

  constructor(private readonly file: FileHandle) {}

  async *from(start = 1) {
    const size = (await this.file.stat()).size;
    let low = 0;
    let high = this.checkpoints.length;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.checkpoints[mid]!.line <= start) low = mid;
      else high = mid;
    }
    let { offset, line } = this.checkpoints[low]!;
    while (offset < size) {
      if (this.recent?.offset !== offset) {
        this.recent = { offset, page: this.readPage(offset, size) };
      }
      const recent = this.recent;
      let page: Page;
      try {
        page = await recent.page;
      } catch (error) {
        if (this.recent === recent) this.recent = undefined;
        throw error;
      }
      const nextLine = line + page.lines.length;
      if (this.checkpoints.at(-1)!.offset === offset) {
        this.checkpoints.push({ offset: page.nextOffset, line: nextLine });
      }
      for (let index = Math.max(0, start - line); index < page.lines.length; index++) {
        yield page.lines[index]!;
      }
      offset = page.nextOffset;
      line = nextLine;
    }
  }

  private async readPage(start: number, size: number): Promise<Page> {
    const buffer = Buffer.allocUnsafe(Math.min(BLOCK_BYTES, size - start));
    // A long logical line can span many blocks. Four bytes per UTF-16 unit
    // suffice to decode the preview even for malformed or split UTF-8 input.
    const prefixLimit = PREVIEW_LENGTH * 4;
    let prefix = Buffer.alloc(0);
    let offset = start;
    while (offset < size) {
      const { bytesRead } = await this.file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) throw new Error("Capture changed during retrieval.");
      const bytes = buffer.subarray(0, bytesRead);
      const newline = bytes.lastIndexOf(10);
      const atEnd = offset + bytesRead === size;
      if (newline >= 0 || atEnd) {
        const length = atEnd ? bytesRead : newline + 1;
        const text = bytes.toString("utf8", 0, length);
        const lines = text.split("\n");
        // Decode a split multibyte character before clipping a spanning line.
        if (prefix.length) {
          const firstEnd = bytes.indexOf(10);
          const first = bytes.subarray(0, Math.min(firstEnd < 0 ? length : firstEnd, prefixLimit - prefix.length));
          lines[0] = Buffer.concat([prefix, first]).toString("utf8");
        }
        if (bytes[length - 1] === 10) lines.pop();
        for (let i = 0; i < lines.length; i++) {
          const preview = lines[i]!.slice(0, PREVIEW_LENGTH);
          const terminated = i < lines.length - 1 || bytes[length - 1] === 10;
          lines[i] = terminated ? preview.replace(/\r$/u, "") : preview;
        }
        return { lines, nextOffset: offset + length };
      }
      if (prefix.length < prefixLimit) {
        prefix = Buffer.concat([prefix, bytes.subarray(0, prefixLimit - prefix.length)]);
      }
      offset += bytesRead;
    }
    throw new Error("Capture changed during retrieval.");
  }
}
