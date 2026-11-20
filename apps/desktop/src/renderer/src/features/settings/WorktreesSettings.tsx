import { useEffect, useState } from "react";
import type {
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
  DesktopWorktreeFolderCheck,
  DesktopWorktreeFolderStatus,
  DesktopWorktreeStorageLocation,
} from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../lib/desktop-api";
import { CheckoutHibernationSettings } from "./CheckoutHibernationSettings";
import {
  SegmentedField,
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
  ToggleField,
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
              disabled={props.saving}
              desktopApi={props.desktopApi}
              onWriteConfig={props.onWriteConfig}
            />
          ) : null}

          {storage.value === "user-home" && props.snapshot.worktrees.baseDirectory ? (
            <ToggleField
              label="Use for Codex threads too"
              sub="Codex threads' worktrees go to .codex/worktrees in this folder. Codex Desktop lists only worktrees in its own folder, so it won't show these."
              checked={props.snapshot.worktrees.baseDirectoryIncludesCodex === true}
              disabled={props.saving || !props.onWriteConfig}
              onChange={async (baseDirectoryIncludesCodex) => {
                await props.onWriteConfig?.({ worktrees: { baseDirectoryIncludesCodex } });
              }}
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

/**
 * The folder's availability, asked of the main process when the pane shows a
 * folder and again whenever the window regains focus (after plugging in a
 * drive). `checking` until the answer for this folder arrives.
 */
function useWorktreeFolderStatus(
  baseDirectory: string | undefined,
  check: (() => Promise<DesktopWorktreeFolderCheck>) | undefined,
): DesktopWorktreeFolderStatus | "checking" | undefined {
  const [result, setResult] = useState<DesktopWorktreeFolderCheck>();
  useEffect(() => {
    if (!baseDirectory || !check) return;
    let current = true;
    const run = () => {
      void check().then(
        (checked) => {
          if (current) setResult(checked);
        },
        () => {
          // No answer: show no chip rather than a guess.
          if (current) setResult({ directory: baseDirectory });
        },
      );
    };
    run();
    window.addEventListener("focus", run);
    return () => {
      current = false;
      window.removeEventListener("focus", run);
    };
  }, [baseDirectory, check]);
  if (!baseDirectory || !check) return undefined;
  return result?.directory === baseDirectory ? result.status : "checking";
}

const FOLDER_STATUS_CHIPS: Record<DesktopWorktreeFolderStatus | "checking", { label: string; modifier?: string }> = {
  checking: { label: "Checking…" },
  available: { label: "Available", modifier: "ok" },
  missing: { label: "Not available", modifier: "err" },
  "not-responding": { label: "Not responding", modifier: "err" },
};

function folderStatusError(baseDirectory: string, status: DesktopWorktreeFolderStatus | "checking" | undefined) {
  if (status === "missing") {
    return `${baseDirectory} is not available. Connect the drive or choose another folder; new worktrees cannot be created until then.`;
  }
  if (status === "not-responding") {
    return `${baseDirectory} is not responding. Check the drive or network share, or choose another folder.`;
  }
  return undefined;
}

function WorktreeFolderField(props: {
  baseDirectory?: string;
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
    const saved = await write({ worktrees: { baseDirectory } }).catch(() => false);
    if (!saved) setError("The worktree folder could not be saved. Try again.");
  };
  const choose = async () => {
    try {
      const picked = await pick?.();
      if (picked && !picked.canceled) await save(picked.path);
    } catch {
      setError("The folder picker could not open. Try again.");
    }
  };
  const status = useWorktreeFolderStatus(props.baseDirectory, props.desktopApi?.checkWorktreeFolder);
  const chip = status ? FOLDER_STATUS_CHIPS[status] : undefined;

  return (
    <SettingsField
      label="Worktree folder"
      sub="Put worktrees on a drive with more room. Existing worktrees stay where they are."
      error={error ?? (props.baseDirectory ? folderStatusError(props.baseDirectory, status) : undefined)}
      control={
        <div className="worktree-folder__row">
          <input
            aria-label="Worktree folder"
            className="settings-input settings-input--readonly"
            readOnly
            value={props.baseDirectory ?? "Home folder"}
          />
          {chip ? (
            <span
              className={`settings-pathrow__chip${chip.modifier ? ` settings-pathrow__chip--${chip.modifier}` : ""}`}
            >
              {chip.label}
            </span>
          ) : null}
          <button
            type="button"
            className="button button--secondary"
            disabled={props.disabled || !pick || !write}
            onClick={() => void choose()}
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
