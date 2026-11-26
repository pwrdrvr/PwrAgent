import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { repairNestedLanguageFences } from "../markdown-fences";

const fenceLineArb = fc.oneof(
  fc.constant("```"),
  fc.constant("````"),
  fc.constant("```ts"),
  fc.constant("```swift"),
  fc.constant("```text"),
  fc.constant("````md"),
  fc.constant("plain text line"),
  fc.constant("const x = 1;"),
  fc.constant(""),
);

describe("repairNestedLanguageFences properties", () => {
  it("is idempotent and preserves line count and all non-fence lines", () => {
    fc.assert(
      fc.property(
        fc.array(fenceLineArb, { minLength: 1, maxLength: 30 }),
        (lines) => {
          const input = lines.join("\n");
          const once = repairNestedLanguageFences(input);
          const twice = repairNestedLanguageFences(once);

          expect(twice).toBe(once);

          const outLines = once.split("\n");
          expect(outLines).toHaveLength(lines.length);
          for (let index = 0; index < lines.length; index += 1) {
            if (!lines[index]!.startsWith("```")) {
              expect(outLines[index]).toBe(lines[index]);
            }
          }
        },
      ),
    );
  });

  it("never alters sequences of consecutive well-formed single-level code blocks", () => {
    const blockArb = fc.record({
      lang: fc.constantFrom("", "ts", "js", "py", "sh"),
      body: fc.array(fc.constantFrom("const a = 1;", "echo hi", ""), {
        minLength: 0,
        maxLength: 3,
      }),
    });
    fc.assert(
      fc.property(
        fc.array(blockArb, { minLength: 1, maxLength: 12 }),
        (blocks) => {
          const input = blocks
            .map((block) => [`\`\`\`${block.lang}`, ...block.body, "```"].join("\n"))
            .join("\n\n");
          expect(repairNestedLanguageFences(input)).toBe(input);
        },
      ),
    );
  });

  it("preserves valid multi-length nested CommonMark fences untouched", () => {
    const outerLenArb = fc.integer({ min: 4, max: 6 });
    const outerLangArb = fc.constantFrom("", "md", "markdown");
    const trailingLangArb = fc.constantFrom("", "ts", "sh");

    fc.assert(
      fc.property(
        outerLenArb,
        outerLangArb,
        trailingLangArb,
        fc.array(
          fc.record({
            kind: fc.constantFrom("bare", "lang", "text"),
            lengthOffset: fc.integer({ min: 1, max: 3 }),
            lang: fc.constantFrom("ts", "json", "py"),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (outerLen, outerLang, trailingLang, innerItems) => {
          const outerFence = "`".repeat(outerLen);
          const innerLines = innerItems.map((item) => {
            if (item.kind === "text") {
              return "example content";
            }
            const innerLen = Math.max(3, outerLen - item.lengthOffset);
            return item.kind === "bare"
              ? "`".repeat(innerLen)
              : `${"`".repeat(innerLen)}${item.lang}`;
          });
          const input = [
            `${outerFence}${outerLang}`,
            ...innerLines,
            outerFence,
            "",
            `\`\`\`${trailingLang}`,
            "const after = 1;",
            "```",
          ].join("\n");

          expect(repairNestedLanguageFences(input)).toBe(input);
        },
      ),
    );

    // Explicit regressions for bare shorter fence and unclosed inner language
    // fence inside a 4-backtick outer fence followed by a later code block.
    const bareShorterInsideFour = [
      "````md",
      "```",
      "example",
      "````",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");
    expect(repairNestedLanguageFences(bareShorterInsideFour)).toBe(
      bareShorterInsideFour,
    );

    const unclosedInnerLangInsideFour = [
      "````md",
      "```ts",
      "code",
      "````",
      "",
      "```",
      "plain",
      "```",
    ].join("\n");
    expect(repairNestedLanguageFences(unclosedInnerLangInsideFour)).toBe(
      unclosedInnerLangInsideFour,
    );
  });

  it("stays linear on thousands of unclosed or consecutive language fences", () => {
    const unclosed = Array.from({ length: 4_000 }, () => "```ts").join("\n");
    const start = performance.now();
    expect(repairNestedLanguageFences(unclosed)).toBe(unclosed);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(250);

    const deepInsideLongOuter = [
      "`".repeat(10) + "md",
      ...Array.from({ length: 4_000 }, () => "```ts"),
      "````",
      "`".repeat(10),
    ].join("\n");
    const deepStart = performance.now();
    expect(repairNestedLanguageFences(deepInsideLongOuter)).toBe(
      deepInsideLongOuter,
    );
    expect(performance.now() - deepStart).toBeLessThan(250);
  });
});
