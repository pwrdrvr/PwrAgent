import { useEffect, useRef, useState } from "react";
import { ShieldIcon } from "./guided-setup-icons";

/** Single source of truth for the gate-requirement sentence, shared by the
 *  `aria-describedby` hint (announced on focus) and the assertive live
 *  region (announced when a locked Continue button is clicked). */
export const MESSAGING_GATE_REQUIREMENT =
  'Select the "I understand" checkbox to continue with messaging setup.';

/**
 * The messaging-safety screen: the three principles, and the acknowledgement
 * checkbox that unlocks messaging setup. The guided messaging flow and the
 * gate in front of Settings → Messaging both render it.
 *
 * Continue buttons stay focusable while the box is unticked. Clicking one
 * bumps `flashNonce`, which replays a one-shot ring around the
 * acknowledgement and announces the requirement, pointing at the box rather
 * than leaving a dead button.
 */
export function MessagingSafetyNotice(props: {
  acknowledged: boolean;
  onAcknowledgedChange: (next: boolean) => void;
  /**
   * Bumped by the parent each time a locked Continue is clicked. Each change
   * remounts the flash so the ring replays from the top. A value present at
   * mount never flashes.
   */
  flashNonce: number;
  /** id for the hidden hint a locked Continue points at with
   *  `aria-describedby`. */
  hintId: string;
  /** When the record already exists, say so under the checkbox. */
  recordedAt?: string;
  /** "h1" inside the guided dialog, "h2" inside a Settings pane. */
  headingLevel?: "h1" | "h2";
}) {
  // Replay the ring ONLY when the nonce changes during this screen's
  // lifetime. Seeding the ref from the nonce at mount means coming back to
  // the screen with a stale non-zero nonce does NOT replay the flash.
  const [flashKey, setFlashKey] = useState(0);
  const lastFlashNonce = useRef(props.flashNonce);
  useEffect(() => {
    if (props.flashNonce !== lastFlashNonce.current) {
      lastFlashNonce.current = props.flashNonce;
      setFlashKey((key) => key + 1);
    }
  }, [props.flashNonce]);

  const Heading = props.headingLevel ?? "h1";

  return (
    <div className="guided-setup__safety">
      <div className="guided-setup__safety-icon">
        <ShieldIcon />
      </div>
      <Heading className="guided-setup__title guided-setup__title--center">
        Messaging is optional — and worth thinking about first
      </Heading>
      <p className="guided-setup__sub guided-setup__sub--center">
        Connecting a chat platform lets you drive PwrAgent from your phone.
        You can also skip this and stay on the desktop. Either way, three
        principles to read before you decide.
      </p>
      <ul className="guided-setup__safety-list">
        <li>
          <strong>Try personal first.</strong> Use a personal computer and
          personal accounts before connecting any work device or work account.
        </li>
        <li>
          <strong>If you do connect a work device,</strong> connect only the
          work messaging platform — never personal messaging platforms — on
          that device.
        </li>
        <li>
          <strong>Talk to your security team</strong> before connecting a work
          device to anything. Sadly, we know what the answer often will be.
          Act responsibly.
        </li>
      </ul>
      <label
        className={`guided-setup__safety-ack${props.acknowledged ? " is-checked" : ""}`}
      >
        <input
          type="checkbox"
          checked={props.acknowledged}
          onChange={(event) => props.onAcknowledgedChange(event.target.checked)}
          className="guided-setup__visually-hidden"
        />
        <span
          className={`guided-setup__safety-check${props.acknowledged ? " is-on" : ""}`}
          aria-hidden
        />
        <span className="guided-setup__safety-ack-text">
          <strong>I understand.</strong> I have carefully evaluated whether
          and how to proceed with connecting an agent to messaging platforms.
          All risk — including risk to my employment — is my own. I agree to
          hold PwrDrvr LLC and all PwrAgent contributors harmless for the
          outcomes of any actions I take here.
        </span>
        {flashKey > 0 ? (
          // Keyed on the local counter so each locked click remounts the
          // element and restarts the flash-then-fade animation. aria-hidden +
          // pointer-events:none keep it decorative.
          <span
            key={flashKey}
            className="guided-setup__safety-ack-flash"
            aria-hidden
          />
        ) : null}
      </label>
      {props.recordedAt ? (
        <p className="guided-setup__safety-fork-hint">
          Acknowledged {new Date(props.recordedAt).toLocaleString()}.
        </p>
      ) : null}
      <span id={props.hintId} className="guided-setup__visually-hidden">
        {MESSAGING_GATE_REQUIREMENT}
      </span>
      <span
        role="status"
        aria-live="assertive"
        className="guided-setup__visually-hidden"
      >
        {flashKey > 0 ? (
          <span key={flashKey}>{MESSAGING_GATE_REQUIREMENT}</span>
        ) : null}
      </span>
      <p className="guided-setup__safety-fork-hint">
        You can always add or change messaging providers later from
        Settings → Messaging.
      </p>
    </div>
  );
}
