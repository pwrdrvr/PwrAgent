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

  it("stays linear on thousands of unclosed or consecutive language fences", () => {
    const unclosed = Array.from({ length: 4_000 }, () => "```ts").join("\n");
    const start = performance.now();
    expect(repairNestedLanguageFences(unclosed)).toBe(unclosed);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(250);
  });
});
