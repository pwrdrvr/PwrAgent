import type { ImgHTMLAttributes } from "react";
import { DEFAULT_ICON_SIZE } from "./icon-types";
import iconBlackUrl from "../assets/mattermost/icon-black.svg";
import iconDenimUrl from "../assets/mattermost/icon-denim.svg";
import iconWhiteUrl from "../assets/mattermost/icon-white.svg";

/**
 * Mattermost is the only icon in this folder that does NOT render as a
 * monochrome `currentColor` silhouette. Mattermost's brand guidelines
 * explicitly forbid altering the mark — including recoloring — so we
 * embed the official SVG assets verbatim from their downloadable brand
 * kit (https://mattermost.com/brand-guidelines/) and let the consumer
 * pick the variant that suits the surrounding surface.
 *
 * Variants map directly to Mattermost's three published colorways:
 *
 * - `denim`  — brand-default (#1e325c). Best on light surfaces.
 * - `black`  — pure black (#1b1d22). Best on light surfaces when denim
 *              would clash with the surrounding accent.
 * - `white`  — pure white. Required on dark surfaces; denim disappears.
 *
 * Renders as an `<img>` element rather than inline `<svg>` so the asset
 * stays a verbatim, unaltered file — Vite emits each URL as a static
 * asset at build time. Future logo updates are file-replaces with no
 * source changes.
 */
const VARIANT_URL: Record<MattermostIconVariant, string> = {
  black: iconBlackUrl,
  denim: iconDenimUrl,
  white: iconWhiteUrl,
};

export type MattermostIconVariant = "black" | "denim" | "white";

export type MattermostIconProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height"
> & {
  size?: number;
  variant?: MattermostIconVariant;
};

export function MattermostIcon({
  size = DEFAULT_ICON_SIZE,
  // The PwrAgent desktop UI is dark-themed throughout, so white is the
  // right default — denim (#1e325c) and black both disappear against
  // near-black surfaces. Light-surface callers (any future light theme,
  // exported reports, brand pages) override with `variant="denim"` or
  // `variant="black"`.
  variant = "white",
  alt = "",
  ...rest
}: MattermostIconProps) {
  return (
    <img
      src={VARIANT_URL[variant]}
      width={size}
      height={size}
      alt={alt}
      // Mattermost's logo is on a 140×140 canvas with no padding (we
      // ship the "without_clearspace" variant). Match the visual weight
      // of the other 16-px icons by letting the image scale to its
      // requested square box.
      style={{ display: "inline-block", verticalAlign: "middle" }}
      {...rest}
    />
  );
}
