import type { ImgHTMLAttributes } from "react";
import { DEFAULT_ICON_SIZE } from "./icon-types";
import iconBlackUrl from "../assets/git/icon-black.svg";
import iconBrandUrl from "../assets/git/icon-1788c.svg";
import iconWhiteUrl from "../assets/git/icon-white.svg";

/**
 * Official Git icon, designed by Jason Long and published by the Git
 * project at https://git-scm.com/downloads/logos under the Creative
 * Commons Attribution 3.0 Unported licence. The attribution that licence
 * requires is recorded here and in `assets/git/README.md`.
 *
 * The three variants map to the three colorways the Git project ships.
 * `brand` (Pantone 1788C) is the default because the red reads on both
 * PwrAgent themes, so unlike the monochrome vendor marks this icon needs
 * no theme subscription.
 *
 * Rendered as an `<img>` so the asset stays a verbatim, unaltered file —
 * Vite emits each URL as a static asset at build time and no surrounding
 * CSS color state can recolor the mark.
 */
const VARIANT_URL: Record<GitIconVariant, string> = {
  black: iconBlackUrl,
  brand: iconBrandUrl,
  white: iconWhiteUrl,
};

export type GitIconVariant = "black" | "brand" | "white";

export type GitIconProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height"
> & {
  size?: number;
  variant?: GitIconVariant;
};

export function GitIcon({
  size = DEFAULT_ICON_SIZE,
  variant = "brand",
  alt = "",
  ...rest
}: GitIconProps) {
  return (
    <img
      src={VARIANT_URL[variant]}
      width={size}
      height={size}
      alt={alt}
      style={{ display: "inline-block", verticalAlign: "middle" }}
      {...rest}
    />
  );
}
