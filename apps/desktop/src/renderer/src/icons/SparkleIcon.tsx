import { resolveIconSvgProps, type IconProps } from "./icon-types";

/**
 * A four-point star with a smaller companion — "newest first". Used for the
 * creation-ordered thread lens, where `NewThreadIcon` would wrongly read as
 * a button that creates something.
 */
export function SparkleIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M10 3.5 11.75 8.25 16.5 10 11.75 11.75 10 16.5 8.25 11.75 3.5 10 8.25 8.25Z" />
      <path d="M17.5 15 18.25 17.25 20.5 18 18.25 18.75 17.5 21 16.75 18.75 14.5 18 16.75 17.25Z" />
    </svg>
  );
}
