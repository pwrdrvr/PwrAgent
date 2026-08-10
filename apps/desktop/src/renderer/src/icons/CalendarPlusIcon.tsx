import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * A calendar with a plus — "newest created first". Pairs with `HistoryIcon`
 * (a clock) on the thread lens switch: clock reads as time-of-last-activity,
 * calendar as the date a thread came into being, and the two glyphs are
 * unmistakable for each other at 16px.
 *
 * Deliberately not a sparkle. In an agent app a sparkle reads as "AI" or
 * "generate" no matter what it is next to, which is exactly the wrong
 * connotation for a sort order.
 */
export function CalendarPlusIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M20 10.5V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h6" />
      <path d="M4 10.5h16" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
      <path d="M17 14.5v6" />
      <path d="M14 17.5h6" />
    </svg>
  );
}
