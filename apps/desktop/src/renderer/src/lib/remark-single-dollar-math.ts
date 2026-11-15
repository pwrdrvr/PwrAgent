import type { Options as MarkdownParserOptions } from "mdast-util-from-markdown";

/**
 * Run after remark-math. Keep its tokenizer, code protection, and source
 * positions, but require single-dollar pairs to have tight inner boundaries
 * and whitespace, closing punctuation, or Markdown formatting after the closer.
 * Prices such as $5 and $10 stay text beside parenthesized math or code.
 * Multi-dollar syntax retains remark-math's existing behavior.
 */
export function remarkSingleDollarMath(this: {
  data(): unknown;
}): void {
  const data = this.data() as { micromarkExtensions?: MarkdownParserOptions["extensions"] };
  const extension = data.micromarkExtensions?.at(-1);
  const candidates = extension?.text?.[36];
  for (const construct of Array.isArray(candidates) ? candidates : [candidates]) {
    if (construct?.name !== "mathText") continue;
    const tokenize = construct.tokenize;
    construct.tokenize = function (effects, ok, nok) {
      const start = tokenize.call(this, effects, ok, nok);
      return effects.check({
        tokenize(checkEffects, checkOk, checkNok) {
          let previous: number | null = null;
          return opening;

          function opening(code: number | null): ReturnType<typeof checkOk> {
            // This scratch token is discarded by effects.check.
            checkEffects.enter("data");
            checkEffects.consume(code);
            return afterOpening;
          }

          function afterOpening(code: number | null): ReturnType<typeof checkOk> {
            if (code === 36) {
              checkEffects.exit("data");
              return checkOk(code);
            }
            if (isWhitespace(code)) return checkNok(code);
            return content(code);
          }

          function content(code: number | null): ReturnType<typeof checkOk> {
            // Micromark uses -5 through -3 for line endings. Keep single-dollar
            // math on one line and prevent prices from consuming later code.
            if (code === null || code <= -3 || code === 96) return checkNok(code);
            if (code === 36) {
              // Reject a trailing opening bracket so a price cannot consume
              // a later parenthesized expression: "$10. Formula ($-x$)".
              if (isWhitespace(previous) || previous === 40 || previous === 91 || previous === 123) {
                return checkNok(code);
              }
              checkEffects.consume(code);
              return afterClosing;
            }
            previous = code;
            checkEffects.consume(code);
            return content;
          }

          function afterClosing(code: number | null): ReturnType<typeof checkOk> {
            if (code !== null && code >= 0 && !/[\s.,;:!?)}\]'"”’*_~`—–-]/u.test(String.fromCodePoint(code))) {
              return checkNok(code);
            }
            checkEffects.exit("data");
            return checkOk(code);
          }
        },
      }, start, nok);
    };
  }
}

function isWhitespace(code: number | null): boolean {
  return code === null || code <= 32 || /\s/u.test(String.fromCodePoint(code));
}
