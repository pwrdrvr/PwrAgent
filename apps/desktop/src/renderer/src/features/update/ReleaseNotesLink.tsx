// "Release notes" — the one control that takes a version out to its
// published GitHub release page.
//
// Every update surface renders it (the banner's live and offer cards, the
// settled outcome notice, Settings -> General -> Updates' slot matrix and
// status line, Settings -> About) and they share this component rather than
// each writing their own control, for the same reason they share
// `updateProgressCopy`: the wording and the behavior must not drift. Only
// the skin differs, which is what `className` is for.
//
// It is a BUTTON, not an anchor. Unlike PwrSnap — which this was ported from
// and which installs no navigation guard — PwrAgent's
// `applyWindowSecurityHardening` puts both a `will-navigate` block and a
// `setWindowOpenHandler` on every window, so an anchor here would be safe
// too. The button is chosen for what it is rather than for what it is not:
//
//   - Semantically it performs an action — hand a URL to the OS browser —
//     rather than navigating this document. `window.open` is the only thing
//     that ever opens it, exactly as `openExternalUrl` (PR chips),
//     `GrokCliUpdateNotice` (managed Grok release pages), and every other
//     renderer-side external open in this app already do.
//   - It does not depend on the guard to be correct. Settings -> About's two
//     `<a target="_blank">` rows do; they predate this and are not worth
//     churning, but this is what the update surfaces use instead of
//     multiplying them.
//
// Render nothing when there is no URL. `releaseNotesUrl` answers undefined
// for a string that is not a version — the `"unknown"` an updater answer
// without `updateInfo` produces, the slot matrix's `Loading…` and
// `Unavailable` headlines — and a dead "Release notes" control is worse than
// none. In the slot matrix that also keeps an empty slot from growing a
// caption it has nothing to say under.

import type { ReactElement } from "react";
import { PopoutIcon } from "../../icons";
import { openExternalUrl } from "../../lib/open-external-url";

/**
 * Hand a composed release-notes URL to the OS browser.
 *
 * Exported because the settled-check outcome does not render this component:
 * it rides on `AppNoticeToastNotice.actions`, which owns its own button
 * markup. Sharing this call is what keeps that path from becoming a second
 * opinion about how a release page opens.
 *
 * A named seam over `openExternalUrl`, not a second implementation of it.
 * The rail's PR chips already open a GitHub page this way; two copies of
 * `window.open(url, "_blank", "noopener,noreferrer")` is how one of them
 * loses an argument.
 */
export function openReleaseNotes(url: string): void {
  openExternalUrl(url);
}

export type ReleaseNotesLinkProps = {
  /** From `releaseNotesUrl(version)`. `undefined` renders nothing. */
  url: string | undefined;
  /** Surface skin. Every caller styles it in its own namespace. */
  className: string;
  /** Visible text. The status line and the slot tiles have room for less. */
  label?: string;
  /**
   * Accessible name, when the visible label alone does not say WHICH
   * version's notes these are — the slot matrix renders four of these at
   * once, and "Release notes, Release notes, Release notes, Release notes"
   * is not a usable list.
   *
   * Left off, it reaches the DOM as `undefined`, which React drops, so the
   * button keeps its visible label as its name.
   */
  ariaLabel?: string;
};

export function ReleaseNotesLink({
  url,
  className,
  label = "Release notes",
  ariaLabel,
}: ReleaseNotesLinkProps): ReactElement | null {
  if (url === undefined) {
    return null;
  }
  return (
    <button
      className={className}
      type="button"
      title={url}
      aria-label={ariaLabel}
      onClick={() => {
        openReleaseNotes(url);
      }}
    >
      {label}
      <PopoutIcon size={10} strokeWidth={2.2} />
    </button>
  );
}
