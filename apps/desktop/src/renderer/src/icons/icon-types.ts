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
