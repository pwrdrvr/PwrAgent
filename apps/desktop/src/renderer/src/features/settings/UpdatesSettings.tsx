// Settings -> Updates: which published build PwrAgent follows, and when it
// installs one.
//
// This pane was carved out of Settings -> General, where it had grown into the
// largest card on a page otherwise made of one-line toggles. PwrGit and
// PwrSnap already give Updates its own nav row; a release channel is not an
// "appearance default", and burying it under General meant an operator who
// came looking for the update controls had to scroll past six unrelated cards
// to find them.
//
// The selection is two independent axes on the wire (`updates.train` +
// `updates.channel`); a tile click writes both in one patch, which is what
// tells main the pair is a pin rather than an inference.

import { useEffect, useState } from "react";
import { releaseNotesUrl } from "@pwragent/shared";
import type {
  DesktopSettingsSnapshot,
  DesktopUpdateChannel,
  DesktopUpdateTrain,
} from "@pwragent/shared";
import type {
  AppUpdateCheckResult,
  AppUpdateReleaseVersions,
  AppUpdateStatus,
} from "../../../../shared/app-metadata";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsPendingIndicator,
  SettingsSection,
  SettingsSectionStack,
  useSettingsFieldPending,
} from "./SettingsLayout";
import { ReleaseNotesLink } from "../update/ReleaseNotesLink";
import { ReleaseSlotMatrix } from "./ReleaseSlotMatrix";
import { sourceBadge } from "./settings-fields";

function updateResultText(result: AppUpdateCheckResult): string {
  if (result.status === "skipped") {
    return result.reason;
  }
  if (result.status === "error") {
    return `Update check failed: ${result.message}`;
  }
  if (result.status === "checking") {
    return "Checking for updates...";
  }
  if (result.status === "no-update") {
    return `You're up to date (v${result.version}).`;
  }
  if (result.status === "downloaded") {
    return result.direction === "downgrade"
      ? `Switch ready: v${result.version}. Restart to switch.`
      : `Update ready: v${result.version}. Restart to install.`;
  }
  if (result.status === "canceled") {
    return `Download canceled. v${result.version} is still available - check again to download it.`;
  }
  return result.direction === "downgrade"
    ? `Switch to v${result.version}. Downloading in the background.`
    : `Update available: v${result.version}. Downloading in the background.`;
}

/** Whichever version the sentence above just named, or `undefined` for the
 *  three results that name none. Asked of the union itself rather than by
 *  listing those three: a status added later carries a link exactly when it
 *  carries a version, with nothing here to keep in step. */
function updateResultVersion(
  result: AppUpdateCheckResult,
): string | undefined {
  return "version" in result ? result.version : undefined;
}

export function UpdatesSettings(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  /** Both axes travel together: naming either one is what tells main the
   *  selection is a pin rather than a guess, so a tile click writes the
   *  whole pair in one patch. */
  onUpdateSelectionChange: (value: {
    channel: DesktopUpdateChannel;
    train: DesktopUpdateTrain;
  }) => Promise<void>;
}) {
  const [releaseVersions, setReleaseVersions] = useState<
    AppUpdateReleaseVersions | undefined
  >();
  // Whether the release read has ANSWERED, not whether it succeeded. A read
  // that fails still settles, and the tiles must fall through to Unavailable
  // rather than claim a read is in flight for the rest of the window's life.
  const [releasesSettled, setReleasesSettled] = useState(false);
  const [installedVersion, setInstalledVersion] = useState<string>();
  const [updateChecking, setUpdateChecking] = useState(false);
  // The slot matrix is a grid, so it has no room for the indicator beside it
  // the way a segmented control does — the field renders it underneath.
  const updateSelectionPending = useSettingsFieldPending();
  const [updateResult, setUpdateResult] = useState<
    AppUpdateCheckResult | undefined
  >();
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({
    status: "idle",
  });
  const [updateRestarting, setUpdateRestarting] = useState(false);
  const [updateRestartError, setUpdateRestartError] = useState<
    string | undefined
  >();
  const updateChannel = props.snapshot.updates.channel;
  const updateTrain = props.snapshot.updates.train;
  const updateSelectionSource = props.snapshot.updates.selectionSource;

  useEffect(() => {
    let canceled = false;
    const read = props.desktopApi?.readAppUpdateReleaseVersions;
    // A build without the reader settles immediately: every slot is
    // Unavailable, which is the honest report, and "Loading…" forever is not.
    if (!read) {
      setReleasesSettled(true);
      return;
    }
    void read().then(
      (versions) => {
        if (canceled) {
          return;
        }
        setReleaseVersions(versions);
        setReleasesSettled(true);
      },
      () => {
        if (!canceled) {
          setReleasesSettled(true);
        }
      },
    );
    return () => {
      canceled = true;
    };
  }, [props.desktopApi]);

  // The running build's own version, for the matrix's "Installed" chip. The
  // slot it lands in is the one an inferred selection is derived from, so
  // seeing it marked is how an operator checks that inference agreed.
  useEffect(() => {
    let canceled = false;
    const read = props.desktopApi?.readAppMetadata;
    if (!read) {
      return;
    }
    void read().then(
      (metadata) => {
        if (!canceled) {
          setInstalledVersion(metadata.applicationVersion);
        }
      },
      () => {
        // Cosmetic: without it no tile carries the chip, which is the same
        // as a build whose version matches no published slot.
      },
    );
    return () => {
      canceled = true;
    };
  }, [props.desktopApi]);

  useEffect(() => {
    let canceled = false;
    let receivedEvent = false;
    const unsubscribe = props.desktopApi?.onAppUpdateStatus?.((status) => {
      receivedEvent = true;
      setUpdateStatus(status);
      if (status.status === "downloaded") {
        setUpdateRestartError(undefined);
        setUpdateRestarting(false);
      }
    });
    void props.desktopApi?.readAppUpdateStatus?.().then((status) => {
      if (!canceled && !receivedEvent) {
        setUpdateStatus(status);
      }
    });
    return () => {
      canceled = true;
      unsubscribe?.();
    };
  }, [props.desktopApi]);

  const checkForUpdates = props.desktopApi?.checkForAppUpdates;
  const downloadedVersion =
    updateStatus.status === "downloaded" ? updateStatus.version : undefined;
  // The version the inline result sentence names, if it names one.
  const resultVersion = updateResult
    ? updateResultVersion(updateResult)
    : undefined;
  // A resolved selection that is older than the running build is a switch back
  // onto the operator's own channel, not an update.
  const downloadedIsSwitchBack =
    updateStatus.status === "downloaded"
    && updateStatus.direction === "downgrade";
  const restartActionLabel = downloadedIsSwitchBack
    ? "Restart to Switch"
    : "Restart to Update";
  const handleCheckForUpdate = async () => {
    if (!checkForUpdates) {
      return;
    }
    setUpdateChecking(true);
    setUpdateResult(undefined);
    try {
      const result = await checkForUpdates();
      setUpdateResult(result);
      setUpdateStatus(result);
      // The check refreshed the main-process release cache, so this read is
      // served from memory and clears any stale Unavailable slot labels. It is
      // cosmetic: failing it must not overwrite the check result above.
      try {
        const versions =
          await props.desktopApi?.readAppUpdateReleaseVersions?.();
        if (versions) {
          setReleaseVersions(versions);
          setReleasesSettled(true);
        }
      } catch {
        // Keep the check result the operator just asked for.
      }
    } catch (err) {
      setUpdateResult({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUpdateChecking(false);
    }
  };
  const handleRestartUpdate = async () => {
    if (!props.desktopApi?.installAppUpdate) {
      setUpdateRestartError("Restart is not available in this build.");
      return;
    }
    setUpdateRestarting(true);
    setUpdateRestartError(undefined);
    const result = await props.desktopApi.installAppUpdate();
    if (result.status === "error") {
      setUpdateRestartError(result.message);
      setUpdateRestarting(false);
    }
  };

  return (
    <SettingsSectionStack paneId="updates" aria-label="Update settings">
      <SettingsPanelHead
        eyebrow="Updates"
        title="Updates"
        help="Which published build PwrAgent follows, and when it installs one."
      />

      <SettingsSection
        eyebrow="Updates"
        title="Release channel"
        chip={
          updateTrain.source === "config"
            ? sourceBadge(updateTrain)
            : sourceBadge(updateChannel)
        }
      >
        <div className="settings-fields">
          <SettingsField
            label="Follow this build"
            sub="Two trains, two tracks. Stable is the smoke-checked feed; Beta follows main. Latest is smoke-checked within its train; Prerelease is newer and may not install."
            help={
              // The inference rule is only worth explaining while it is
              // still live — once an operator pins a slot, saying "we
              // guessed" is noise.
              updateSelectionSource === "inferred"
                ? "Following the build you installed. Pick a slot to pin it."
                : undefined
            }
            error={updateTrain.error ?? updateChannel.error}
            source={
              // One field now covers both axes, so it reports whichever axis
              // the config actually supplied. Reading only the train badge
              // showed "default" for a pin whose train fell back, disagreeing
              // with the section chip directly above it.
              updateTrain.source === "config"
                ? sourceBadge(updateTrain)
                : sourceBadge(updateChannel)
            }
            actions={
              <SettingsPendingIndicator
                pending={updateSelectionPending.pending}
              />
            }
            control={
              <ReleaseSlotMatrix
                channel={updateChannel.value}
                disabled={props.saving}
                installedVersion={installedVersion}
                releaseVersions={releaseVersions}
                releasesSettled={releasesSettled}
                train={updateTrain.value}
                onSelect={(next) => {
                  const result = props.onUpdateSelectionChange(next);
                  updateSelectionPending.track(result);
                  return result;
                }}
              />
            }
          />
          <SettingsField
            label="Check now"
            sub="PwrAgent also checks on its own. A build older than the one you are running only installs when you ask for it here."
            help={
              updateResult ? (
                <span
                  className={
                    updateResult.status === "error"
                      ? "settings-update-channel__result settings-update-channel__result--error"
                      : "settings-update-channel__result"
                  }
                  role={updateResult.status === "error" ? "alert" : undefined}
                >
                  {updateResultText(updateResult)}
                  {/* Scoped to the version that sentence just named, so it
                      has to stay inline with it rather than float down to
                      the controls. */}
                  <ReleaseNotesLink
                    {...(resultVersion === undefined
                      ? {}
                      : { ariaLabel: `Release notes for v${resultVersion}` })}
                    className="settings-update-channel__notes"
                    url={releaseNotesUrl(resultVersion)}
                  />
                </span>
              ) : undefined
            }
            control={
              <div className="settings-update-channel">
                <div className="settings-update-channel__controls">
                  {downloadedVersion ? (
                    <button
                      aria-label={`${restartActionLabel} (${downloadedVersion})`}
                      className="button button--primary settings-update-channel__restart-button"
                      type="button"
                      disabled={
                        updateRestarting || !props.desktopApi?.installAppUpdate
                      }
                      onClick={() => {
                        void handleRestartUpdate();
                      }}
                    >
                      <span>{restartActionLabel}</span>
                      <span className="settings-update-channel__restart-version">
                        ({downloadedVersion})
                      </span>
                    </button>
                  ) : null}
                  <button
                    className="button button--secondary settings-update-channel__button"
                    type="button"
                    disabled={!checkForUpdates || props.saving || updateChecking}
                    onClick={() => {
                      void handleCheckForUpdate();
                    }}
                  >
                    {updateChecking ? "Checking..." : "Check for Update"}
                  </button>
                </div>
                {downloadedVersion ? (
                  <>
                    <span className="settings-update-channel__downloaded">
                      Downloaded version: {downloadedVersion}
                      {/* Named for the downloaded build specifically: the
                          status line above can be sitting on the same
                          version, and two controls with one accessible name
                          are not a usable list. */}
                      <ReleaseNotesLink
                        ariaLabel={`Release notes for the downloaded v${downloadedVersion}`}
                        className="settings-update-channel__notes"
                        url={releaseNotesUrl(downloadedVersion)}
                      />
                    </span>
                    {updateRestartError ? (
                      <span
                        className="settings-update-channel__result settings-update-channel__result--error"
                        role="alert"
                      >
                        {updateRestartError}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </div>
            }
          />
        </div>
      </SettingsSection>
    </SettingsSectionStack>
  );
}
