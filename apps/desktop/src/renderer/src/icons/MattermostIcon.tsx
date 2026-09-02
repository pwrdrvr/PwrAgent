import type { ImgHTMLAttributes } from "react";
import { useBrandTheme } from "./brand-theme";
import { DEFAULT_ICON_SIZE } from "./icon-types";
import iconBlackUrl from "../assets/mattermost/icon-black.svg";
import iconDenimUrl from "../assets/mattermost/icon-denim.svg";
import iconWhiteUrl from "../assets/mattermost/icon-white.svg";

/**
 * Official Mattermost logo asset from Mattermost's downloadable brand
 * kit. Mattermost's brand guidelines explicitly forbid altering the
 * mark — including recoloring — so we embed the official SVG assets
 * verbatim and let the consumer pick the variant that suits the surface.
 *
 * Variants map directly to Mattermost's three published colorways:
 *
 * - `denim`  — brand-default (#1e325c). Best on light surfaces.
 * - `black`  — pure black (#1b1d22). Best on light surfaces when denim
 *              would clash with the surrounding accent.
 * - `white`  — pure white. Required on dark surfaces; denim disappears.
 *
 * With no explicit variant, the icon follows PwrAgent's resolved theme:
 * denim on light surfaces and white on dark surfaces. Explicit variants
 * remain available for surfaces whose background is independent of the app
 * theme.
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
  variant,
  alt = "",
  ...rest
}: MattermostIconProps) {
  const resolvedVariant = useMattermostVariant(variant);
  return (
    <img
      src={VARIANT_URL[resolvedVariant]}
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

function useMattermostVariant(
  variant: MattermostIconVariant | undefined,
): MattermostIconVariant {
  const theme = useBrandTheme();
  return variant ?? (theme === "light" ? "denim" : "white");
}
