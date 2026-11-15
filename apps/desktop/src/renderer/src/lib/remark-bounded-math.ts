import type { Options } from "mdast-util-from-markdown";

/**
 * Install after remark-math. Its text tokenizer retries a tail scan for every
 * unmatched dollar-run length. Record the last occurrence of each length on
 * the first upstream attempt that fails at EOF, then skip later attempts that
 * cannot possibly close. Do not read ahead of upstream: crossing container
 * continuations installs column skips that micromark checks do not roll back.
 * Successful attempts still use the original tokenizer and resolver unchanged.
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
        const now = () => this.now();
        const offset = now().offset;
        if (cached) {
          const knownRuns = cached;
          const start = tokenize.call(this, effects, ok, nok);
          return effects.check({
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
                return (knownRuns.get(length) ?? -1) > offset
                  ? checkOk(code)
                  : checkNok(code);
              }
            },
          }, start, nok);
        }

        const runs = new Map<number, number>();
        let length = 0;
        let runStart = offset;
        return tokenize.call(this, {
          ...effects,
          consume(code) {
            if (code === 36) {
              if (length === 0) runStart = now().offset;
              length += 1;
            } else if (length > 0) {
              runs.set(length, runStart);
              length = 0;
            }
            effects.consume(code);
          },
        }, ok, (code) => {
          // An early rejection (for example disabled single-dollar math) has
          // not inspected the suffix and cannot provide a complete index.
          if (code === null) {
            if (length > 0) runs.set(length, runStart);
            lastRuns.set(this, runs);
          }
          return nok(code);
        });
      };
    }
  }
}
