import type { Options } from "mdast-util-from-markdown";

/**
 * Install after remark-math. Its text tokenizer retries a tail scan for every
 * unmatched dollar-run length. Index the last occurrence of each length once
 * per micromark text context, then skip attempts that cannot possibly close.
 * Successful attempts still use the original tokenizer and resolver unchanged.
 * Checks roll back all scratch tokens/consumption, preserving source positions.
 * Contexts belong to one inline source: reparsing a streamed update builds a
 * fresh index, and the WeakMap does not retain previous messages or updates.
 */
export function remarkBoundedMath(this: {
  data(): unknown;
}): void {
  const data = this.data() as { micromarkExtensions?: Options["extensions"] };
  const lastRuns = new WeakMap<object, Map<number, number>>();
  for (const extension of data.micromarkExtensions ?? []) {
    const candidates = extension.text?.[36];
    for (const construct of Array.isArray(candidates) ? candidates : [candidates]) {
      if (construct?.name !== "mathText") continue;
      const tokenize = construct.tokenize;
      construct.tokenize = function (effects, ok, nok) {
        const cached = lastRuns.get(this);
        const runs = cached ?? new Map<number, number>();
        const remember = () => lastRuns.set(this, runs);
        const now = () => this.now();
        const offset = now().offset;
        const start = tokenize.call(this, effects, ok, nok);
        const checkOpening = effects.check({
          tokenize(checkEffects, checkOk, checkNok) {
            let length = 0;
            return opening;

            function opening(code: number | null): ReturnType<typeof checkOk> {
              if (length === 0) checkEffects.enter("data");
              if (code === 36) {
                length += 1;
                checkEffects.consume(code);
                return opening;
              }
              checkEffects.exit("data");
              return (runs.get(length) ?? -1) > offset
                ? checkOk(code)
                : checkNok(code);
            }
          },
        }, start, nok);
        if (cached) return checkOpening;

        return effects.check({
          tokenize(checkEffects, checkOk) {
            let length = 0;
            let runStart = offset;
            checkEffects.enter("data");
            return scan;

            function scan(code: number | null): ReturnType<typeof checkOk> {
              if (code === 36) {
                if (length === 0) runStart = now().offset;
                length += 1;
              } else if (length > 0) {
                runs.set(length, runStart);
                length = 0;
              }
              if (code === null) {
                checkEffects.exit("data");
                remember();
                return checkOk(code);
              }
              checkEffects.consume(code);
              return scan;
            }
          },
        }, checkOpening, nok);
      };
    }
  }
}
