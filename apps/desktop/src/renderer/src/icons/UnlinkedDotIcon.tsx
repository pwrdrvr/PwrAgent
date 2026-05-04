import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Hollow dot glyph for "unlinked" directory kind — replaces the bullet
 * character previously used inline.
 */
export function UnlinkedDotIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}
