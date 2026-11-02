/**
 * The renderer's one busy ring. Every surface that shows one renders it
 * through this component; `reduced-motion-contract.test.ts` fails on a raw
 * `pending-spinner` class anywhere else.
 *
 * The ring is always decorative and `aria-hidden`. Give the busy state to
 * something a screen reader can read: text beside the ring naming the work,
 * or `aria-busy` on the control.
 *
 * `pairing` is the ring's reduced-motion decision, and every caller makes it:
 *
 * - `paired`: the ring sits beside visible text naming the work, such as
 *   "Saving…" or a provider row's current step. Under reduced motion it stops
 *   and goes accent-tinted, and the text carries the state.
 * - `standalone`: the motion is the surface's only progress signal, such as
 *   the composer Run button's bare ring. It keeps spinning under reduced
 *   motion. `standaloneReason` says why, so the choice reads at the call site
 *   and in review.
 *
 * See the comments above `.pending-spinner` and its reduced-motion query in
 * `styles/app.css`.
 */
export type PendingSpinnerProps =
  | {
      pairing: "paired";
      /** 12px beside 12px text, or 18px in a preview tile. Default 14px. */
      size?: "sm" | "lg";
      standaloneReason?: never;
    }
  | {
      pairing: "standalone";
      size?: "sm" | "lg";
      /** Why motion is the only progress signal here. Not rendered. */
      standaloneReason: string;
    };

export function PendingSpinner(props: PendingSpinnerProps) {
  const className = [
    "pending-spinner",
    props.size ? `pending-spinner--${props.size}` : "",
    props.pairing === "paired" ? "pending-spinner--paired" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return <span aria-hidden="true" className={className} />;
}
