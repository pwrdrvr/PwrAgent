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

  it("assigns strictly unique GitHub-style slugs to every non-empty heading sequence", () => {
    const headingWord = fc.constantFrom("Setup", "Setup 1", "API v2", "C++ & Rust", "Overview", "Notes");
    fc.assert(
      fc.property(fc.array(headingWord, { minLength: 1, maxLength: 20 }), (headings) => {
        const slugs = assignGithubHeadingSlugs(headings);
        expect(slugs).toHaveLength(headings.length);
        const nonEmpty = slugs.filter(Boolean);
        expect(new Set(nonEmpty).size).toBe(nonEmpty.length);
        for (let i = 0; i < headings.length; i += 1) {
          const base = slugifyGithubHeading(headings[i]!);
          if (base) {
            expect(slugs[i] === base || slugs[i]!.startsWith(`${base}-`)).toBe(true);
          }
        }
      }),
    );
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
