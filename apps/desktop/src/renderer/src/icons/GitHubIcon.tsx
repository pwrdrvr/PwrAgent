import type { ImgHTMLAttributes } from "react";
import { useBrandTheme } from "./brand-theme";
import { DEFAULT_ICON_SIZE } from "./icon-types";
import invertocatBlackUrl from "../assets/github/invertocat-black.svg";
import invertocatWhiteUrl from "../assets/github/invertocat-white.svg";

/**
 * Official GitHub Invertocat mark from GitHub's logo kit
 * (https://github.com/logos). GitHub publishes exactly two colorways for
 * it and forbids altering the mark, so this picks between those two files
 * rather than recoloring one — black on the light theme, white on dark.
 *
 * Used to identify the `gh` command line tool, which is GitHub's own CLI.
 * See `assets/github/README.md` for why this is the Invertocat and not
 * the GitHub Desktop application icon.
 *
 * Rendered as an `<img>` so the asset stays a verbatim, unaltered file.
 */
const VARIANT_URL: Record<GitHubIconVariant, string> = {
  black: invertocatBlackUrl,
  white: invertocatWhiteUrl,
};

export type GitHubIconVariant = "black" | "white";

export type GitHubIconProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height"
> & {
  size?: number;
  variant?: GitHubIconVariant;
};

export function GitHubIcon({
  size = DEFAULT_ICON_SIZE,
  variant,
  alt = "",
  ...rest
}: GitHubIconProps) {
  const theme = useBrandTheme();
  const resolved = variant ?? (theme === "light" ? "black" : "white");
  return (
    <img
      src={VARIANT_URL[resolved]}
      width={size}
      height={size}
      alt={alt}
      style={{ display: "inline-block", verticalAlign: "middle" }}
      {...rest}
    />
  );
}
