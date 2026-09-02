import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The renderer's `prefers-reduced-motion` contract.
 *
 * An operator turned macOS **Reduce Motion** on with the app running and eight
 * thinking scanners kept sweeping at the same speed — because
 * `.thinking-scanner__beam` had no reduced-motion rule at all. Nothing caught
 * it: the beam is the app's most repeated animation, and the gap was invisible
 * in review because every OTHER looping indicator did have one.
 *
 * So the gate below is not "does the scanner stop". It is: **every** rule in
 * `app.css` that declares an infinite animation must either be declared inside
 * a `no-preference` query, be neutralized by name inside a `reduce` query, or
 * appear on the exemption list at the bottom of this file with a reason. The
 * next looping indicator someone adds fails here until they decide what it does
 * under the preference.
 *
 * Scope is deliberately *infinite* animations. Continuous motion is what the
 * preference is most for, and it is what an operator sits inside for the whole
 * length of a turn; one-shot enters and transitions are handled case by case
 * in `app.css` and are not worth a blanket gate.
 */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

type StyleRule = {
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
function parseStyleRules(source: string): StyleRule[] {
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

const rules = parseStyleRules(css);

// Hoisted: `hasMotionQuery` runs once per rule while `reducedSelectors` is
// built, and recompiling a constant pattern thousands of times buys nothing.
const MOTION_QUERY_PATTERNS = {
  "no-preference": /prefers-reduced-motion:\s*no-preference\b/,
  "reduce": /prefers-reduced-motion:\s*reduce\b/,
} as const;

/** True when this at-rule stack contains a reduced-motion query of `kind`. */
function hasMotionQuery(
  atRules: readonly string[],
  kind: keyof typeof MOTION_QUERY_PATTERNS,
): boolean {
  return atRules.some((atRule) => MOTION_QUERY_PATTERNS[kind].test(atRule));
}

/**
 * Selectors whose ANIMATION is settled by name inside a `reduce` query.
 *
 * Two narrowings, and both are load-bearing:
 *
 * The rule has to declare an `animation` property. Appearing in a `reduce`
 * block is not the same as being stopped by one — `.star-map__sky`,
 * `.star-map-card` and `.settings-nav__sublist` are all in `reduce` blocks
 * that only touch `transform` or `transition`, so a plain membership test
 * would hand any of them a free pass the day someone gives it a looping
 * animation. Declaring `animation` (rather than literally `animation: none`)
 * is the right bar: `.onboarding-wizard__safety-ack-flash` legitimately
 * settles the preference by swapping in a non-looping animation.
 *
 * And it is matched on the selector STRING, not on cascade semantics: a rule
 * that stops `.foo .bar` does not settle what `.bar` does on its own, and
 * treating it as if it did is how `.pending-spinner`'s deliberate exemption
 * would have gone unnoticed.
 */
const reducedSelectors = new Set(
  rules
    .filter(
      (rule) =>
        hasMotionQuery(rule.atRules, "reduce")
        && /(?:^|[;{\s])animation(?:-[a-z-]+)?:/.test(rule.body),
    )
    .flatMap((rule) => rule.selectors),
);

/**
 * A looping animation that is allowed to keep running under the preference,
 * and why. Each entry is a decision, not a backlog item — adding one is
 * asserting that the motion is load-bearing.
 */
const MOTION_EXEMPTIONS: Record<string, string> = {
  // `app.css` states this exemption at the rule itself: a ring that is the
  // ONLY signal its surface has (the composer's Run button swaps the play
  // glyph for a bare, aria-hidden ring) keeps spinning, because motion that is
  // the sole indication of progress is not the non-essential motion the
  // preference asks to stop. Rings that sit beside text — `.settings-pending
  // .pending-spinner` — ARE stopped, which is why the bare selector cannot
  // inherit that rule's coverage.
  ".pending-spinner":
    "standalone busy ring with no text companion; the reduce rule covers the paired `.settings-pending .pending-spinner` instead",
};

describe("app.css reduced-motion contract", () => {
  const loopingRules = rules.filter((rule) =>
    /animation:[^;]*\binfinite\b/.test(rule.body),
  );

  it("finds the looping animations it is meant to gate", () => {
    // A parser that silently matched nothing would make every assertion below
    // vacuously true, which is the one failure mode this gate cannot survive.
    expect(loopingRules.length).toBeGreaterThanOrEqual(5);
    expect(loopingRules.flatMap((rule) => rule.selectors)).toContain(
      ".thinking-scanner__beam",
    );
  });

  it("does not count a reduce rule that leaves the animation alone", () => {
    // The narrowing that makes `reducedSelectors` mean something. These two
    // sit in `reduce` blocks that only zero a `transition`, so they must NOT
    // register as an animation decision — otherwise giving either one a
    // looping animation later would pass the gate with nothing stopping it.
    // A canary, because widening the filter back out breaks no other test.
    expect(reducedSelectors.has(".automations-table__disclosure")).toBe(false);
    expect(reducedSelectors.has(".settings-nav__sublist")).toBe(false);
    // While a rule that does settle the animation still registers.
    expect(reducedSelectors.has(".status-dot--blink")).toBe(true);
    expect(reducedSelectors.has(".thinking-scanner__beam")).toBe(true);
  });

  it("gives every infinite animation a reduced-motion decision", () => {
    const undecided = loopingRules
      .filter((rule) => !hasMotionQuery(rule.atRules, "no-preference"))
      // Only the selectors that actually lack a decision — reporting a
      // partially-covered rule's whole selector list would point the author at
      // selectors that are already settled.
      .flatMap((rule) =>
        rule.selectors.filter(
          (selector) =>
            !reducedSelectors.has(selector)
            // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a
            // selector named `constructor` or `toString` would exempt itself.
            && !Object.hasOwn(MOTION_EXEMPTIONS, selector),
        ),
      );

    // Named in the message, not just counted: the point of failing here is to
    // hand the author the selector they have to make a call about.
    expect(undecided).toEqual([]);
  });

  it("keeps the exemption list to motion that is a surface's only signal", () => {
    // An exemption for a selector that no longer loops is stale permission
    // sitting in the file, so the list is pinned in both directions.
    const looping = new Set(loopingRules.flatMap((rule) => rule.selectors));
    for (const [selector, reason] of Object.entries(MOTION_EXEMPTIONS)) {
      expect(looping.has(selector)).toBe(true);
      expect(reducedSelectors.has(selector)).toBe(false);
      // The reason is the whole cost of an exemption. An empty one is an
      // undecided animation wearing a decision's clothes.
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("thinking scanner under reduced motion", () => {
  const beamRules = rules.filter((rule) =>
    rule.selectors.includes(".thinking-scanner__beam"),
  );
  const sweeping = beamRules.find(
    (rule) => rule.atRules.length === 0 && /animation:/.test(rule.body),
  );
  const parked = beamRules.find((rule) =>
    hasMotionQuery(rule.atRules, "reduce"),
  );

  it("parks the beam mid-travel instead of stopping it where it started", () => {
    expect(parked).toBeDefined();
    // `animation: none` alone would drop the beam to frame 0% of the sweep:
    // hard against the left edge at 0.76 opacity — the dimmest frame, reading
    // as a bar that has not started, on a turn that is running. All three
    // declarations together are the fix; any one of them alone is not.
    expect(parked?.body).toMatch(/animation:\s*none;/);
    expect(parked?.body).toMatch(/opacity:\s*1;/);
    expect(parked?.body).toMatch(
      /transform:\s*translateX\(calc\(var\(--thinking-scanner-travel\)\s*\/\s*2\)\);/,
    );
  });

  it("drops the compositor promotion along with the animation", () => {
    // `will-change` is on the beam for the sweep. Left standing under the
    // preference it promotes a layer per scanner for an element that never
    // changes again — on precisely the busy-fleet case this rule targets.
    expect(sweeping?.body).toMatch(/will-change:\s*opacity,\s*transform;/);
    expect(parked?.body).toMatch(/will-change:\s*auto;/);
  });

  it("holds the brightest frame of the sweep, not a second pose", () => {
    // The parked values must BE the sweep's 50% keyframe. If someone retunes
    // that keyframe, this pins the two together so the still state stays the
    // animation held rather than drifting into a look of its own.
    const midFrame = css.match(
      /@keyframes pwragent-thinking-scanner-sweep\s*\{[\s\S]*?50%\s*\{(?<body>[^}]*)\}/,
    )?.groups?.body;
    expect(midFrame).toMatch(/opacity:\s*1;/);
    expect(midFrame).toMatch(
      /transform:\s*translateX\(var\(--thinking-scanner-travel\)\);/,
    );
    // And the base rule keeps the frame-0% pose, which is what the override
    // above exists to replace. Guarded, because `expect(undefined).toMatch`
    // reports "received value must be a string" rather than naming the rule
    // that went missing.
    expect(sweeping).toBeDefined();
    expect(sweeping?.body).toMatch(/opacity:\s*0\.76;/);
    expect(sweeping?.body).toMatch(/transform:\s*translateX\(0\);/);
  });

  it("re-pins live beams when the preference changes", () => {
    // The reduce rule CANCELS the sweep, so flipping the preference back off
    // builds a new animation on the moment of the flip instead of the shared
    // epoch — leaving every beam already on screen out of phase with every one
    // mounted afterwards. `ThinkingScanner` listens for that and re-pins.
    // Without the listener the CSS above is a silent regression of PR #1187.
    const scanner = readFileSync(
      path.resolve(testDir, "../../features/thread-detail/ThinkingScanner.tsx"),
      "utf8",
    );
    expect(scanner).toMatch(/matchMedia\(\s*"\(prefers-reduced-motion: reduce\)"\s*\)/);
    expect(scanner).toMatch(/addEventListener\(\s*"change"/);
    expect(scanner).toContain("querySelectorAll(\".thinking-scanner__beam\")");
  });

  it("keeps travel equal to track width minus beam width in every variant", () => {
    // `translateX(travel / 2)` only centres the beam because travel is defined
    // as the room the beam has to move — width minus its own width. That
    // arithmetic is implicit in the shipped numbers and nothing else asserts
    // it, so retuning one variant's geometry would silently leave the parked
    // beam off-centre in that size alone.
    for (const [selector, expected] of [
      [".thinking-scanner", { width: 62, beam: 18, travel: 44 }],
      [".thinking-scanner--mini", { width: 16, beam: 6, travel: 10 }],
    ] as const) {
      const rule = rules.find(
        (candidate) =>
          candidate.selectors.length === 1
          && candidate.selectors[0] === selector
          && candidate.atRules.length === 0
          && /--thinking-scanner-travel:/.test(candidate.body),
      );
      // `(?<![-\w])` anchors the property name at a declaration boundary.
      // Without it, `width` matches inside `--thinking-scanner-beam-width`
      // and every variant reports its beam width as its track width — which
      // makes the arithmetic below agree with itself and assert nothing.
      expect(rule, `app.css defines ${selector} with a travel`).toBeDefined();
      const read = (property: string) =>
        Number(
          rule?.body.match(new RegExp(`(?<![-\\w])${property}:\\s*(\\d+)px`))?.[1],
        );

      expect(read("width")).toBe(expected.width);
      expect(read("--thinking-scanner-beam-width")).toBe(expected.beam);
      expect(read("--thinking-scanner-travel")).toBe(expected.travel);
      // Against the values read out of the CSS, not against the literals
      // above: comparing the table to itself is a tautology that no change to
      // `app.css` can fail, which is not what the comment above promises.
      expect(read("--thinking-scanner-travel")).toBe(
        read("width") - read("--thinking-scanner-beam-width"),
      );
    }
  });

  it("keeps the idle stand-in the same footprint as the mini scanner", () => {
    // With the sweep held still, the ONLY thing separating "a turn is running"
    // from "nothing is running" is this parked beam against the dormant bar's
    // empty track. They have to be the same size for that pair to read as one
    // control in two states rather than two different marks.
    const dormant = rules.find(
      (rule) =>
        rule.selectors.includes(".signal-count__dormant-scanner")
        && /(?<![-\w])width:/.test(rule.body),
    );
    expect(dormant).toBeDefined();
    expect(dormant?.body).toMatch(/(?<![-\w])width:\s*16px;/);
    expect(dormant?.body).toMatch(/height:\s*6px;/);
    // And it must stay a bare, flat track. Asserting the neutral surface token
    // it paints, rather than the absence of `--thinking-scanner-tint`: a fill
    // is far likelier to arrive as a plain `background: var(--accent…)` or a
    // gradient, neither of which mentions the scanner's tint variable at all.
    expect(dormant?.body).toMatch(/background:\s*var\(--bg-panel-hover\);/);
    expect(dormant?.body).not.toMatch(/gradient|--accent/);
  });
});
