import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * A clock whose hand is chased by a counter-clockwise arrow — "most
 * recently updated". Distinct from `CalendarPlusIcon` ("newest
 * created") so the two time-ordered thread lenses never read as the same
 * glyph.
 */
export function HistoryIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M3.5 9.5A9 9 0 1 1 3 12" />
      <path d="M3 4.5V9.5h5" />
      <path d="M12 7.5V12l3 1.75" />
    </svg>
  );
}
