import { useState } from "react";
import type { ReactNode } from "react";
import type {
  DesktopPwrAgentProfileSummary,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  usePwrAgentProfiles,
  type PwrAgentProfilesState,
} from "../../lib/usePwrAgentProfiles";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import { CodexAuthProfileSelect } from "./CodexAuthProfileSelect";

export function ProfilesSettings(props: {
  desktopApi?: DesktopApi;
  profiles?: PwrAgentProfilesState;
  snapshot: DesktopSettingsSnapshot;
  onSettingsChanged: () => Promise<void>;
}) {
  const localProfiles = usePwrAgentProfiles(
    props.profiles ? undefined : props.desktopApi,
  );
  const profiles = props.profiles ?? localProfiles;
  const [deleteCandidate, setDeleteCandidate] =
    useState<DesktopPwrAgentProfileSummary | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
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
        action={
          <button
            className="button button--secondary"
            type="button"
            onClick={() => setCreateOpen(true)}
          >
            Add profile
          </button>
        }
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
                codexProfileControl={
                  <CodexAuthProfileSelect
                    aria-label={`Codex auth profile for ${profile.displayName || profile.name}`}
                    desktopApi={props.desktopApi}
                    disabled={busyProfile === profile.name}
                    discovery={props.snapshot.models.codex.profiles}
                    value={profile.codexProfile.name}
                    onAfterProfilesChanged={props.onSettingsChanged}
                    onChange={async (codexProfile) => {
                      await profiles.setCodexProfile(profile.name, codexProfile);
                      if (profile.active) {
                        await props.onSettingsChanged();
                      }
                    }}
                  />
                }
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
          platform={props.desktopApi?.platform}
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

      {createOpen ? (
        <ProfileCreateDialog
          busy={busyProfile === "__create__"}
          existingProfiles={profiles.profiles}
          onCancel={() => setCreateOpen(false)}
          onCreate={(profile) => {
            void runProfileAction("__create__", async () => {
              await profiles.createProfile(profile);
              setCreateOpen(false);
            });
          }}
        />
      ) : null}
    </SettingsSectionStack>
  );
}

function PwrAgentProfileRow(props: {
  busy: boolean;
  codexProfileControl: ReactNode;
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
        <div className="settings-profile-row__codex">
          <span className="settings-profile-row__label">Codex auth profile</span>
          {props.codexProfileControl}
          <span className="settings-profile-row__meta">
            Applies the next time this PwrAgent profile launches.
          </span>
        </div>
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
  platform?: string;
  profile: DesktopPwrAgentProfileSummary;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const movingToTrash = props.platform === "darwin";
  const actionLabel = movingToTrash ? "Move profile to Trash" : "Delete profile";
  return (
    <div className="settings-confirm-modal" role="presentation">
      <div
        aria-labelledby="delete-profile-heading"
        aria-modal="true"
        className="settings-confirm-dialog settings-confirm-dialog--danger"
        role="dialog"
      >
        <h2 id="delete-profile-heading">Delete profile?</h2>
        {movingToTrash ? (
          <p>
            Move <strong>{props.profile.displayName || props.profile.name}</strong>{" "}
            to Trash. This removes it from PwrAgent and moves its profile folder,
            including config, SQLite state, worktrees, and encrypted secret
            records, to the macOS Trash.
          </p>
        ) : (
          <p>
            Permanently delete{" "}
            <strong>{props.profile.displayName || props.profile.name}</strong>.
            This removes its PwrAgent config, SQLite state, worktrees, and
            encrypted secret records.
          </p>
        )}
        <p>
          Close any other PwrAgent windows using this profile first. Codex auth
          homes under ~/.codex are not deleted.
        </p>
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
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileCreateDialog(props: {
  busy: boolean;
  existingProfiles: DesktopPwrAgentProfileSummary[];
  onCancel: () => void;
  onCreate: (profile: string) => void;
}) {
  const [profileName, setProfileName] = useState("");
  const normalizedName = profileName.trim();
  const validName = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalizedName);
  const exists = props.existingProfiles.some(
    (profile) => profile.name === normalizedName,
  );
  const canCreate = Boolean(normalizedName && validName && !exists);

  return (
    <div className="settings-confirm-modal" role="presentation">
      <div
        aria-labelledby="create-profile-heading"
        aria-modal="true"
        className="settings-confirm-dialog settings-profile-create-dialog"
        role="dialog"
      >
        <h2 id="create-profile-heading">Add PwrAgent profile</h2>
        <p>
          Create an isolated PwrAgent profile with its own config, state, and secrets.
        </p>
        <input
          aria-label="PwrAgent profile name"
          className="settings-input"
          placeholder="work"
          value={profileName}
          onChange={(event) => setProfileName(event.currentTarget.value)}
        />
        {!validName && normalizedName ? (
          <p className="settings-row__error">
            Use lowercase letters, numbers, dashes, or underscores.
          </p>
        ) : null}
        {exists ? (
          <p className="settings-row__error">That profile already exists.</p>
        ) : null}
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
            className="button button--primary"
            disabled={props.busy || !canCreate}
            type="button"
            onClick={() => props.onCreate(normalizedName)}
          >
            Add profile
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
