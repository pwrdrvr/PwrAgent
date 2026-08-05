import type { ReactElement } from "react";

/**
 * Placeholder per-instance glyph for federation surfaces (⌘K remote rows,
 * pinned remote thread chips, the transcript watermark).
 *
 * SWAP SEAM: the Star Map celestial icon system (SVG set + federation-synced
 * assignment) replaces the body of `InstanceGlyph` when it lands — callers
 * pass only `instanceId` + `size`, so the swap must not touch call sites.
 * Until then the glyph is a deterministic pick from a small abstract set,
 * drawn with `currentColor` so it follows the surrounding text token.
 */
const GLYPH_VARIANT_COUNT = 6;

function glyphVariant(instanceId: string): number {
  let hash = 0;
  for (let index = 0; index < instanceId.length; index += 1) {
    hash = (hash * 31 + instanceId.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % GLYPH_VARIANT_COUNT;
}

export function InstanceGlyph(props: {
  instanceId: string;
  size?: number;
}): ReactElement {
  const size = props.size ?? 12;
  const variant = glyphVariant(props.instanceId);
  return (
    <svg
      aria-hidden="true"
      className="instance-glyph"
      data-instance-glyph-variant={variant}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeWidth="1.4"
      viewBox="0 0 16 16"
      width={size}
    >
      {variant === 0 ? (
        // Ringed orb
        <>
          <circle cx="8" cy="8" r="3.4" />
          <ellipse cx="8" cy="8" rx="6.4" ry="2.4" />
        </>
      ) : null}
      {variant === 1 ? (
        // Orbit + moon
        <>
          <circle cx="8" cy="8" r="3" />
          <circle cx="8" cy="8" r="6.4" strokeDasharray="2.5 2.5" />
          <circle cx="13" cy="4.4" fill="currentColor" r="1.2" stroke="none" />
        </>
      ) : null}
      {variant === 2 ? (
        // Four-point star
        <path d="M8 1.8 L9.6 6.4 L14.2 8 L9.6 9.6 L8 14.2 L6.4 9.6 L1.8 8 L6.4 6.4 Z" />
      ) : null}
      {variant === 3 ? (
        // Crescent
        <path d="M10.6 2.4 A6.2 6.2 0 1 0 10.6 13.6 A5 5 0 1 1 10.6 2.4 Z" />
      ) : null}
      {variant === 4 ? (
        // Twin orbs
        <>
          <circle cx="5.4" cy="8" r="2.8" />
          <circle cx="11.4" cy="8" r="1.8" />
          <path d="M8.1 8 L9.7 8" />
        </>
      ) : null}
      {variant === 5 ? (
        // Comet
        <>
          <circle cx="11" cy="5" r="2.4" />
          <path d="M8.9 7.1 L2.2 13.8 M10.2 8.6 L5.4 13.4 M7.4 5.8 L2.6 10.6" />
        </>
      ) : null}
    </svg>
  );
}

/**
 * Instance chip: glyph + peer display label. Rendered on ⌘K remote rows and
 * pinned remote thread rows so the operator can tell where a thread runs.
 */
export function InstanceChip(props: {
  instanceId: string;
  label: string;
}): ReactElement {
  return (
    <span
      aria-label={`Runs on ${props.label}`}
      className="chip chip--instance"
      title={`${props.label} · ${props.instanceId}`}
    >
      <InstanceGlyph instanceId={props.instanceId} size={12} />
      <span className="chip--instance__label">{props.label}</span>
    </span>
  );
}

/**
 * Alpha-blended instance glyph behind the transcript: the owning instance's
 * glyph while viewing a remote-pinned thread, the local instance's while
 * viewing a local thread. Purely decorative — hidden from the a11y tree.
 */
export function InstanceWatermark(props: {
  instanceId: string;
}): ReactElement {
  return (
    <div aria-hidden="true" className="instance-watermark">
      <InstanceGlyph instanceId={props.instanceId} size={280} />
    </div>
  );
}
