import { Fragment, useCallback, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  DESKTOP_UPDATE_CHANNELS,
  DESKTOP_UPDATE_TRAINS,
} from "@pwragent/shared";
import type {
  DesktopUpdateChannel,
  DesktopUpdateTrain,
} from "@pwragent/shared";
import type {
  AppUpdateReleaseInfo,
  AppUpdateReleaseVersions,
} from "../../../../shared/app-metadata";

/**
 * All four published release slots at once — trains as rows, tracks as
 * columns.
 *
 * This replaces two stacked segmented controls that had a reporting bug
 * baked into their shape: each control could only label itself with the
 * slot the OTHER control was currently on. With the track control on
 * Latest, the Beta button read "Beta — Unavailable" while Beta/Prerelease
 * held a shipped alpha one click away. A control cannot report an empty
 * slot without hiding a populated sibling when it only has one label per
 * axis, so the fix is to stop asking it to: every tile states its own
 * resolved version, selected or not.
 *
 * The selection is still two independent axes on the wire
 * (`updates.train` + `updates.channel`); a tile click writes both in one
 * patch, and main derives `updates.selection_source = "user"` from that
 * write. See `resolveUpdateSelection` in
 * main/settings/desktop-settings-service.ts.
 */

const TRAIN_LABEL: Record<DesktopUpdateTrain, string> = {
  stable: "Stable",
  beta: "Beta",
};

const CHANNEL_LABEL: Record<DesktopUpdateChannel, string> = {
  latest: "Latest",
  prerelease: "Prerelease",
};

const SLOT_SUB: Record<`${DesktopUpdateTrain}:${DesktopUpdateChannel}`, string> =
  {
    "stable:latest": "Smoke-checked. The default for everyone.",
    "stable:prerelease": "Release candidates for the stable line.",
    "beta:latest": "Beta builds off main.",
    "beta:prerelease": "Newest alpha off main. May not install.",
  };

/** Render and arrow-walk order, derived from the shared axis lists so the
 *  headers, the tiles, and the keyboard walk can never disagree about the
 *  grid's shape. */
const SLOT_ORDER: ReadonlyArray<{
  train: DesktopUpdateTrain;
  channel: DesktopUpdateChannel;
}> = DESKTOP_UPDATE_TRAINS.flatMap((train) =>
  DESKTOP_UPDATE_CHANNELS.map((channel) => ({ train, channel })),
);

const COLUMNS = DESKTOP_UPDATE_CHANNELS.length;

/** Release tags carry a leading `v`; `AppMetadata.applicationVersion` does
 *  not, so the "Installed" chip compares the cores. */
function isSameVersion(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }
  return (
    left.trim().replace(/^v/i, "") === right.trim().replace(/^v/i, "")
  );
}

function SlotTile(props: {
  train: DesktopUpdateTrain;
  channel: DesktopUpdateChannel;
  release: AppUpdateReleaseInfo | undefined;
  /** The release read has not answered yet. Distinct from a slot that
   *  answered and has nothing — "Loading" and "Unavailable" are not the
   *  same claim. */
  loading: boolean;
  selected: boolean;
  installed: boolean;
  disabled: boolean;
  /** Roving tabindex: exactly one tile is in the tab order, per the
   *  radiogroup contract. */
  tabbable: boolean;
  onSelect: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  registerRef: (element: HTMLButtonElement | null) => void;
}) {
  const version = props.release?.version;
  const label = `${TRAIN_LABEL[props.train]} ${CHANNEL_LABEL[props.channel]}`;
  const headline = version ?? (props.loading ? "Loading…" : "Unavailable");
  const sub =
    version !== undefined
      ? SLOT_SUB[`${props.train}:${props.channel}`]
      : props.loading
        ? "Reading published releases."
        // An empty slot says why it is empty rather than going blank and
        // leaving the reader to guess whether the feed broke or the slot
        // simply has nothing yet. It stays clickable either way: a train
        // with no build today still gets one tomorrow.
        : (props.release?.unavailableReason ?? "Nothing published here yet.");

  return (
    <button
      ref={props.registerRef}
      aria-checked={props.selected}
      aria-label={`${label} — ${headline}`}
      className={`settings-release-slot${props.selected ? " is-selected" : ""}`}
      disabled={props.disabled}
      role="radio"
      tabIndex={props.tabbable ? 0 : -1}
      type="button"
      onClick={props.onSelect}
      onKeyDown={props.onKeyDown}
    >
      <span
        className={`settings-release-slot__version${
          version === undefined ? " is-empty" : ""
        }`}
      >
        {headline}
      </span>
      <span className="settings-release-slot__sub">{sub}</span>
      {props.selected || props.installed ? (
        <span className="settings-release-slot__chips">
          {props.selected ? (
            <span className="settings-release-slot__chip is-selected">
              Selected
            </span>
          ) : null}
          {props.installed ? (
            <span className="settings-release-slot__chip is-installed">
              Installed
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

export function ReleaseSlotMatrix(props: {
  channel: DesktopUpdateChannel;
  train: DesktopUpdateTrain;
  disabled?: boolean;
  /** Undefined until the release read answers; see `releasesSettled`. */
  releaseVersions: AppUpdateReleaseVersions | undefined;
  /** The release read has answered, successfully or not. A read that fails
   *  still settles, and the tiles must fall through to Unavailable rather
   *  than claim a read is in flight for the rest of the window's life. */
  releasesSettled: boolean;
  /** Running build, for the "Installed" chip. */
  installedVersion: string | undefined;
  onSelect: (next: {
    train: DesktopUpdateTrain;
    channel: DesktopUpdateChannel;
  }) => Promise<unknown>;
}) {
  const slotRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(
    0,
    SLOT_ORDER.findIndex(
      (slot) => slot.train === props.train && slot.channel === props.channel,
    ),
  );

  // Roving tabindex plus arrow keys — the radiogroup contract, which the
  // pane's `SegmentedControl` leaves to native tab order because its
  // options sit on one axis. Selection deliberately does NOT follow focus:
  // picking a slot rewrites which build PwrAgent installs, so a stray arrow
  // press must not change the feed. The operator commits with Space/Enter
  // (the button's own activation) or a click.
  const onSlotKeyDown = useCallback(
    (index: number) =>
      (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
        const delta =
          event.key === "ArrowRight"
            ? 1
            : event.key === "ArrowLeft"
              ? -1
              : event.key === "ArrowDown"
                ? COLUMNS
                : event.key === "ArrowUp"
                  ? -COLUMNS
                  : 0;
        if (delta === 0) {
          return;
        }
        event.preventDefault();
        const count = SLOT_ORDER.length;
        slotRefs.current[(index + delta + count) % count]?.focus();
      },
    [],
  );

  return (
    <div
      className="settings-release-slots"
      role="radiogroup"
      aria-label="Release channel"
    >
      {/* Header cells are decoration: every tile's accessible name already
          spells out "Stable Latest", so exposing the headers inside the
          radiogroup would interleave duplicate text with the options. */}
      <div className="settings-release-slots__rowhdr" aria-hidden="true" />
      {DESKTOP_UPDATE_CHANNELS.map((headerChannel) => (
        <div
          key={headerChannel}
          className="settings-release-slots__colhdr"
          aria-hidden="true"
        >
          {CHANNEL_LABEL[headerChannel]}
        </div>
      ))}
      {DESKTOP_UPDATE_TRAINS.map((rowTrain) => (
        <Fragment key={rowTrain}>
          <div className="settings-release-slots__rowhdr" aria-hidden="true">
            {TRAIN_LABEL[rowTrain]}
          </div>
          {DESKTOP_UPDATE_CHANNELS.map((slotChannel) => {
            const index = SLOT_ORDER.findIndex(
              (slot) =>
                slot.train === rowTrain && slot.channel === slotChannel,
            );
            const release = props.releaseVersions?.[rowTrain]?.[slotChannel];
            return (
              <SlotTile
                key={slotChannel}
                channel={slotChannel}
                disabled={props.disabled ?? false}
                installed={isSameVersion(
                  release?.version,
                  props.installedVersion,
                )}
                loading={!props.releasesSettled}
                registerRef={(element) => {
                  slotRefs.current[index] = element;
                }}
                release={release}
                selected={index === selectedIndex}
                tabbable={index === selectedIndex}
                train={rowTrain}
                onKeyDown={onSlotKeyDown(index)}
                onSelect={() => {
                  // Re-picking the current slot is not a change, and the
                  // write path bails on an unchanged patch anyway — so
                  // tracking it would announce "Saving…" for no write.
                  if (index === selectedIndex) {
                    return;
                  }
                  void props.onSelect({
                    train: rowTrain,
                    channel: slotChannel,
                  });
                }}
              />
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
