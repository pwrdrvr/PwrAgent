import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as iconLibrary from "../index";
import {
  BranchIcon,
  ChevronDownIcon,
  CloseIcon,
  MoreVerticalIcon,
  NewThreadIcon,
  PinIcon,
  SmileyIcon,
  WorktreeIcon,
} from "../index";
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
] as const satisfies readonly (readonly [string, unknown, IconProps])[];

/**
 * Count renders of the REAL exported component by swapping the function
 * `memo` holds, which leaves React's own memo boundary — the thing under
 * test — completely untouched. Restored after every test.
 */
type MemoIcon = { type: (props: IconProps) => unknown };

const restores: Array<() => void> = [];

function countRenders(icon: unknown): () => number {
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
  while (restores.length > 0) restores.pop()?.();
});

describe("icon render cost", () => {
  it("exports every icon as a memo component", () => {
    const components = Object.entries(iconLibrary).filter(([name]) =>
      name.endsWith("Icon"),
    );
    // Guard the guard: a renamed barrel would otherwise assert nothing.
    expect(components.length).toBeGreaterThanOrEqual(50);
    const unmemoized = components
      .filter(([, value]) => {
        const tag = (value as { $$typeof?: symbol }).$$typeof;
        return tag !== REACT_MEMO;
      })
      .map(([name]) => name);
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
