import { useState } from "react";
import type { DesktopPwrAgentProfileSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { usePwrAgentProfiles } from "../../lib/usePwrAgentProfiles";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";

export function ProfilesSettings(props: { desktopApi?: DesktopApi }) {
  const profiles = usePwrAgentProfiles(props.desktopApi);
  const [deleteCandidate, setDeleteCandidate] =
    useState<DesktopPwrAgentProfileSummary | null>(null);
  const [actionError, setActionError] = useState<string>();
  const [busyProfile, setBusyProfile] = useState<string>();

  const runProfileAction = async (
    profile: string,
    action: () => Promise<void>,
  ) => {
    setActionError(undefined);
    setBusyProfile(profile);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyProfile(undefined);
    }
  };

  return (
    <SettingsSectionStack paneId="profiles" aria-label="Profile settings">
      <SettingsPanelHead
        eyebrow="Profiles"
        title="PwrAgent profiles"
        help="Profiles isolate PwrAgent settings, state, worktrees, and encrypted secrets. Launches with --profile or PWRAGENT_PROFILE still override the startup default."
      />

      <SettingsSection
        eyebrow="Profiles"
        title="Profile list"
        description="Choose which profile opens when no environment profile is set, or open another profile in a new app instance."
        chip={
          profiles.activeProfile ? `active:${profiles.activeProfile}` : "profiles"
        }
        chipKind="ok"
      >
        {profiles.loading ? (
          <p className="settings-empty">Loading profiles...</p>
        ) : profiles.profiles.length ? (
          <div className="settings-paths">
            {profiles.profiles.map((profile) => (
              <PwrAgentProfileRow
                key={profile.name}
                busy={busyProfile === profile.name}
                profile={profile}
                onDelete={() => setDeleteCandidate(profile)}
                onOpen={() => {
                  void runProfileAction(profile.name, () =>
                    profiles.openProfile(profile.name),
                  );
                }}
                onUseDefault={() => {
                  void runProfileAction(profile.name, () =>
                    profiles.setDefaultProfile(profile.name),
                  );
                }}
              />
            ))}
          </div>
        ) : (
          <p className="settings-empty">No profiles found.</p>
        )}
        {profiles.error ? (
          <p className="settings-row__error" role="alert">
            {profiles.error}
          </p>
        ) : null}
        {actionError ? (
          <p className="settings-row__error" role="alert">
            {actionError}
          </p>
        ) : null}
      </SettingsSection>

      {deleteCandidate ? (
        <ProfileDeleteDialog
          profile={deleteCandidate}
          busy={busyProfile === deleteCandidate.name}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={() => {
            const profileName = deleteCandidate.name;
            void runProfileAction(profileName, async () => {
              await profiles.deleteProfile(profileName);
              setDeleteCandidate(null);
            });
          }}
        />
      ) : null}
    </SettingsSectionStack>
  );
}

function PwrAgentProfileRow(props: {
  busy: boolean;
  profile: DesktopPwrAgentProfileSummary;
  onDelete: () => void;
  onOpen: () => void;
  onUseDefault: () => void;
}) {
  const profile = props.profile;
  const canOpen = !profile.active;
  const displayName = profile.displayName || profile.name;
  const lastUsed = profile.lastUsed
    ? `Last used ${formatLastUsed(profile.lastUsed)}`
    : "Not launched yet";

  return (
    <div
      className={`settings-pathrow settings-profile-row${
        profile.active ? " is-selected" : ""
      }`}
    >
      <div className="settings-pathrow__body">
        <span className="settings-pathrow__title">{displayName}</span>
        <span className="settings-pathrow__path">{profile.profileDir}</span>
        <span className="settings-profile-row__meta">{lastUsed}</span>
      </div>
      <div className="settings-pathrow__chips">
        {profile.active ? (
          <span className="settings-pathrow__chip settings-pathrow__chip--ok">
            Active
          </span>
        ) : null}
        {profile.default ? (
          <span className="settings-pathrow__chip settings-pathrow__chip--warn">
            Startup default
          </span>
        ) : null}
      </div>
      <div className="settings-profile-row__actions">
        <button
          className="button button--secondary settings-profile-row__button"
          disabled={props.busy || profile.default}
          type="button"
          onClick={props.onUseDefault}
        >
          Use on startup
        </button>
        <button
          className="button button--secondary settings-profile-row__button"
          disabled={props.busy || !canOpen}
          type="button"
          onClick={props.onOpen}
        >
          Open
        </button>
        <button
          className="button button--ghost settings-profile-row__button settings-profile-row__button--danger"
          disabled={props.busy || !profile.canDelete}
          type="button"
          onClick={props.onDelete}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function ProfileDeleteDialog(props: {
  busy: boolean;
  profile: DesktopPwrAgentProfileSummary;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="settings-confirm-modal" role="presentation">
      <div
        aria-labelledby="delete-profile-heading"
        aria-modal="true"
        className="settings-confirm-dialog"
        role="dialog"
      >
        <h2 id="delete-profile-heading">Delete profile?</h2>
        <p>
          Delete <strong>{props.profile.displayName || props.profile.name}</strong>{" "}
          from this Mac. This removes its PwrAgent config, SQLite state,
          worktrees, and encrypted secret records.
        </p>
        <p>Codex auth homes under ~/.codex are not deleted.</p>
        <div className="settings-confirm-dialog__actions">
          <button
            className="button button--secondary"
            disabled={props.busy}
            type="button"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            className="button button--ghost settings-profile-row__button--danger"
            disabled={props.busy}
            type="button"
            onClick={props.onConfirm}
          >
            Delete profile
          </button>
        </div>
      </div>
    </div>
  );
}

function formatLastUsed(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
