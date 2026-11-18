import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyTomlEdits, parseTomlTables, type TomlEdit } from "../settings/toml-editor";

describe("adjacent TOML compatibility arrays", () => {
  it("replaces every row exactly once and preserves a single marker across repeated saves", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 5 }), (ownCount, legacyCount) => {
      const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ provider: `fixture-${index}` }));
      const comment = "# pwragent-legacy-settings key=provider_defaults shape=backend-table-array used_through=1.4.10 kept_for_older_clients";
      const edits: TomlEdit[] = [
        { op: "setTableArray", path: ["models", "model_provider_defaults"], value: rows(ownCount) },
        { op: "setTableArray", path: ["models", "provider_defaults"], value: rows(legacyCount), comment },
      ];
      const first = applyTomlEdits('# keep\n[models]\nunrelated = "keep"\n', edits);
      const saved = applyTomlEdits(first, edits);
      const tables = parseTomlTables(saved, "test.toml");
      expect(tables.models.model_provider_defaults).toEqual(rows(ownCount));
      expect(tables.models.provider_defaults).toEqual(rows(legacyCount));
      expect(saved.match(/# pwragent-legacy-settings/g)).toHaveLength(1);
      expect(saved).toContain('# keep\n[models]\nunrelated = "keep"');
      expect(applyTomlEdits(saved, edits)).toBe(saved);
    }));
  });

  it("does not leave a duplicate legacy row when its preceding array is replaced", () => {
    const comment = "# pwragent-legacy-settings key=provider_defaults shape=backend-table-array used_through=1.4.9 kept_for_older_clients";
    const source = `[[models.model_provider_defaults]]\nprovider = "codex"\n\n${comment}\n[[models.provider_defaults]]\nprovider = "codex"\n`;
    const saved = applyTomlEdits(source, [
      { op: "setTableArray", path: ["models", "model_provider_defaults"], value: [{ provider: "codex" }] },
      { op: "setTableArray", path: ["models", "provider_defaults"], value: [{ provider: "codex" }], comment: comment.replace("1.4.9", "1.4.10") },
    ]);
    expect(parseTomlTables(saved, "test.toml").models.provider_defaults).toHaveLength(1);
    expect(saved).toContain(comment);
  });
});
