import { describe, expect, it } from "vitest";
import { FederationReplacementReceiver, replacementPages } from "../federation/federation-replacement-pages";

describe("atomic Federation replacement pages", () => {
  it("publishes only complete, bounded generations including an empty replacement", () => {
    const entries = Array.from({ length: 1001 }, (_, id) => ({ id, label: "日本語".repeat(100) }));
    const pages = replacementPages(entries);
    const receiver = new FederationReplacementReceiver<{ id: number; label: string }>();
    expect(pages).toHaveLength(11);
    for (const page of pages.slice(0, -1)) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
      expect(receiver.accept(page, 0)).toBeUndefined();
    }
    expect(receiver.accept(pages.at(-1)!, 1)).toEqual(entries);
    for (const page of pages) expect(receiver.accept(page, 2)).toBeUndefined();
    expect(receiver.accept(replacementPages<{ id: number; label: string }>([])[0]!, 3)).toEqual([]);
  });

  it("does not publish missing, expired, or disconnected partial generations", () => {
    const pages = replacementPages(Array.from({ length: 201 }, (_, id) => id));
    const receiver = new FederationReplacementReceiver<number>();
    expect(receiver.accept(pages[0]!, 0)).toBeUndefined();
    expect(() => receiver.accept(pages[2]!, 1)).toThrow("Incomplete");
    expect(receiver.accept(pages[1]!, 2)).toBeUndefined();
    expect(receiver.accept(pages[0]!, 3)).toBeUndefined();
    expect(receiver.accept(pages[1]!, 10_003)).toBeUndefined();
    expect(receiver.accept(pages[2]!, 10_004)).toBeUndefined();
    receiver.accept(pages[0]!, 20_000);
    receiver.clear();
    expect(receiver.accept(pages[1]!, 20_001)).toBeUndefined();
    expect(receiver.accept(pages[2]!, 20_002)).toBeUndefined();
  });

  it("supersedes partial generations and ignores duplicate pages", () => {
    const receiver = new FederationReplacementReceiver<number>();
    const old = replacementPages(Array.from({ length: 101 }, (_, id) => id));
    const fresh = replacementPages(Array.from({ length: 101 }, (_, id) => id + 1000));
    receiver.accept(old[0]!, 0);
    receiver.accept(fresh[0]!, 1);
    expect(receiver.accept(old[1]!, 2)).toBeUndefined();
    expect(receiver.accept(fresh[0]!, 3)).toBeUndefined();
    expect(receiver.accept(fresh[1]!, 4)).toEqual(fresh.flatMap((page) => page.entries));
  });

  it("rejects oversized pages and unbounded page counts", () => {
    const receiver = new FederationReplacementReceiver<string>();
    expect(() => receiver.accept({ generation: "a", index: 0, total: 257, entries: [] })).toThrow("Invalid");
    expect(() => receiver.accept({ generation: "a", index: 0, total: 1, entries: ["x".repeat(256 * 1024)] })).toThrow("byte budget");
    expect(() => replacementPages(Array.from({ length: 25_601 }, () => 0))).toThrow("complete-snapshot budget");
  });
});
