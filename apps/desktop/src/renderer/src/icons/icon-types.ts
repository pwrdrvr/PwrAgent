/**
 * Every icon in this library is wrapped in `React.memo` at its own export.
 *
 * Icons are the leaves of almost every surface, they take only primitives
 * (`size`, `strokeWidth`, `className`, `aria-*`), and they are re-created by
 * whatever re-renders above them — so they are the one component class where
 * a blanket memo is both safe and worth it. A React DevTools Profiler session
 * over the Directories lens measured 3,093 of 4,503 zero-input renders landing
 * on eight sidebar icons alone.
 *
 * The wrap pays off without anything above being memoized, which is what makes
 * it independent of the sidebar's own memoization work: memo bails out when the
 * PARENT re-renders and the icon's props did not change, which is exactly this
 * case. Props are compared shallowly, so a caller that spreads a fresh object
 * (`<CelestialSunIcon {...props} />`) still bails out as long as the values
 * match.
 *
 * Keep the inner function named — `memo(function PinIcon(...))`, not
 * `memo((props) => ...)` — so the Profiler and component stacks still say
 * `PinIcon` rather than `Anonymous`.
 */
import type { SVGAttributes } from "react";

/**
 * Shared props for every icon in the library. Icons render with
 * `currentColor` so callers control color via CSS, and with a 1.75 stroke
 * weight by default — the previous renderer-wide default of 1.5 read as
 * too thin against the near-black surfaces.
 *
 * Icons default to `aria-hidden`. Callers that want the icon announced
 * should pass `aria-label` and the component will switch to `role="img"`
 * automatically.
 */
export type IconProps = Omit<
  SVGAttributes<SVGSVGElement>,
  "children" | "viewBox" | "fill" | "stroke" | "strokeLinecap" | "strokeLinejoin"
> & {
  size?: number;
  strokeWidth?: number;
};

export const DEFAULT_ICON_SIZE = 16;
export const DEFAULT_ICON_STROKE_WIDTH = 1.75;

/**
 * Build the `<svg>` props every icon shares. Centralizing this means
 * accessibility, sizing, and stroke conventions stay in one place.
 */
export function resolveIconSvgProps({
  size = DEFAULT_ICON_SIZE,
  strokeWidth = DEFAULT_ICON_STROKE_WIDTH,
  "aria-label": ariaLabel,
  "aria-hidden": ariaHidden,
  role,
  ...rest
}: IconProps): SVGAttributes<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": ariaHidden ?? !ariaLabel,
    "aria-label": ariaLabel,
    role: ariaLabel ? role ?? "img" : role,
    ...rest,
  };
}

/**
 * Build the `<svg>` props for filled icons (the celestial set). Same
 * sizing and accessibility contract as `resolveIconSvgProps`, but no
 * root `fill="none"` / stroke defaults — filled icons paint each
 * element with `fill="currentColor"` plus numeric opacity layering
 * themselves, so a root-level stroke setup would fight the artwork.
 */
export function resolveFilledIconSvgProps({
  size = DEFAULT_ICON_SIZE,
  "aria-label": ariaLabel,
  "aria-hidden": ariaHidden,
  role,
  ...rest
}: IconProps): SVGAttributes<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    "aria-hidden": ariaHidden ?? !ariaLabel,
    "aria-label": ariaLabel,
    role: ariaLabel ? role ?? "img" : role,
    ...rest,
  };
}
