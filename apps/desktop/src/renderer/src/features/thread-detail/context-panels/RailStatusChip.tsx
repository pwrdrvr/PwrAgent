import type { ReactNode } from "react";

export type RailChipTone =
  | "ok"
  | "error"
  | "warning"
  | "active"
  | "merged"
  | "neutral";

type RailStatusChipProps = {
  tone: RailChipTone;
  /**
   * Tint the pill (red) so a bad state stands out — used for failed
   * sub-agents and failing/conflicting PR checks.
   */
  alert?: boolean;
  children: ReactNode;
};

/**
 * A non-interactive status pill — the read-only sibling of the clickable
 * `PrChip`. Same pill shape + colored leading dot + neutral label, so status
 * reads identically across the sidebar, the Sub-Agents card, and the Pull
 * Requests card. Color comes only from the theme-safe `--status-*` dot
 * palette (never `--success-text`-style text greens, which differ from the
 * dot greens and read inconsistently next to a `PrChip`).
 */
export function RailStatusChip(props: RailStatusChipProps) {
  return (
    <span className={`rail-chip${props.alert ? " rail-chip--alert" : ""}`}>
      <span
        aria-hidden="true"
        className={`rail-chip__dot rail-chip__dot--${props.tone}`}
      />
      {props.children}
    </span>
  );
}
