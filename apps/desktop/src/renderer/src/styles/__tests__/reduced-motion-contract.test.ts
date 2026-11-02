import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appCss as css } from "./css-rule-body";
import {
  appStyleRules as rules,
  hasMotionQuery,
  PAIRED_RING_CLASS,
  reducedMotionPairedRingSelectors,
} from "./css-style-rules";

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
  // preference asks to stop. Rings that sit beside text wear
  // `.pending-spinner--paired` and ARE stopped, which is why the bare
  // selector cannot inherit that rule's coverage.
  ".pending-spinner":
    "standalone busy ring with no text companion; the reduce rule stops the paired rings by their `.pending-spinner--paired` modifier instead",
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
    expect(reducedSelectors.has(".pending-spinner--paired")).toBe(true);
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

/**
 * Busy rings that sit beside text naming the work stop under reduced motion;
 * a ring that is its surface's only signal keeps spinning (see the media query
 * beside `.pending-spinner` in `app.css`).
 *
 * The reduce rule used to list each paired surface by its context, and the
 * review card's Fix button was missed until #3193 added it. So the ring opts
 * in itself with `.pending-spinner--paired`, and this gate makes every ring in
 * renderer source take a side: wear the modifier, or appear in
 * `STANDALONE_RINGS` with the reason it keeps spinning.
 *
 * A source scan rather than a rendered-DOM check, because "beside text" is
 * not something the DOM can judge: the upload chip's ring sits beside a file
 * name, which says nothing about the copy in progress, while the provider
 * row's ring sits in an empty mark span and its step text is two siblings
 * over. And the scan covers a ring that no test renders in its busy state.
 */
describe("paired busy rings under reduced motion", () => {
  const rendererRoot = path.resolve(testDir, "../..");

  /**
   * Rings that keep spinning under reduced motion, by file relative to
   * `renderer/src`, one reason per ring. The gate checks only how many
   * unpaired rings each file has, so name each ring in its reason. Each is a
   * decision that the motion is the ring's surface's only progress signal.
   */
  const STANDALONE_RINGS: Record<string, string[]> = {
    "features/composer/Composer.tsx": [
      "the Run button swaps its play glyph for a bare ring; its only text is the aria-label",
      "an upload chip with no percent yet shows the ring beside the file name, and the copy state is only in its tooltip",
    ],
    "features/composer/ComposerDropdown.tsx": [
      "a busy environment picker swaps its icon for the ring beside the environment's name, which does not say setup is running",
    ],
  };

  /**
   * Busy rings in renderer source, counted per file by the class token on
   * each line. Each ring's className is one line naming `pending-spinner`, so
   * a line that also names the modifier is a paired ring. Comment lines and
   * trailing `// …` comments are skipped so prose about the ring does not
   * count as one. A className split
   * across lines counts as unpaired, which fails loudly rather than hiding a
   * ring.
   */
  function ringCounts(): Map<string, { paired: number; unpaired: number }> {
    const ringToken = /(?<![\w-])pending-spinner(?![\w-])/g;
    const pairedToken = new RegExp(`(?<![\\w-])${PAIRED_RING_CLASS}(?![\\w-])`, "g");
    const counts = new Map<string, { paired: number; unpaired: number }>();
    const files = readdirSync(rendererRoot, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) => !/(?:^|[\\/])(?:__tests__|test)[\\/]/.test(file));
    for (const file of files) {
      let paired = 0;
      let unpaired = 0;
      for (const sourceLine of readFileSync(path.join(rendererRoot, file), "utf8").split("\n")) {
        if (/^\s*(?:\/\/|\/\*|\*)/.test(sourceLine)) continue;
        // A space before and after keeps `https://` in a string intact.
        const line = sourceLine.replace(/\s\/\/\s.*$/, "");
        const rings = line.match(ringToken)?.length ?? 0;
        const pairedRings = Math.min(rings, line.match(pairedToken)?.length ?? 0);
        paired += pairedRings;
        unpaired += rings - pairedRings;
      }
      if (paired + unpaired > 0) {
        counts.set(file.split(path.sep).join("/"), { paired, unpaired });
      }
    }
    return counts;
  }

  it("stops a ring by its own modifier, not by the surface around it", () => {
    // A context selector such as `.settings-pending .pending-spinner` coming
    // back would cover one surface and not the next, which is the gap the
    // modifier exists to close.
    expect(reducedMotionPairedRingSelectors).toEqual([`.${PAIRED_RING_CLASS}`]);
    const pairedRule = rules.find(
      (rule) =>
        hasMotionQuery(rule.atRules, "reduce")
        && rule.selectors.includes(`.${PAIRED_RING_CLASS}`),
    );
    // Uniformly accent-tinted, so the still ring does not read as a stalled
    // arc.
    expect(pairedRule?.body).toMatch(/border-color:\s*var\(--accent\);/);
  });

  it("makes every ring in renderer source either paired or a listed standalone", () => {
    const counts = ringCounts();
    // Non-vacuous: the scan has to find the rings this gate is about.
    const pairedTotal = [...counts.values()].reduce((sum, count) => sum + count.paired, 0);
    expect(pairedTotal).toBeGreaterThanOrEqual(10);
    expect(counts.get("features/settings/SettingsLayout.tsx")?.paired).toBeGreaterThan(0);

    const unpaired = Object.fromEntries(
      [...counts]
        .filter(([, count]) => count.unpaired > 0)
        .map(([file, count]) => [file, count.unpaired]),
    );
    const listed = Object.fromEntries(
      Object.entries(STANDALONE_RINGS).map(([file, reasons]) => [file, reasons.length]),
    );
    // A new ring fails here, named by file. If it sits beside text naming the
    // work, give it `pending-spinner--paired`. If motion is its surface's only
    // progress signal, add a reason to STANDALONE_RINGS.
    expect(unpaired).toEqual(listed);
    for (const reasons of Object.values(STANDALONE_RINGS)) {
      for (const reason of reasons) expect(reason.trim().length).toBeGreaterThan(0);
    }
  });
});
