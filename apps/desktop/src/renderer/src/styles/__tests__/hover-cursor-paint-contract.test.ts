import { describe, expect, it } from "vitest";
import { appStyleRules } from "./css-style-rules";

/**
 * A row the operator has chosen, or the row Enter will take, must not look
 * like a row the pointer is merely resting on (UI-THEME.md, "Hover is not a
 * selection").
 *
 * The composer's `/` popup painted its keyboard cursor and a hovered row with
 * one rule. The pointer does not move that cursor, so with the mouse parked on
 * `/agents` and the cursor on `/review`, two rows wore the same tint and only
 * the pointer said which was which. Settings' current page, a question card's
 * chosen answer, the review target, the open Markdown file and four menus'
 * focused item had the same defect.
 *
 * The oracle walks every rule in `app.css`. It groups a selector by the
 * element it paints, with its states stripped, and collects the paint a
 * `:hover` puts on it and the paint each chosen state puts on it. A chosen
 * state passes when it paints at least one thing hover does not. Keyboard
 * focus starts with the app-wide ring (`:where(:focus-visible)`), which a rule
 * can remove with `outline: none` or redraw on a pseudo-element or container.
 */

/** Properties that change what a row looks like. Geometry is left out. */
const PAINT_PROPERTY =
  /^(?:background(?:-color|-image)?|color|outline(?:-color|-style|-width)?|box-shadow|border(?:-(?:top|right|bottom|left))?(?:-color)?|text-decoration(?:-line|-color)?|font-weight)$/;

/** The states that say "this one": chosen, current, or where Enter lands. */
const CHOSEN_STATES: ReadonlyArray<readonly [string, RegExp]> = [
  ["cursor/selected class", /\.is-(?:active|cursor|selected|highlighted|current|checked)(?![\w-])/],
  ["aria state", /\[aria-(?:selected|pressed|checked)(?:="?true"?)?\]/],
  ["aria-current", /\[aria-current(?:=[^\]]*)?\]/],
  // The PR stack popover marks the open thread's PR with `[data-current]`
  // and painted a hovered layer with the same rule, so two rows wore one
  // tint and only the pointer said which was "this PR".
  ["data state", /\[data-(?:current|selected)(?:="?true"?)?\]/],
  ["BEM modifier", /--(?:active|selected|current)(?![\w-])/],
  ["keyboard focus", /:focus-visible(?![\w-])/],
];

/** `.row:has(.row__open:hover)`: the row is hovered through its hit area. */
const HAS_HOVER = /:has\((?:[^()]|\([^()]*\))*:hover(?:[^()]|\([^()]*\))*\)/g;

const STATE_NOISE = [
  HAS_HOVER,
  /:not\((?:[^()]|\([^()]*\))*\)/g,
  /:hover/g,
  /:focus-visible/g,
  /:focus-within/g,
  /:focus(?![\w-])/g,
  /:active(?![\w-])/g,
  /:disabled|:enabled/g,
  ...CHOSEN_STATES.map(([, pattern]) => new RegExp(pattern.source, "g")),
];

const GLOBAL_FOCUS_RING = "2px solid var(--focus-ring)";

/** Splits a selector into compounds, keeping `:not(a b)` and `[x="a b"]` whole. */
function compounds(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of selector) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (depth === 0 && /[\s>+~]/.test(char)) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function stripStates(compound: string): string {
  return STATE_NOISE.reduce((text, pattern) => text.replace(pattern, ""), compound);
}

function declarations(body: string): Array<[string, string]> {
  return body
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.includes(":"))
    .map((declaration) => {
      const colon = declaration.indexOf(":");
      return [
        declaration.slice(0, colon).trim(),
        declaration.slice(colon + 1).replace(/\s*!important$/, "").replace(/\s+/g, " ").trim(),
      ] as [string, string];
    })
    .filter(([property]) => PAINT_PROPERTY.test(property));
}

type Paint = Map<string, string>;
type Declared = { selector: string; last: string; order: number; paint: Paint };
type Element = {
  hover: Paint;
  chosen: Map<string, Paint>;
  hoverRules: Declared[];
  chosenRules: Array<Declared & { state: string; token: string }>;
  /** `.is-active:hover` and the like: a chosen row's own hover paint. */
  combinedRules: Declared[];
};

/**
 * [ids, classes + attributes + pseudo-classes, types]. `:where()` adds
 * nothing; `:not()`, `:is()` and `:has()` add their heaviest argument.
 */
function specificity(selector: string): [number, number, number] {
  const total: [number, number, number] = [0, 0, 0];
  let rest = selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, "");
  rest = rest.replace(/:(?:not|is|has)\(((?:[^()]|\([^()]*\))*)\)/g, (_, inner: string) => {
    const heaviest = inner
      .split(",")
      .map((argument) => specificity(argument.trim()))
      .reduce((best, next) => (compare(next, best) > 0 ? next : best), [0, 0, 0] as [number, number, number]);
    total[0] += heaviest[0];
    total[1] += heaviest[1];
    total[2] += heaviest[2];
    return " ";
  });
  total[0] += rest.match(/#[\w-]+/g)?.length ?? 0;
  total[1] += rest.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g)?.length ?? 0;
  total[2] += rest.match(/(?:^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0;
  return total;
}

function compare(a: readonly number[], b: readonly number[]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Elements whose focus ring is drawn on a pseudo-element or a container. */
function ringedElsewhere(): Set<string> {
  const ringed = new Set<string>();
  for (const rule of appStyleRules) {
    if (!/(?:^|[;\s])(?:outline|box-shadow):\s*(?!none|0)/.test(rule.body)) continue;
    for (const selector of rule.selectors) {
      for (const match of selector.matchAll(/(\.[\w-]+(?:\.[\w-]+)*):focus-visible(?:::(?:before|after)|\))/g)) {
        ringed.add(match[1]);
      }
    }
  }
  return ringed;
}

function collectElements(): Map<string, Element> {
  const elements = new Map<string, Element>();
  for (const [order, rule] of appStyleRules.entries()) {
    if (rule.atRules.some((atRule) => /^@(?:keyframes|font-face)/.test(atRule))) continue;
    const paint = declarations(rule.body);
    if (paint.length === 0) continue;
    for (const selector of rule.selectors) {
      if (selector.includes("::")) continue;
      const parts = compounds(selector);
      const last = parts.at(-1) ?? "";
      // A state on an ancestor repaints a part of the row (its meta line, its
      // time), and that part follows whatever the row itself does.
      if (parts.slice(0, -1).some((part) => stripStates(part) !== part)) continue;
      const hovered = last.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "").includes(":hover");
      const chosen = CHOSEN_STATES.filter(([, pattern]) =>
        pattern.test(last.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "")));
      if (!hovered && chosen.length === 0) continue;
      const key = [...rule.atRules, [...parts.slice(0, -1), stripStates(last)].join(" ")].join(" | ");
      let element = elements.get(key);
      if (!element) {
        element = { hover: new Map(), chosen: new Map(), hoverRules: [], chosenRules: [], combinedRules: [] };
        elements.set(key, element);
      }
      // `.is-selected:hover` is its own combined state, not either side.
      if (hovered && chosen.length > 0) {
        element.combinedRules.push({ selector, last, order, paint: new Map(paint) });
      } else if (hovered) {
        element.hoverRules.push({ selector, last, order, paint: new Map(paint) });
        for (const [property, value] of paint) element.hover.set(property, value);
      } else {
        for (const [state, pattern] of chosen) {
          const token = last.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "").match(pattern)![0];
          element.chosenRules.push({ selector, last, order, paint: new Map(paint), state, token });
          const statePaint = element.chosen.get(state) ?? new Map<string, string>(
            state === "keyboard focus" ? [["outline", GLOBAL_FOCUS_RING]] : [],
          );
          for (const [property, value] of paint) statePaint.set(property, value);
          element.chosen.set(state, statePaint);
        }
      }
    }
  }
  return elements;
}

describe("hover is not a selection", () => {
  it("gives every chosen, current, or cursor row a paint that hover lacks", () => {
    const ringed = ringedElsewhere();
    const failures: string[] = [];
    for (const [key, element] of collectElements()) {
      if (element.hover.size === 0) continue;
      for (const [state, paint] of element.chosen) {
        const effective = new Map(paint);
        const outline = effective.get("outline");
        if (state === "keyboard focus" && (outline === "none" || outline === "0")) {
          const base = key.split(" | ").at(-1)!.split(" ").at(-1)!;
          if (ringed.has(base)) effective.set("outline", "ring drawn elsewhere");
        }
        const own = [...effective].filter(([property, value]) => element.hover.get(property) !== value);
        if (own.length === 0) failures.push(`${key} — ${state} paints only what hover paints`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("never lets a hover rule repaint the chosen row it is resting on", () => {
    // A hover selector that out-ranks the chosen one (or ties it and comes
    // later) wins on a row that is both, and takes the chosen paint away
    // while the pointer is there. The autocomplete's
    // `:hover:not(:disabled)` is (0,3,0) against `.is-active`'s (0,2,0):
    // without its `:not(.is-active)` the cursor row lost its accent under
    // the pointer. Each such hover has to exclude the state it would beat.
    const failures: string[] = [];
    for (const element of collectElements().values()) {
      for (const hover of element.hoverRules) {
        const hoverWeight = specificity(hover.selector);
        for (const chosen of element.chosenRules) {
          const beats = compare(hoverWeight, specificity(chosen.selector)) || hover.order - chosen.order;
          if (beats <= 0) continue;
          const excluded = [...hover.last.matchAll(/:not\(((?:[^()]|\([^()]*\))*)\)/g)]
            .some(([, inner]) => inner.includes(chosen.token));
          if (excluded) continue;
          // A rule for the chosen row's own hover that out-ranks this one
          // and restates the property puts the chosen paint back.
          const restated = (property: string): boolean => element.combinedRules.some((combined) =>
            combined.last.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "").includes(chosen.token)
            && combined.paint.has(property)
            && (compare(specificity(combined.selector), hoverWeight) || combined.order - hover.order) > 0);
          const repainted = [...chosen.paint].filter(([property, value]) =>
            hover.paint.has(property) && hover.paint.get(property) !== value && !restated(property));
          if (repainted.length > 0) {
            failures.push(
              `${hover.selector} beats ${chosen.selector} on ${repainted.map(([property]) => property).join(", ")}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("is not satisfied by an oracle that never looks", () => {
    // The walk has to reach the rules the defect lived in, or an empty
    // failure list above proves nothing.
    const elements = collectElements();
    for (const key of [
      ".composer__autocomplete-option",
      ".settings-nav__button",
      ".transcript-questionnaire__option",
      ".markdown-files-window__file-button",
      ".terminal-menu__item",
    ]) {
      const element = elements.get(key);
      expect(element?.hover.size, key).toBeGreaterThan(0);
      expect(element?.chosen.size, key).toBeGreaterThan(0);
    }
  });
});
