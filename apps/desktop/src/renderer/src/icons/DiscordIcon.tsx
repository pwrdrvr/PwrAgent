import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Discord controller-shaped glyph, simplified to a monochrome silhouette
 * filled with `currentColor`. Matches the visual weight of `TelegramIcon`
 * at 16px and avoids the brand purple / gradient that would clash with
 * the Tangerine Terminal theme.
 */
export function DiscordIcon(props: IconProps) {
  const svgProps = resolveIconSvgProps(props);
  return (
    <svg {...svgProps} fill="currentColor" stroke="none">
      <path d="M19.27 5.33A19.66 19.66 0 0 0 14.6 4l-.21.31a14.6 14.6 0 0 0-4.78 0L9.4 4a19.66 19.66 0 0 0-4.67 1.33A20.6 20.6 0 0 0 1.5 16.42a19.84 19.84 0 0 0 6 3.04l.49-.66a13.5 13.5 0 0 1-2.13-1.05l.45-.36a14.45 14.45 0 0 0 11.38 0l.45.36a13.5 13.5 0 0 1-2.14 1.05l.5.66a19.84 19.84 0 0 0 6-3.04 20.6 20.6 0 0 0-3.23-11.09zM8.5 14.16c-1.18 0-2.15-1.1-2.15-2.45s.95-2.45 2.15-2.45 2.16 1.1 2.15 2.45c0 1.35-.96 2.45-2.15 2.45zm7 0c-1.18 0-2.15-1.1-2.15-2.45s.95-2.45 2.15-2.45 2.16 1.1 2.15 2.45c0 1.35-.96 2.45-2.15 2.45z" />
    </svg>
  );
}
