import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assignGithubHeadingSlugs,
  isSafeMarkdownFragmentUrl,
  orderedListGutter,
  orderedListMaxDigitCount,
  slugifyGithubHeading,
} from "../markdown-anchors";

describe("markdown-anchors properties", () => {
  it("accepts non-empty fragment URLs without whitespace or control chars and rejects unsafe schemes", () => {
    const safeFragmentBody = fc
      .string({ minLength: 1, maxLength: 40 })
      .filter((value) => !/[\s\u0000-\u001f\u007f]/.test(value));

    fc.assert(
      fc.property(safeFragmentBody, (fragment) => {
        expect(isSafeMarkdownFragmentUrl(`#${fragment}`)).toBe(true);
      }),
    );

    const unsafeSchemes = fc.constantFrom(
      "javascript:alert(1)",
      "javascript:alert(1)#heading",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "http://example.com#section",
      "https://example.com#section",
      "",
      "#",
      "#has space",
      "#has\nnewline",
      "#has\ttab",
      "#has\u0000null",
    );

    fc.assert(
      fc.property(unsafeSchemes, (url) => {
        expect(isSafeMarkdownFragmentUrl(url)).toBe(false);
      }),
    );
  });

  it("assigns strictly unique GitHub-style slugs matching the naive deduplication oracle", () => {
    const naiveOracle = (texts: readonly string[]): string[] => {
      const seen = new Set<string>();
      return texts.map((text) => {
        const base = slugifyGithubHeading(text);
        if (!base) {
          return "";
        }
        let candidate = base;
        let suffix = 1;
        while (seen.has(candidate)) {
          candidate = `${base}-${suffix}`;
          suffix += 1;
        }
        seen.add(candidate);
        return candidate;
      });
    };

    const headingWord = fc.constantFrom(
      "Setup",
      "Setup 1",
      "Setup 2",
      "Setup-1",
      "Setup-1-1",
      "API v2",
      "C++ & Rust",
      "Overview",
      "Notes",
      "   ",
    );
    fc.assert(
      fc.property(fc.array(headingWord, { minLength: 1, maxLength: 30, size: "max" }), (headings) => {
        const slugs = assignGithubHeadingSlugs(headings);
        expect(slugs).toEqual(naiveOracle(headings));
        const nonEmpty = slugs.filter(Boolean);
        expect(new Set(nonEmpty).size).toBe(nonEmpty.length);
      }),
    );
  });

  it("deduplicates repeated headings in linear Set.has lookups rather than quadratic rescans", () => {
    const count = 500;
    const headings = Array.from({ length: count }, () => "Details");
    const originalHas = Set.prototype.has;
    let hasCalls = 0;
    Set.prototype.has = function (value: unknown) {
      hasCalls += 1;
      return originalHas.call(this, value);
    };
    try {
      const slugs = assignGithubHeadingSlugs(headings);
      expect(slugs[0]).toBe("details");
      expect(slugs[count - 1]).toBe(`details-${count - 1}`);
      // Pre-fix code restarted suffix=1 on every duplicate and made 125,250 lookups.
      expect(hasCalls).toBeLessThanOrEqual(count * 3);
    } finally {
      Set.prototype.has = originalHas;
    }
  });

  it("matches the brute-force maximum marker digit count for every ordered list range", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 1, max: 200 }),
        (start, itemCount) => {
          let oracleMax = 0;
          for (let i = 0; i < itemCount; i += 1) {
            oracleMax = Math.max(oracleMax, String(start + i).length);
          }
          expect(orderedListMaxDigitCount(start, itemCount)).toBe(oracleMax);
          const gutter = orderedListGutter(start, itemCount);
          if (oracleMax <= 1) {
            expect(gutter).toBeUndefined();
          } else {
            expect(gutter).toBe(`calc(${oracleMax}ch + 1.15em)`);
          }
        },
      ),
    );
  });
});
