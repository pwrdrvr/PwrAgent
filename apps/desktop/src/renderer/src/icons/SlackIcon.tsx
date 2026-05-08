import type { ImgHTMLAttributes } from "react";
import { DEFAULT_ICON_SIZE } from "./icon-types";
import iconColorUrl from "../assets/slack/icon-color.svg";

export type SlackIconProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height"
> & {
  size?: number;
};

export function SlackIcon({
  size = DEFAULT_ICON_SIZE,
  alt = "",
  ...rest
}: SlackIconProps) {
  return (
    <img
      src={iconColorUrl}
      width={size}
      height={size}
      alt={alt}
      style={{ display: "inline-block", verticalAlign: "middle" }}
      {...rest}
    />
  );
}
