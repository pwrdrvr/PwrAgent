import { useState } from "react";
import type {
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
  DesktopWorktreeStorageLocation,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { CheckoutHibernationSettings } from "./CheckoutHibernationSettings";
import {
  SegmentedField,
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import { sourceBadge } from "./settings-fields";

const STORAGE_OPTIONS: Array<{
  description: string;
  label: string;
  value: DesktopWorktreeStorageLocation;
}> = [
  {
    description:
      "Inside each repository at .worktrees/<hash>/<project-folder>.",
    label: "In repository",
    value: "in-repo",
  },
  {
    description:
      "Outside the repository, in .pwragent/worktrees/<hash>/<project-folder> under the worktree folder.",
    label: "User home",
    value: "user-home",
  },
];

export function WorktreesSettings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onStorageChange: (value: DesktopWorktreeStorageLocation) => Promise<void>;
  onWriteConfig?: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
  desktopApi?: DesktopApi;
}) {
  const storage = props.snapshot.worktrees.storage;
  const overridden = storage.source === "env";
  const activeOption = STORAGE_OPTIONS.find(
    (option) => option.value === storage.value,
  );

  return (
    <SettingsSectionStack paneId="worktrees" aria-label="Worktree settings">
      <SettingsPanelHead
        eyebrow="Worktrees"
        title="Storage & cleanup"
        help="PwrAgent creates a fresh git worktree for every thread so concurrent agents don't collide on your working tree. Pick where those worktrees live."
      />

      <SettingsSection
        eyebrow="Worktrees"
        title="Storage location"
        chip={sourceBadge(storage)}
        chipKind={overridden ? "warn" : "default"}
      >
        <div className="settings-fields">
          <SegmentedField
            label="Where should worktrees live?"
            sub="Pick a strategy that matches how you keep your projects on disk."
            help={
              overridden
                ? "Overridden by PWRAGENT_WORKTREE_STORAGE; clear the environment variable to edit this from settings."
                : activeOption?.description
            }
            error={storage.error}
            disabled={props.saving || overridden}
            options={STORAGE_OPTIONS}
            value={storage.value}
            onChange={(value) => {
              return props.onStorageChange(value);
            }}
          />

          {storage.value === "user-home" ? (
            <WorktreeFolderField
              baseDirectory={props.snapshot.worktrees.baseDirectory}
              available={props.snapshot.worktrees.baseDirectoryAvailable}
              disabled={props.saving}
              desktopApi={props.desktopApi}
              onWriteConfig={props.onWriteConfig}
            />
          ) : null}

          <SettingsField
            label="Effective path"
            sub="Computed from your strategy and the active project."
            control={
              <code
                aria-readonly="true"
                className="settings-input settings-input--readonly"
              >
                {props.snapshot.worktrees.effectivePath}
              </code>
            }
          />
        </div>
      </SettingsSection>

      <CheckoutHibernationSettings
        value={props.snapshot.worktrees.hibernate}
        onWriteConfig={props.onWriteConfig}
        desktopApi={props.desktopApi}
      />
    </SettingsSectionStack>
  );
}

function WorktreeFolderField(props: {
  baseDirectory?: string;
  available?: boolean;
  disabled: boolean;
  desktopApi?: DesktopApi;
  onWriteConfig?: (patch: DesktopSettingsConfigPatch) => Promise<boolean>;
}) {
  const [error, setError] = useState<string>();
  const pick = props.desktopApi?.pickDirectoryFromDisk;
  const write = props.onWriteConfig;
  const save = async (baseDirectory: string | null) => {
    if (!write) return;
    setError(undefined);
    if (!await write({ worktrees: { baseDirectory } })) {
      setError("The worktree folder could not be saved. Try again.");
    }
  };
  const unavailable = props.baseDirectory !== undefined && props.available === false;

  return (
    <SettingsField
      label="Worktree folder"
      sub="Put worktrees on a drive with more room. Existing worktrees stay where they are."
      help="Codex threads keep using Codex's own worktree folder."
      error={error ?? (unavailable
        ? `${props.baseDirectory} is not available. Connect the drive or choose another folder; new worktrees cannot be created until then.`
        : undefined)}
      control={
        <div className="worktree-folder__row">
          <code
            aria-label="Worktree folder"
            aria-readonly="true"
            className="settings-input settings-input--readonly"
          >
            {props.baseDirectory ?? "Home folder"}
          </code>
          {props.baseDirectory ? (
            <span
              className={`settings-pathrow__chip ${unavailable ? "settings-pathrow__chip--err" : "settings-pathrow__chip--ok"}`}
            >
              {unavailable ? "Not available" : "Available"}
            </span>
          ) : null}
          <button
            type="button"
            className="button button--secondary"
            disabled={props.disabled || !pick || !write}
            onClick={() => {
              void (async () => {
                const picked = await pick?.();
                if (picked && !picked.canceled) await save(picked.path);
              })();
            }}
          >
            Choose…
          </button>
          {props.baseDirectory ? (
            <button
              type="button"
              className="button button--ghost"
              disabled={props.disabled || !write}
              onClick={() => void save(null)}
            >
              Use home folder
            </button>
          ) : null}
        </div>
      }
    />
  );
}
