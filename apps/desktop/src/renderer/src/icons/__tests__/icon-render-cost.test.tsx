import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as iconLibrary from "../index";
import {
  BranchIcon,
  ChevronDownIcon,
  CloseIcon,
  GitHubIcon,
  GrokIcon,
  MattermostIcon,
  MoreVerticalIcon,
  NewThreadIcon,
  OpenAIIcon,
  PinIcon,
  SmileyIcon,
  WorktreeIcon,
} from "../index";
import type { ComponentType } from "react";
import type { IconProps } from "../icon-types";

/**
 * What the icon library is allowed to cost when a surface above it
 * re-renders.
 *
 * `features/navigation/` has no memoization, so every App render re-renders
 * the whole visible sidebar subtree. A Profiler session over the Directories
 * lens measured 4,503 renders with no changed prop, hook, state, or context,
 * and 3,093 of them were the eight icons named below. They take only
 * primitives, so `memo` bails out on every one of those.
 *
 * The structural test is the one that matters over time: these are 58
 * hand-edited files, and the 59th icon is the one that gets added without
 * the wrap.
 */

const REACT_MEMO = Symbol.for("react.memo");

/**
 * Enumerate icon modules from the filesystem, not from the barrel's export
 * NAMES. Filtering on `name.endsWith("Icon")` exempts any future component
 * exported as `Logo` or `Glyph` — precisely the case this guard exists to
 * catch — and pairing it with a hand-written count floor lets exports go
 * missing unnoticed. The glob is derived from the directory, so it cannot
 * drift from it.
 *
 * `import.meta.glob` is a Vite-injected dev/test property. Augmenting it
 * here keeps the type narrowed without pulling `vite/client` types into the
 * whole renderer, the same trade `main.tsx` makes for `import.meta.hot`.
 */
const iconModules = (
  import.meta as ImportMeta & {
    glob: (
      patterns: string[],
      options: { eager: true },
    ) => Record<string, Record<string, unknown>>;
  }
).glob(["../*.tsx", "../celestial/*.tsx"], { eager: true });

/**
 * Anything a module exports that could be rendered: a plain function, or an
 * object carrying `$$typeof` (memo, forwardRef, lazy). Types are erased, so
 * what is left is components. A plain function reaching the assertion above
 * is the unmemoized icon we are hunting.
 */
function exportedComponents(
  module: Record<string, unknown>,
): Array<[string, unknown]> {
  return Object.entries(module).filter(
    ([, value]) =>
      typeof value === "function"
      || (typeof value === "object" && value !== null && "$$typeof" in value),
  );
}

/** The icons the sidebar re-renders most, with the props it passes them. */
const SIDEBAR_ICONS = [
  ["NewThreadIcon", NewThreadIcon, { size: 16 }],
  ["ChevronDownIcon", ChevronDownIcon, { size: 14, strokeWidth: 2 }],
  ["MoreVerticalIcon", MoreVerticalIcon, { size: 14, "aria-hidden": "true" }],
  ["BranchIcon", BranchIcon, { size: 12 }],
  ["PinIcon", PinIcon, { size: 11, "aria-hidden": "true" }],
  ["WorktreeIcon", WorktreeIcon, { size: 12 }],
  ["SmileyIcon", SmileyIcon, { size: 14, "aria-hidden": "true" }],
  ["CloseIcon", CloseIcon, { size: 14 }],
] as const satisfies readonly (readonly [
  string,
  ComponentType<IconProps>,
  IconProps,
])[];

/**
 * Count renders of the REAL exported component by swapping the function
 * `memo` holds, which leaves React's own memo boundary — the thing under
 * test — completely untouched. Restored after every test.
 */
type MemoIcon = { type: (props: IconProps) => unknown };

const restores: Array<() => void> = [];

function countRenders(icon: unknown): () => number {
  // Without this the counter simply never fires and the caller reports
  // "expected 0 to be 1", which does not name the actual problem.
  expect((icon as { $$typeof?: symbol }).$$typeof).toBe(REACT_MEMO);
  const memoIcon = icon as MemoIcon;
  const inner = memoIcon.type;
  let renders = 0;
  memoIcon.type = (props: IconProps) => {
    renders += 1;
    return inner(props);
  };
  restores.push(() => {
    memoIcon.type = inner;
  });
  return () => renders;
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
  while (restores.length > 0) restores.pop()?.();
});

describe("icon render cost", () => {
  it("memoizes every component in every icon module", () => {
    const modules = Object.entries(iconModules);
    // Guard the guard: a glob that matched nothing would assert nothing.
    expect(modules.length).toBeGreaterThan(0);

    const unmemoized: string[] = [];
    for (const [path, module] of modules) {
      const components = exportedComponents(module);
      // Each icon file exports exactly one component. Zero means the
      // detector below stopped recognizing them, not that a file is empty.
      expect(components.length).toBeGreaterThan(0);
      for (const [name, value] of components) {
        if ((value as { $$typeof?: symbol }).$$typeof !== REACT_MEMO) {
          unmemoized.push(`${path} -> ${name}`);
        }
      }
    }
    expect(unmemoized).toEqual([]);
  });

  it.each(SIDEBAR_ICONS)(
    "%s does not re-render when its parent re-renders with the same props",
    (_name, Icon, iconProps) => {
      const readRenders = countRenders(Icon);
      const Row = ({ label }: { label: string }) => (
        <span>
          {label}
          <Icon {...iconProps} />
        </span>
      );
      const { rerender } = render(<Row label="round 0" />);
      expect(readRenders()).toBe(1);

      // Ten parent renders with nothing about the icon changed — what one
      // streamed turn looks like to a sidebar row.
      for (let round = 1; round <= 10; round += 1) {
        rerender(<Row label={`round ${round}`} />);
      }

      expect(readRenders()).toBe(1);
    },
  );

  it("still re-renders when a prop actually changes", () => {
    // The other half of the contract: the bail-out must not be so eager
    // that an icon stops following its own props.
    const readRenders = countRenders(PinIcon);
    const { container, rerender } = render(<PinIcon size={11} />);
    expect(readRenders()).toBe(1);

    rerender(<PinIcon size={18} />);

    expect(readRenders()).toBe(2);
    expect(container.querySelector("svg")).toHaveAttribute("width", "18");
  });

  it.each([
    ["GitHubIcon", GitHubIcon],
    ["MattermostIcon", MattermostIcon],
    ["OpenAIIcon", OpenAIIcon],
    ["GrokIcon", GrokIcon],
  ] as const)(
    "%s still follows the theme across the memo boundary",
    async (_name, Icon) => {
      // The other half of the contract, and the case a blanket memo could
      // plausibly break: these vendor marks cannot be recolored, so with
      // no explicit variant they pick a published asset from a live theme
      // subscription rather than from a prop. Nothing re-renders the parent
      // here — only the external store changes — so a memo that swallowed
      // the store update would leave the dark-theme asset on a light surface.
      const Host = () => <Icon />;
      const { container } = render(<Host />);
      const darkSrc = container.querySelector("img")?.getAttribute("src");
      expect(darkSrc).toBeTruthy();

      act(() => {
        document.documentElement.setAttribute("data-theme", "light");
      });

      await waitFor(() => {
        expect(container.querySelector("img")?.getAttribute("src")).not.toBe(
          darkSrc,
        );
      });
    },
  );

  it("bails out for a caller that spreads a fresh props object", () => {
    // `CelestialIcon` forwards `{...props}` from its own rest element, so the
    // props object is new on every render. memo compares shallowly, so the
    // values are what count.
    const readRenders = countRenders(iconLibrary.CelestialSunIcon);
    const Host = ({ label }: { label: string }) => (
      <span>
        {label}
        <iconLibrary.CelestialIcon icon="sun" size={14} />
      </span>
    );
    const { rerender } = render(<Host label="a" />);
    expect(readRenders()).toBe(1);

    for (let round = 1; round <= 5; round += 1) {
      rerender(<Host label={`round ${round}`} />);
    }

    expect(readRenders()).toBe(1);
  });
});
