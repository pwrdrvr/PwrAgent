import type { ImgHTMLAttributes } from "react";
import { DEFAULT_ICON_SIZE } from "./icon-types";
import iconColorUrl from "../assets/telegram/icon-color.svg";

const VARIANT_URL: Record<TelegramIconVariant, string> = {
  color: iconColorUrl,
};

export type TelegramIconVariant = "color";

export type TelegramIconProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height"
> & {
  size?: number;
  variant?: TelegramIconVariant;
};

/**
 * Official Telegram logo asset from Telegram's press kit. Telegram only
 * distributes the current logo as the blue gradient circle with white
 * paper plane, so the component intentionally has no currentColor path.
 */
export function TelegramIcon({
  size = DEFAULT_ICON_SIZE,
  variant = "color",
  alt = "",
  ...rest
}: TelegramIconProps) {
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
