import type {
  DesktopCodeSignature,
  DesktopCodeSignatureTrust,
} from "@pwragent/shared";
import type { SettingsPathRowChip } from "./SettingsPathRow";

/**
 * Turns a code-signature reading into a row chip.
 *
 * Tone is deliberate and is not a ranking of the trust levels:
 *
 * - `platform` and `notarized` are the two levels that identify a
 *   publisher AND have been verified, so they read positive.
 * - `publisher` and `adhoc` are **neutral**. Ad-hoc especially: every
 *   Homebrew bottle is ad-hoc signed, because Homebrew relinks it at
 *   install and invalidates whatever the upstream signature was. A
 *   warning on the default state of a developer machine's `git` would
 *   train operators to ignore the chip.
 * - `unsigned` warns — worth a look for a file that is early on `PATH`
 *   and named `git`, but not an accusation.
 * - `invalid` is the only danger tone. A signature that does not verify
 *   is the one reading that means something is actually wrong.
 *
 * `unknown`, `unsupported`, and a reading that has not arrived yet all
 * render nothing. A chip reading "Unknown" on Linux, where there is no
 * platform-wide binary signing to report, would look like a defect.
 */
const TRUST_LABELS: Record<DesktopCodeSignatureTrust, string | undefined> = {
  // "System" rather than "Signed": an OS-vendor signature is a distinct,
  // stronger claim than a third-party one, and labelling both "Signed"
  // throws that away on exactly the rows where it matters — Apple's
  // /usr/bin/git next to a Developer ID app.
  platform: "System",
  notarized: "Notarized",
  publisher: "Signed",
  adhoc: "Ad-hoc",
  unsigned: "Unsigned",
  invalid: "Bad signature",
  unknown: undefined,
  unsupported: undefined,
};

const TRUST_TONES: Record<
  DesktopCodeSignatureTrust,
  SettingsPathRowChip["tone"]
> = {
  platform: "ok",
  notarized: "ok",
  publisher: "muted",
  adhoc: "muted",
  unsigned: "warn",
  invalid: "err",
  unknown: "muted",
  unsupported: "muted",
};

const TRUST_DESCRIPTIONS: Record<DesktopCodeSignatureTrust, string> = {
  platform: "Signed by the operating system vendor.",
  notarized: "Signed with a Developer ID certificate and notarized by Apple.",
  publisher: "Carries a publisher signature.",
  adhoc:
    "Ad-hoc signed: the file's integrity is protected but nothing identifies who built it. This is normal for a Homebrew build.",
  unsigned: "No code signature.",
  invalid: "A signature is present but did not verify.",
  unknown: "The code signature could not be read.",
  unsupported: "This platform reports no code signature.",
};

export function codeSignatureChip(
  signature: DesktopCodeSignature | undefined,
): SettingsPathRowChip | undefined {
  if (!signature) return undefined;
  const label = TRUST_LABELS[signature.trust];
  if (!label) return undefined;

  const detail = [
    TRUST_DESCRIPTIONS[signature.trust],
    signature.signer,
    signature.teamId ? `Team ${signature.teamId}` : undefined,
    signature.detail,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    key: "code-signature",
    label,
    title: detail,
    tone: TRUST_TONES[signature.trust],
  };
}
