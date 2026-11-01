import { appCss } from "./css-rule-body";

/**
 * A walk of `app.css` into style rules tagged with their enclosing at-rules,
 * shared by the reduced-motion contract and the component tests that check a
 * rendered element against it.
 */
export type StyleRule = {
  /** The rule's comma-separated selectors, trimmed. */
  selectors: string[];
  /** Declarations directly in this rule, comments and nesting stripped. */
  body: string;
  /** Enclosing at-rule preludes, outermost first (e.g. `@media (…)`). */
  atRules: string[];
};

/**
 * Walks `app.css` into a flat list of style rules, each tagged with the
 * at-rules it sits inside.
 *
 * Hand-rolled rather than regex-matched because the enclosing at-rule is the
 * whole point here: a rule that neutralizes an animation is only a fix if it
 * is inside a `reduce` query, and a `@media`-nested rule is exactly what the
 * sibling contract tests' `extractRuleBody` warns it cannot see. Comments are
 * stripped first so a selector or a declaration quoted inside prose (this file
 * has neighbours full of it) cannot register as CSS.
 */
export function parseStyleRules(source: string): StyleRule[] {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: StyleRule[] = [];
  const atRules: string[] = [];
  // `null` marks an at-rule frame, so a closing brace knows whether it is
  // ending a block that contributes a rule or one that only nests.
  const frames: (StyleRule | null)[] = [];
  let prelude = "";

  for (const char of stripped) {
    if (char === "{") {
      const trimmed = prelude.trim();
      prelude = "";
      if (trimmed.startsWith("@")) {
        atRules.push(trimmed);
        frames.push(null);
      } else {
        frames.push({
          selectors: trimmed.split(",").map((selector) => selector.trim()),
          body: "",
          // Snapshotted here rather than referenced: `atRules` is mutated as
          // the walk continues past this rule.
          atRules: [...atRules],
        });
      }
      continue;
    }

    if (char === "}") {
      const frame = frames.pop();
      if (frame === null) {
        atRules.pop();
      } else if (frame) {
        // Everything since this frame opened is its declaration list.
        // `app.css` uses no native nesting (no `&` selectors), so a style
        // rule's braces contain declarations and nothing else.
        rules.push({ ...frame, body: prelude.trim() });
      }
      prelude = "";
      continue;
    }

    prelude += char;
  }

  if (frames.length > 0) {
    // An unbalanced walk mis-nests everything after the offending brace, and
    // the failure mode is silent under-reporting: rules land under the wrong
    // at-rule stack and the gate stops seeing them. The parser has no string
    // or `url()` awareness, so a future `content: "{"` would do exactly that.
    throw new Error(
      `app.css did not parse into balanced rules (${frames.length} unclosed)`,
    );
  }

  return rules;
}

// Hoisted: `hasMotionQuery` runs once per rule while the reduce selectors are
// built, and recompiling a constant pattern thousands of times buys nothing.
const MOTION_QUERY_PATTERNS = {
  "no-preference": /prefers-reduced-motion:\s*no-preference\b/,
  "reduce": /prefers-reduced-motion:\s*reduce\b/,
} as const;

/** True when this at-rule stack contains a reduced-motion query of `kind`. */
export function hasMotionQuery(
  atRules: readonly string[],
  kind: keyof typeof MOTION_QUERY_PATTERNS,
): boolean {
  return atRules.some((atRule) => MOTION_QUERY_PATTERNS[kind].test(atRule));
}

/** Every style rule in `app.css`. */
export const appStyleRules = parseStyleRules(appCss);

/**
 * Selectors that stop a `.pending-spinner` under reduced motion: the rings
 * that sit beside text naming the work. A component test can assert a busy
 * ring it renders matches one of these, so a ring that falls outside the
 * selector list fails in the component's own suite.
 */
export const reducedMotionPairedRingSelectors = appStyleRules
  .filter(
    (rule) =>
      hasMotionQuery(rule.atRules, "reduce")
      && /(?:^|[;\s])animation:\s*none\b/.test(rule.body),
  )
  .flatMap((rule) => rule.selectors)
  .filter((selector) => /\.pending-spinner$/.test(selector));
