import type {
  DesktopSettingsSnapshot,
  DesktopWorktreeStorageLocation,
} from "@pwragent/shared";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
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
      "Outside the repository under ~/.pwragent/worktrees/<hash>/<project-folder>.",
    label: "User home",
    value: "user-home",
  },
];

export function WorktreesSettings(props: {
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onStorageChange: (value: DesktopWorktreeStorageLocation) => Promise<void>;
}) {
  const storage = props.snapshot.worktrees.storage;
  const overridden = storage.source === "env";
  const activeOption = STORAGE_OPTIONS.find(
    (option) => option.value === storage.value,
  );

  return (
    <section className="settings-stack" aria-label="Worktree settings">
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
          <SettingsField
            label="Where should worktrees live?"
            sub="Pick a strategy that matches how you keep your projects on disk."
            help={
              overridden
                ? "Overridden by PWRAGENT_WORKTREE_STORAGE; clear the environment variable to edit this from settings."
                : activeOption?.description
            }
            error={storage.error}
            control={
              <div
                className="settings-segmented"
                role="radiogroup"
                aria-label="Worktree storage location"
              >
                {STORAGE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    aria-checked={storage.value === option.value}
                    className={`settings-segmented__button${
                      storage.value === option.value ? " is-active" : ""
                    }`}
                    disabled={props.saving || overridden}
                    role="radio"
                    type="button"
                    onClick={() => {
                      void props.onStorageChange(option.value);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            }
          />

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
    </section>
  );
}
