import { describe, expect, it } from "vitest";
import {
  measureMessageText,
  splitTextForDelivery,
} from "../text-splitting";

const size = (s: string) => s.length;
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("splitTextForDelivery", () => {
  it("returns empty for empty input", () => {
    expect(splitTextForDelivery("", { limit: 10 })).toEqual([]);
  });

  it("returns the text unchanged when it fits", () => {
    expect(splitTextForDelivery("short", { limit: 10 })).toEqual(["short"]);
    expect(splitTextForDelivery("exactly-10", { limit: 10 })).toEqual(["exactly-10"]);
  });

  it("keeps every chunk within the limit", () => {
    const text = "abcdefghij ".repeat(50); // 550 chars
    const chunks = splitTextForDelivery(text, { limit: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(size(chunk)).toBeLessThanOrEqual(100);
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("prefers blank-line (paragraph) boundaries", () => {
    const para = "A".repeat(40);
    const text = `${para}\n\n${para}\n\n${para}`; // 3 paragraphs, 44 chars apart
    const chunks = splitTextForDelivery(text, { limit: 90 });
    // Each chunk should end at a paragraph, never splitting an "A" run.
    for (const chunk of chunks) {
      expect(chunk).toMatch(/^A+(\n\nA+)*$/);
    }
    expect(chunks.join("\n\n")).toBe(text);
  });

  it("falls back to newline, then sentence, then word boundaries", () => {
    const sentence = "The quick brown fox jumps over the lazy dog. ";
    const text = sentence.repeat(6).trim(); // ~264 chars, spaces + sentence ends
    const chunks = splitTextForDelivery(text, { limit: 60 });
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(60);
      // No chunk should start or end mid-word (each boundary was a space or
      // sentence end), so no chunk begins/ends with a partial "quic"/"lazy".
      expect(chunk).not.toMatch(/\s$/);
    }
    // Reassembling with single spaces recovers the words in order.
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("hard-splits an unbroken run with no boundary", () => {
    const text = "x".repeat(250);
    const chunks = splitTextForDelivery(text, { limit: 100 });
    expect(chunks).toEqual(["x".repeat(100), "x".repeat(100), "x".repeat(50)]);
  });

  it("measures by bytes when asked (multibyte-safe)", () => {
    const text = "😀".repeat(10); // 4 bytes each = 40 bytes, 20 UTF-16 code units
    const chunks = splitTextForDelivery(text, { limit: 12, measure: "bytes" });
    for (const chunk of chunks) {
      expect(bytes(chunk)).toBeLessThanOrEqual(12);
      // Never split a surrogate pair — each chunk is whole emoji.
      expect(chunk).toMatch(/^(😀)+$/u);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("does not split a surrogate pair on the char measure either", () => {
    const text = "😀".repeat(5);
    const chunks = splitTextForDelivery(text, { limit: 3, measure: "chars" });
    for (const chunk of chunks) {
      expect(chunk).toMatch(/^(😀)+$/u);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("drops whitespace-only tail chunks", () => {
    const text = `${"a".repeat(100)}\n\n   \n`;
    const chunks = splitTextForDelivery(text, { limit: 100 });
    expect(chunks).toEqual(["a".repeat(100)]);
  });
});

describe("measureMessageText", () => {
  it("counts code units for chars and utf8 bytes for bytes", () => {
    expect(measureMessageText("😀", "chars")).toBe(2);
    expect(measureMessageText("😀", "bytes")).toBe(4);
    expect(measureMessageText("hello", "chars")).toBe(5);
    expect(measureMessageText("héllo", "bytes")).toBe(6);
  });
});
