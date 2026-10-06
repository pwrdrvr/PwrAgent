import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";
import type {
  DesktopPwrAgentProfileSummary,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import {
  normalizeProfileName,
  profileMenuShortcutDigits,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatPrimaryAccel } from "../../lib/keyboard-accel";
import { tildifyPath } from "../../lib/tildify-path";
import { useModalDialog } from "../../lib/useModalDialog";
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
import { SettingsSwitch } from "./SettingsSwitch";
import { SettingsSplitPath } from "./SettingsSplitPath";

type ProfileDropTarget = {
  name: string;
  position: "before" | "after";
};

export function ProfilesSettings(props: {
  /** Profiles → New Profile…: open the create form once, then report it. */
  createRequested?: boolean;
  desktopApi?: DesktopApi;
  onCreateRequestHandled?: () => void;
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
  const [draggedProfile, setDraggedProfile] = useState<string>();
  const [dropTarget, setDropTarget] = useState<ProfileDropTarget>();
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  // A keyboard move re-renders the list in its new order. React keeps the
  // grip's node, but moving a focused node can drop its focus, so the moved
  // profile's grip takes focus back once the new order has rendered.
  const gripRefs = useRef(new Map<string, HTMLButtonElement>());
  const refocusGripRef = useRef<string | undefined>(undefined);

  const createRequested = props.createRequested;
  const onCreateRequestHandled = props.onCreateRequestHandled;
  useEffect(() => {
    if (!createRequested) return;
    setCreateOpen(true);
    onCreateRequestHandled?.();
  }, [createRequested, onCreateRequestHandled]);

  const profileList = profiles.profiles;
  useLayoutEffect(() => {
    const name = refocusGripRef.current;
    if (!name) return;
    // One render: the move's own. A later refresh must not pull focus back
    // from wherever the operator has gone since.
    refocusGripRef.current = undefined;
    const grip = gripRefs.current.get(name);
    if (grip && document.activeElement !== grip) {
      grip.focus();
    }
  }, [profileList]);

  const shortcutDigits = profileMenuShortcutDigits(profileList);

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

  const commitOrder = (order: string[], moved: string) => {
    const current = profileList.map((profile) => profile.name);
    if (order.every((name, index) => name === current[index])) {
      return;
    }
    const position = order.indexOf(moved) + 1;
    const movedProfile = profileList.find((profile) => profile.name === moved);
    setMoveAnnouncement(
      `${movedProfile?.displayName || moved} moved to position ${position} of ${order.length}.`,
    );
    void runProfileAction(moved, () => profiles.reorderProfiles(order));
  };

  const moveByKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    name: string,
  ) => {
    const offset =
      event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (offset === 0) return;
    event.preventDefault();
    const order = profileList.map((profile) => profile.name);
    const from = order.indexOf(name);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= order.length || busyProfile) return;
    order.splice(from, 1);
    order.splice(to, 0, name);
    refocusGripRef.current = name;
    commitOrder(order, name);
  };

  const dropPositionFor = (
    event: DragEvent<HTMLDivElement>,
  ): ProfileDropTarget["position"] => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
  };

  const finishDrag = () => {
    setDraggedProfile(undefined);
    setDropTarget(undefined);
  };

  const dropOn = (target: ProfileDropTarget) => {
    const dragged = draggedProfile;
    finishDrag();
    if (!dragged || dragged === target.name) return;
    const order = profileList
      .map((profile) => profile.name)
      .filter((name) => name !== dragged);
    const targetIndex = order.indexOf(target.name);
    if (targetIndex < 0) return;
    order.splice(
      target.position === "before" ? targetIndex : targetIndex + 1,
      0,
      dragged,
    );
    refocusGripRef.current = undefined;
    commitOrder(order, dragged);
  };

  const canReorder = profileList.length > 1;

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
        description={`Choose which profile opens when no environment profile is set, or open another profile in a new app instance. Drag a profile by its grip, or press ↑ or ↓ on the grip, to set the Profiles menu order; the first nine it shows get ${formatPrimaryAccel("1")} through ${formatPrimaryAccel("9")}. A Codex auth change applies the next time that profile launches.`}
        chip={
          profiles.activeProfile ? `active:${profiles.activeProfile}` : "profiles"
        }
        chipKind="ok"
      >
        {/*
          Only before the first list arrives. Every action refreshes the
          list, and swapping the cards for this line mid-refresh would take
          the grip a keyboard move is still holding focus on with it.
        */}
        {profiles.loading && !profileList.length ? (
          <p className="settings-empty">Loading profiles...</p>
        ) : profileList.length ? (
          <div className="settings-paths settings-profile-list">
            {profileList.map((profile) => (
              <PwrAgentProfileCard
                key={profile.name}
                busy={busyProfile === profile.name}
                dragging={draggedProfile === profile.name}
                dropPosition={
                  dropTarget?.name === profile.name
                  && draggedProfile !== profile.name
                    ? dropTarget.position
                    : undefined
                }
                grip={
                  canReorder ? (
                    <ProfileReorderGrip
                      buttonRef={(element) => {
                        if (element) {
                          gripRefs.current.set(profile.name, element);
                        } else {
                          gripRefs.current.delete(profile.name);
                        }
                      }}
                      name={profile.displayName || profile.name}
                      onDragEnd={finishDrag}
                      onDragStart={(event) => {
                        const card = event.currentTarget.closest(
                          ".settings-profile-card",
                        );
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", profile.name);
                        if (card instanceof HTMLElement) {
                          event.dataTransfer.setDragImage(card, 24, 20);
                        }
                        setDraggedProfile(profile.name);
                      }}
                      onKeyDown={(event) => moveByKeyboard(event, profile.name)}
                    />
                  ) : null
                }
                menuShortcut={(() => {
                  const digit = shortcutDigits.get(profile.name);
                  return digit === undefined
                    ? undefined
                    : formatPrimaryAccel(String(digit));
                })()}
                profile={profile}
                onDragLeave={(event) => {
                  const next = event.relatedTarget;
                  if (
                    next instanceof Node
                    && event.currentTarget.contains(next)
                  ) {
                    return;
                  }
                  setDropTarget((current) =>
                    current?.name === profile.name ? undefined : current,
                  );
                }}
                onDragOver={(event) => {
                  if (!draggedProfile) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const position = dropPositionFor(event);
                  setDropTarget((current) =>
                    current?.name === profile.name
                    && current.position === position
                      ? current
                      : { name: profile.name, position },
                  );
                }}
                onDrop={(event) => {
                  if (!draggedProfile) return;
                  event.preventDefault();
                  dropOn({ name: profile.name, position: dropPositionFor(event) });
                }}
                onShowInMenuChange={(showInMenu) => {
                  void runProfileAction(profile.name, () =>
                    profiles.setShowInMenu(profile.name, showInMenu),
                  );
                }}
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
        <p
          aria-live="polite"
          className="settings-profile-list__announcement"
          role="status"
        >
          {moveAnnouncement}
        </p>
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

function PwrAgentProfileCard(props: {
  busy: boolean;
  codexProfileControl: ReactNode;
  dragging: boolean;
  dropPosition?: ProfileDropTarget["position"];
  /** Absent when there is only one profile, so nothing to reorder. */
  grip: ReactNode;
  /** The Profiles menu shortcut, e.g. "⌘1"; absent when it has none. */
  menuShortcut?: string;
  profile: DesktopPwrAgentProfileSummary;
  onDelete: () => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onOpen: () => void;
  onShowInMenuChange: (showInMenu: boolean) => void;
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
      className={`settings-profile-card${profile.active ? " is-active" : ""}${
        props.dragging ? " is-dragging" : ""
      }${props.dropPosition ? ` is-drop-${props.dropPosition}` : ""}`}
      data-profile-name={profile.name}
      onDragLeave={props.onDragLeave}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      <div className="settings-profile-card__head">
        <div className="settings-profile-card__ident">
          {props.grip}
          <span className="settings-profile-card__name" title={displayName}>
            {displayName}
          </span>
          {/*
            A profile switched out of the menu has no shortcut, and its Off
            switch below says why.
          */}
          {props.menuShortcut ? (
            <span
              aria-label={`Profiles menu shortcut ${props.menuShortcut}`}
              className="settings-profile-card__shortcut"
              role="img"
            >
              {props.menuShortcut}
            </span>
          ) : null}
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
        <div className="settings-profile-card__actions">
          <button
            className="button button--secondary settings-profile-card__button"
            disabled={props.busy || profile.default}
            type="button"
            onClick={props.onUseDefault}
          >
            Use on startup
          </button>
          <button
            className="button button--secondary settings-profile-card__button"
            disabled={props.busy || !canOpen}
            type="button"
            onClick={props.onOpen}
          >
            Open
          </button>
          {/*
            Delete is the one irreversible action on this pane. It keeps a
            visible button — it is not worth hiding behind a menu — but sits
            past a wider gap so it is not a misclick neighbour of Open.
          */}
          <button
            className="button button--ghost settings-profile-card__button settings-danger-button settings-profile-card__button--apart"
            disabled={props.busy || !profile.canDelete}
            type="button"
            onClick={props.onDelete}
          >
            Delete
          </button>
        </div>
      </div>
      <p className="settings-profile-card__where">
        <SettingsSplitPath
          className="settings-profile-card__path"
          title={profile.profileDir}
          value={tildifyPath(profile.profileDir)}
        />
        <span aria-hidden="true" className="settings-profile-card__dot">
          ·
        </span>
        <span className="settings-profile-card__when">{lastUsed}</span>
      </p>
      <div className="settings-profile-card__codex">
        {/*
          Sighted-only: the select carries the full name ("Codex auth
          profile for <name>") on its own `aria-label`, so announcing this
          span too would read the same words twice, the first time as text
          with no owner.
        */}
        <span
          aria-hidden="true"
          className="settings-profile-card__codex-label"
        >
          Codex auth
        </span>
        {props.codexProfileControl}
        <span className="settings-profile-card__menu-toggle">
          <span aria-hidden="true">Show in Profiles menu</span>
          <SettingsSwitch
            checked={profile.showInMenu}
            disabled={props.busy}
            label={`Show ${displayName} in the Profiles menu`}
            onChange={props.onShowInMenuChange}
          />
        </span>
      </div>
    </div>
  );
}

function ProfileReorderGrip(props: {
  buttonRef: (element: HTMLButtonElement | null) => void;
  name: string;
  onDragEnd: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      ref={props.buttonRef}
      aria-label={`Move ${props.name}. Use the up and down arrow keys.`}
      className="settings-profile-card__grip tooltip-target"
      data-tooltip="Drag to reorder, or press ↑ or ↓ while this grip has focus"
      draggable
      type="button"
      onDragEnd={props.onDragEnd}
      onDragStart={props.onDragStart}
      onKeyDown={props.onKeyDown}
    >
      <svg aria-hidden="true" height="14" viewBox="0 0 8 14" width="8">
        <circle cx="2" cy="2" r="1.25" />
        <circle cx="6" cy="2" r="1.25" />
        <circle cx="2" cy="7" r="1.25" />
        <circle cx="6" cy="7" r="1.25" />
        <circle cx="2" cy="12" r="1.25" />
        <circle cx="6" cy="12" r="1.25" />
      </svg>
    </button>
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
  const dialogRef = useModalDialog({
    onClose: () => {
      if (!props.busy) props.onCancel();
    },
  });
  return (
    <div className="settings-confirm-modal" role="presentation">
      <div
        ref={dialogRef}
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
          homes are not deleted.
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
            className="button button--ghost settings-danger-button"
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
  const normalizedName = normalizeProfileName(profileName);
  const hasInput = profileName.trim().length > 0;
  const exists = props.existingProfiles.some(
    (profile) => profile.name === normalizedName,
  );
  const canCreate = Boolean(hasInput && normalizedName && !exists);
  const dialogRef = useModalDialog({
    onClose: () => {
      if (!props.busy) props.onCancel();
    },
  });

  return (
    <div className="settings-confirm-modal" role="presentation">
      <div
        ref={dialogRef}
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
        {hasInput && !normalizedName ? (
          <p className="settings-row__error">
            Enter at least one letter or number.
          </p>
        ) : null}
        {hasInput && normalizedName ? (
          <p className="settings-profile-create-dialog__hint">
            Profile ID: <code>{normalizedName}</code>
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
