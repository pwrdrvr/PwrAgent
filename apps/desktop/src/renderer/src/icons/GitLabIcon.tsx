import type { ImgHTMLAttributes } from "react";
import { DEFAULT_ICON_SIZE } from "./icon-types";
import tanukiUrl from "../assets/gitlab/tanuki.svg";

/** Official, unaltered GitLab mark identifying the glab CLI. */
export function GitLabIcon({
  size = DEFAULT_ICON_SIZE,
  alt = "",
  ...rest
}: Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "width" | "height"> & {
  size?: number;
}) {
  return (
    <img
      src={tanukiUrl}
      width={size}
      height={size}
      alt={alt}
      style={{ display: "inline-block", verticalAlign: "middle", objectFit: "contain" }}
      {...rest}
    />
  );
}
