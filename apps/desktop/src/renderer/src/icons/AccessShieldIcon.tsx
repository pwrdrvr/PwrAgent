import { memo, useId } from "react";
import { resolveIconSvgProps, type IconProps } from "./icon-types";

const SHIELD_PATH = "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z";

/** Where the fill starts, from the top of the 24px box. */
const FILL_TOP = { empty: 24, low: 15, half: 11, full: 0 } as const;

/**
 * A shield filled from the bottom up to an access level: empty, low, half
 * or full. `mark` draws a dash across an empty shield, for a level that
 * only reads and proposes.
 */
export const AccessShieldIcon = memo(function AccessShieldIcon({
  level,
  mark = false,
  ...props
}: IconProps & { level: keyof typeof FILL_TOP; mark?: boolean }) {
  const clipId = `access-shield-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const top = FILL_TOP[level];
  return (
    <svg {...resolveIconSvgProps(props)}>
      {top < 24 ? (
        <>
          <clipPath id={clipId}>
            <path d={SHIELD_PATH} />
          </clipPath>
          <rect
            className="access-shield__fill"
            clipPath={`url(#${clipId})`}
            fill="currentColor"
            height={24 - top}
            stroke="none"
            width={24}
            x={0}
            y={top}
          />
        </>
      ) : null}
      <path d={SHIELD_PATH} />
      {mark ? <path d="M9.5 12h5" /> : null}
    </svg>
  );
});
