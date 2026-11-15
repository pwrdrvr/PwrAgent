import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatCodexProviderModelId } from "../codex-model-providers";
import { formatPricingModelLabel } from "../local-model-pricing";

const segment = fc.stringMatching(/^[a-z][a-z0-9_-]{0,15}$/);
const provider = segment;
const absolutePath = fc.tuple(
  fc.constantFrom("/", "C:\\", "\\\\server\\"),
  fc.array(segment, { minLength: 1, maxLength: 8 }),
  segment,
).map(([root, directories, file]) => {
  const separator = root === "/" ? "/" : "\\";
  return { model: `${root}${directories.join(separator)}${separator}${file}.gguf`, basename: `${file}.gguf` };
});

describe("pricing model label properties", () => {
  it("shows only the filename of an absolute model path, with or without provider qualification", () => {
    fc.assert(fc.property(provider, absolutePath, (id, { model, basename }) => {
      const qualified = formatCodexProviderModelId(id, model);
      for (const raw of [model, qualified]) {
        expect(formatPricingModelLabel(raw)).toBe(basename);
        // Model options can supply the unqualified protocol path as a label.
        expect(formatPricingModelLabel(raw, model)).toBe(basename);
        expect(formatPricingModelLabel(raw, "PrismML Bonsai 2 27B")).toBe("PrismML Bonsai 2 27B");
      }
    }));
  });

  it("preserves non-filesystem protocol IDs, including qualified remote namespaces", () => {
    fc.assert(fc.property(provider, segment, segment, (id, vendor, model) => {
      const remote = `${vendor}/${model}`;
      expect(formatPricingModelLabel(remote)).toBe(remote);
      const qualified = formatCodexProviderModelId(id, remote);
      expect(formatPricingModelLabel(qualified)).toBe(qualified);
    }));
  });

  it("shortens the historical Bonsai path without changing a friendly catalog name", () => {
    const model = "@bonsai//models/Ternary-Bonsai-2-27B.gguf";
    expect(formatPricingModelLabel(model)).toBe("Ternary-Bonsai-2-27B.gguf");
    expect(formatPricingModelLabel(model, "PrismML Bonsai 2 27B")).toBe("PrismML Bonsai 2 27B");
  });
});
