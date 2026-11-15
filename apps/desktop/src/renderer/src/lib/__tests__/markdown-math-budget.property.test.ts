import fc from "fast-check";
import { fromMarkdown, type Options } from "mdast-util-from-markdown";
import remarkMath from "remark-math";
import { describe, expect, it } from "vitest";
import { remarkBoundedMath } from "../remark-bounded-math";

function parser(bounded = true, singleDollarTextMath = false) {
  const data: {
    micromarkExtensions?: Options["extensions"];
    fromMarkdownExtensions?: Options["mdastExtensions"];
  } = {};
  const processor = { data: () => data };
  // Obtain both extensions from the installed remark-math, just as unified does.
  remarkMath.call(processor as never, { singleDollarTextMath });
  if (bounded) remarkBoundedMath.call(processor);
  let work = 0;
  const seen = new WeakSet<object>();
  for (const extension of data.micromarkExtensions ?? []) {
    const candidates = extension.text?.[36];
    for (const construct of Array.isArray(candidates) ? candidates : [candidates]) {
      if (construct?.name !== "mathText") continue;
      const tokenize = construct.tokenize;
      construct.tokenize = function (effects, ok, nok) {
        // Micromark shares this effects object with nested checks/attempts.
        // Count real consumption, including speculative work later rolled back.
        if (!seen.has(effects)) {
          seen.add(effects);
          const consume = effects.consume;
          effects.consume = (code) => { work += 1; consume(code); };
        }
        return tokenize.call(this, effects, ok, nok);
      };
    }
  }
  return {
    parse(source: string) {
      work = 0;
      const tree = fromMarkdown(source, {
        extensions: data.micromarkExtensions,
        mdastExtensions: data.fromMarkdownExtensions,
      });
      return { tree, work };
    },
  };
}

function malformed(k: number): string {
  return "prefix " + Array.from({ length: k }, (_, i) => "$".repeat(i + 2) + "x").join(" ");
}

describe("Markdown math parser work", () => {
  // Unmatched runs must cost O(source length), including rolled-back scans.
  it.each([128, 256, 512])("bounds the increasing-run regression at k=%i", (k) => {
    const source = malformed(k);
    const { tree, work } = parser().parse(source);
    expect(tree).toEqual(fromMarkdown(source));
    expect(work).toBeLessThanOrEqual(4 * source.length);
  });

  it("bounds generated unmatched run orders", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.integer({ min: 2, max: 160 }), { minLength: 32, maxLength: 64, size: "max" }),
      (runs) => {
        const source = "prefix " + runs.map((n) => "$".repeat(n) + "x").join(" ");
        const { tree, work } = parser().parse(source);
        expect(tree).toEqual(fromMarkdown(source));
        expect(work).toBeLessThanOrEqual(4 * source.length);
      },
    ), { numRuns: 25 });
  });

  // The installed parser is the syntax oracle, including every source position.
  // Keep code, escaping, container boundaries and math content in that oracle.
  it.each([false, true])("preserves container continuation positions (singleDollarTextMath=%s)", (single) => {
    const bounded = parser(true, single);
    const upstream = parser(false, single);
    fc.assert(fc.property(
      fc.constantFrom("> ", "- ", "> > ", "> - "),
      fc.constantFrom("$", "$$", "$$x$$"),
      fc.constantFrom("\n", "\r\n"),
      fc.constantFrom("`$$`$$", "$$x", "$$$x$$$$y", "`a` $z"),
      (container, opening, newline, tail) => {
        const source = `prefix ${newline}${container}${opening}${newline}${container}${tail}`;
        expect(bounded.parse(source).tree).toEqual(upstream.parse(source).tree);
      },
    ));
  });

  it.each([false, true])("matches upstream syntax (singleDollarTextMath=%s)", (single) => {
    const bounded = parser(true, single);
    const upstream = parser(false, single);
    fc.assert(fc.property(fc.array(fc.constantFrom(
      "$$", "$$$", "$$$$", "$", "x", " y ", "\\$", "\\\\$",
      "`", "``", "```txt\n", "~~~\n", "\n", "\r\n", "\t", "    ",
      "> ", "- ", "[", "](url)", "*", "é😀", "\\(", "\\)",
    ), { minLength: 1, maxLength: 40, size: "max" }), (parts) => {
      const source = "prefix " + parts.join("");
      expect(bounded.parse(source).tree).toEqual(upstream.parse(source).tree);
    }));
  });

  it.each([
    "prefix \n> $\n> `$$`$$",
    "prefix $$ x $$$ y $$ suffix",
    "prefix $$$x\ny$$$ tail",
    "prefix `$$code$$` $$math$$",
    "```txt\n$$code$$\n```\n\n$$math$$",
    "    $$code$$\n\n> $$math$$\n\n- $$$list$$$",
    String.raw`prefix \$$x$$ and $$y\$$ tail`,
    "prefix $$\tx😀\r\ny $$",
    "$$\nx\n$$\n\ntext $$$y$$$",
  ])("matches the oracle at every streaming prefix: %s", (source) => {
    // Reuse one plugin instance across reparses: a cache from an incomplete
    // source must never reject its later closing delimiter or a replacement.
    const bounded = parser();
    const upstream = parser(false);
    for (let end = 0; end <= source.length; end += 1) {
      const prefix = source.slice(0, end);
      expect(bounded.parse(prefix).tree).toEqual(upstream.parse(prefix).tree);
    }
    expect(bounded.parse("prefix $$$replacement$$$").tree)
      .toEqual(upstream.parse("prefix $$$replacement$$$").tree);
  });

  it("preserves valid math following the malformed increasing runs", () => {
    const source = malformed(128) + "\n\nprefix $$valid$$ and $$$also valid$$$";
    const { tree, work } = parser().parse(source);
    expect(tree).toEqual(parser(false).parse(source).tree);
    expect(tree.children.at(-1)).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "prefix " },
        { type: "inlineMath", value: "valid" },
        { type: "text", value: " and " },
        { type: "inlineMath", value: "also valid" },
      ],
    });
    expect(work).toBeLessThanOrEqual(4 * source.length);
  });
});
