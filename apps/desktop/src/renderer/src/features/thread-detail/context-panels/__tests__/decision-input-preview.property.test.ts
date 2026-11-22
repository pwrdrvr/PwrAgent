import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  parseInputPreview,
  parsePartialPreview,
  previewSummary,
  type PreviewValue,
} from "../decision-input-preview";

/**
 * The rule: the batch dialog never shows a field the input did not have,
 * or a value it did not hold. A cut preview shows a prefix of the input:
 * its leading fields whole, and at most the last one cut short, marked
 * cut. The oracle is JSON.parse of the uncut text.
 */

const jsonValue = fc.jsonValue({ maxDepth: 3 });
const container = fc.oneof(
  fc.dictionary(fc.string(), jsonValue, { maxKeys: 6 }),
  fc.array(jsonValue, { maxLength: 6 }),
  fc.string({ unit: "binary" }),
);

function toJs(value: PreviewValue): unknown {
  switch (value.kind) {
    case "text": return value.text;
    case "scalar": return JSON.parse(value.text);
    case "array": return value.items.map(toJs);
    case "object": return Object.fromEntries(value.entries.map(([key, field]) => [key, toJs(field)]));
  }
}

/** The shown value is a prefix of the original, cut only where it says so. */
function expectPrefixOf(shown: PreviewValue, original: unknown): void {
  switch (shown.kind) {
    case "scalar":
      expect(JSON.parse(shown.text)).toEqual(original);
      return;
    case "text":
      expect(typeof original).toBe("string");
      if (shown.cut) expect((original as string).startsWith(shown.text)).toBe(true);
      else expect(shown.text).toBe(original);
      return;
    case "array": {
      expect(Array.isArray(original)).toBe(true);
      const items = original as unknown[];
      expect(shown.items.length).toBeLessThanOrEqual(items.length);
      shown.items.forEach((item, index) => {
        const last = index === shown.items.length - 1;
        if (last && shown.cut) expectPrefixOf(item, items[index]);
        else expect(toJs(item)).toEqual(items[index]);
      });
      if (!shown.cut) expect(shown.items.length).toBe(items.length);
      return;
    }
    case "object": {
      expect(original && typeof original === "object" && !Array.isArray(original)).toBe(true);
      // JSON.stringify writes keys in this order, so a prefix keeps it.
      const entries = Object.entries(original as Record<string, unknown>);
      expect(shown.entries.length).toBeLessThanOrEqual(entries.length);
      shown.entries.forEach(([key, field], index) => {
        expect(key).toBe(entries[index]![0]);
        const last = index === shown.entries.length - 1;
        if (last && shown.cut) expectPrefixOf(field, entries[index]![1]);
        else expect(toJs(field)).toEqual(entries[index]![1]);
      });
      if (!shown.cut) expect(shown.entries.length).toBe(entries.length);
    }
  }
}

describe("decision input previews", () => {
  it("reads a whole preview exactly as JSON.parse does", () => {
    fc.assert(fc.property(jsonValue, (value) => {
      const parsed = parseInputPreview(JSON.stringify(value), false);
      expect(parsed && toJs(parsed)).toEqual(JSON.parse(JSON.stringify(value)));
    }), { numRuns: 400 });
  });

  it("reads a whole string, object or array the same way when told it may be cut", () => {
    fc.assert(fc.property(container, (value) => {
      const parsed = parsePartialPreview(JSON.stringify(value));
      expect(parsed && toJs(parsed)).toEqual(JSON.parse(JSON.stringify(value)));
    }), { numRuns: 400 });
  });

  it("shows only a prefix of a cut preview, wherever the cut falls", () => {
    fc.assert(fc.property(container, fc.nat(), (value, at) => {
      const text = JSON.stringify(value);
      const cut = text.slice(0, at % (text.length + 1));
      const shown = parsePartialPreview(cut);
      // Every value here is a string, object or array, so any non-empty
      // cut has something to show, if only an empty cut container.
      if (cut.length > 0) expect(shown).toBeDefined();
      if (shown) expectPrefixOf(shown, JSON.parse(text));
    }), { numRuns: 1_000 });
  });

  it("summarizes an object by its first text field", () => {
    const shown = parseInputPreview(
      JSON.stringify({ count: 3, visualReference: "Settings window", A: { title: "One" } }),
      false,
    );
    expect(previewSummary(shown, "")).toBe("Settings window");
  });

  it("keeps the fields before a cut that falls inside a number or literal", () => {
    for (const [text, entries] of [
      ['{"a":"x","b":nu', [["a", { kind: "text", text: "x" }]]],
      ['{"a":"x","b":12', [["a", { kind: "text", text: "x" }]]],
      ['{"a":"x","b":tr', [["a", { kind: "text", text: "x" }]]],
      ['{"a":"x","b', [["a", { kind: "text", text: "x" }]]],
    ] as const) {
      expect(parsePartialPreview(text)).toEqual({ kind: "object", cut: true, entries });
    }
  });

  it("keeps the fields before a cut and marks the one it falls in", () => {
    const text = JSON.stringify({ visualReference: "Settings window", A: { title: "Copying images from PwrSnap" } });
    const shown = parseInputPreview(text.slice(0, text.length - 12), true);
    expect(shown).toEqual({
      kind: "object",
      cut: true,
      entries: [
        ["visualReference", { kind: "text", text: "Settings window" }],
        ["A", { kind: "object", cut: true, entries: [["title", { kind: "text", text: "Copying images fro", cut: true }]] }],
      ],
    });
  });
});
