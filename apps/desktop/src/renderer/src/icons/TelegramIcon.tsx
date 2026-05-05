import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * Telegram paper-plane glyph, simplified to a monochrome silhouette
 * filled with `currentColor`. Uses `fill` instead of stroke so the mark
 * reads cleanly at 16px against the near-black header background.
 */
export function TelegramIcon(props: IconProps) {
  const svgProps = resolveIconSvgProps(props);
  return (
    <svg {...svgProps} fill="currentColor" stroke="none">
      <path d="M21.6 3.2 2.7 10.6c-.7.3-.7 1.3 0 1.5l4.4 1.4 1.7 5.5c.2.6.9.7 1.3.3l2.6-2.6 4.5 3.3c.6.4 1.5.1 1.6-.6L22.9 4c.2-.7-.5-1.3-1.3-.8zM9.5 13.7l8.6-5.3-7 6.5z" />
    </svg>
  );
}
