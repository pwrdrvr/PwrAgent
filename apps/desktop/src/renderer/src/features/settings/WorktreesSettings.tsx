import type {
  DesktopSettingsSnapshot,
  DesktopWorktreeStorageLocation,
} from "@pwragnt/shared";
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
      "Outside the repository under ~/.pwragnt/worktrees/<hash>/<project-folder>.",
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
    <section className="settings-panel" aria-labelledby="settings-worktrees-title">
      <div className="settings-panel__header">
        <div>
          <p className="eyebrow">Worktrees</p>
          <h2 id="settings-worktrees-title">Storage location</h2>
        </div>
        <span className="settings-source">{sourceBadge(storage)}</span>
      </div>

      <div className="settings-field">
        <div
          className="settings-segmented settings-segmented--two"
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
      </div>

      {activeOption ? (
        <p className="settings-row__description">{activeOption.description}</p>
      ) : null}

      <div className="settings-row">
        <span className="settings-row__label">Effective path</span>
        <code className="settings-input" aria-readonly="true">
          {props.snapshot.worktrees.effectivePath}
        </code>
      </div>

      {overridden ? (
        <p className="settings-row__description">
          Overridden by PWRAGNT_WORKTREE_STORAGE; clear the environment
          variable to edit this from settings.
        </p>
      ) : null}

      {storage.error ? (
        <p className="settings-row__error">{storage.error}</p>
      ) : null}
    </section>
  );
}
