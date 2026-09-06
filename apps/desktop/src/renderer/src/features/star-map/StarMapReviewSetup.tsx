import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  buildReviewBranchOptions,
  findPreferredReviewWorkspaceCwd,
  type AppServerReviewTarget,
  type NavigationDirectorySummary,
  type NavigationThreadSummary,
} from "@pwragent/shared";

type ReviewTargetChoice = AppServerReviewTarget["type"];
type ReviewDirectory = Pick<NavigationDirectorySummary, "key" | "path"> & {
  gitStatus?: Partial<NonNullable<NavigationDirectorySummary["gitStatus"]>>;
};

export type StarMapReviewRequest = {
  cwd?: string;
  target: AppServerReviewTarget;
};

type StarMapReviewSetupProps = {
  busy: boolean;
  directories: readonly ReviewDirectory[];
  error?: string;
  onCancel: () => void;
  onSubmit: (request: StarMapReviewRequest) => void;
  submitting: boolean;
  thread: NavigationThreadSummary;
};

type ReviewWorkspaceOption = {
  cwd: string;
  key: string;
  label: string;
};

const REVIEW_TARGET_OPTIONS: Array<{
  description: string;
  label: string;
  target: ReviewTargetChoice;
}> = [
  {
    target: "baseBranch",
    label: "Base branch",
    description: "Compare this branch with a base branch",
  },
  {
    target: "uncommittedChanges",
    label: "Current changes",
    description: "Review staged, unstaged, and untracked files",
  },
  {
    target: "commit",
    label: "Commit",
    description: "Review one commit by SHA",
  },
  {
    target: "custom",
    label: "Custom",
    description: "Review using custom instructions",
  },
];

function buildReviewWorkspaceOptions(
  thread: NavigationThreadSummary,
): ReviewWorkspaceOption[] {
  const options: ReviewWorkspaceOption[] = [];
  const seen = new Set<string>();
  for (const directory of thread.linkedDirectories) {
    const cwd = (directory.worktreePath ?? directory.path).trim();
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    options.push({
      cwd,
      key: `${directory.id}:${cwd}`,
      label: directory.label.trim() || cwd,
    });
  }
  return options;
}

function normalizeWorkspacePath(value?: string): string | undefined {
  const normalized = value?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || undefined;
}

function workspaceMatches(left?: string, right?: string): boolean {
  const normalizedLeft = normalizeWorkspacePath(left);
  const normalizedRight = normalizeWorkspacePath(right);
  return Boolean(
    normalizedLeft
    && normalizedRight
    && normalizedLeft === normalizedRight,
  );
}

function findReviewDirectory(
  directories: readonly ReviewDirectory[],
  thread: NavigationThreadSummary,
  workspaceCwd?: string,
): ReviewDirectory | undefined {
  const linkedDirectory = thread.linkedDirectories.find((directory) =>
    workspaceMatches(directory.worktreePath, workspaceCwd)
    || workspaceMatches(directory.path, workspaceCwd)
  );
  return directories.find((directory) =>
    workspaceMatches(directory.path, workspaceCwd)
    || workspaceMatches(directory.path, linkedDirectory?.path)
    || workspaceMatches(directory.path, linkedDirectory?.worktreePath)
    || workspaceMatches(
      directory.key.startsWith("directory:")
        ? directory.key.slice("directory:".length)
        : directory.key,
      workspaceCwd,
    )
  );
}

function buildReviewRequest(params: {
  branch: string;
  commit: string;
  customInstructions: string;
  target: ReviewTargetChoice;
  workspaceCwd?: string;
}): StarMapReviewRequest | undefined {
  const cwd = params.workspaceCwd?.trim() || undefined;
  if (params.target === "uncommittedChanges") {
    return {
      ...(cwd ? { cwd } : {}),
      target: { type: "uncommittedChanges" },
    };
  }
  if (params.target === "baseBranch") {
    const branch = params.branch.trim();
    return branch
      ? {
          ...(cwd ? { cwd } : {}),
          target: { type: "baseBranch", branch },
        }
      : undefined;
  }
  if (params.target === "commit") {
    const sha = params.commit.trim();
    return sha
      ? {
          ...(cwd ? { cwd } : {}),
          target: { type: "commit", sha, title: null },
        }
      : undefined;
  }
  const instructions = params.customInstructions.trim();
  return instructions
    ? {
        ...(cwd ? { cwd } : {}),
        target: { type: "custom", instructions },
      }
    : undefined;
}

export function StarMapReviewSetup(props: StarMapReviewSetupProps) {
  const { busy, onCancel, onSubmit, submitting } = props;
  const workspaceOptions = useMemo(
    () => buildReviewWorkspaceOptions(props.thread),
    [props.thread],
  );
  const preferredWorkspace = findPreferredReviewWorkspaceCwd(props.thread);
  const initialWorkspace =
    preferredWorkspace
    ?? (workspaceOptions.length === 1 ? workspaceOptions[0]?.cwd : undefined);
  const [workspaceCwd, setWorkspaceCwd] = useState(initialWorkspace);
  const selectedDirectory = useMemo(
    () => findReviewDirectory(props.directories, props.thread, workspaceCwd),
    [props.directories, props.thread, workspaceCwd],
  );
  const branchOptions = useMemo(
    () => buildReviewBranchOptions({ directory: selectedDirectory, thread: props.thread }),
    [props.thread, selectedDirectory],
  );
  const [target, setTarget] = useState<ReviewTargetChoice>("baseBranch");
  const [branch, setBranch] = useState(branchOptions[0] ?? "main");
  const [branchEdited, setBranchEdited] = useState(false);
  const [commit, setCommit] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");
  const targetRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dialogRef = useRef<HTMLElement | null>(null);
  const branchListId = useId();
  const commitListId = useId();

  useEffect(() => {
    // The compact editor also synchronizes editability when this mounts and
    // can reclaim focus during that transaction. Focus one frame later, as
    // the main review composer does, so keyboard commands land in the setup.
    const frame = requestAnimationFrame(() => {
      targetRefs.current[0]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!branchEdited && branchOptions[0]) {
      setBranch(branchOptions[0]);
    }
  }, [branchEdited, branchOptions]);

  const request = useMemo(
    () => buildReviewRequest({
      branch,
      commit,
      customInstructions,
      target,
      workspaceCwd,
    }),
    [branch, commit, customInstructions, target, workspaceCwd],
  );
  const workspaceSelectionRequired = workspaceOptions.length > 1;
  const canSubmit = Boolean(
    request
    && (!workspaceSelectionRequired || workspaceCwd)
    && !busy
    && !submitting,
  );

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (canSubmit && request) onSubmit(request);
  };

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      const dialog = dialogRef.current;
      const targetNode = event.target;
      if (!dialog || !(targetNode instanceof Node)) return;
      const ownerCard = dialog.closest(".star-map-chat-card");
      if (!ownerCard?.contains(targetNode)) return;

      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (
        event.key !== "Enter"
        || event.shiftKey
        || event.altKey
        || event.metaKey
        || event.ctrlKey
      ) {
        return;
      }

      const targetElement =
        targetNode instanceof HTMLElement ? targetNode : undefined;
      const insideDialog = dialog.contains(targetNode);
      const insideDisabledComposer = Boolean(
        targetElement?.closest(".compact-composer"),
      );
      if (!insideDialog && !insideDisabledComposer) return;
      if (
        targetElement?.closest("textarea, select")
        || targetElement?.closest("[data-review-dismiss]")
      ) {
        return;
      }

      const requestedTarget = targetElement
        ?.closest<HTMLElement>("[data-review-target]")
        ?.dataset.reviewTarget as ReviewTargetChoice | undefined;
      const nextRequest = requestedTarget
        ? buildReviewRequest({
            branch,
            commit,
            customInstructions,
            target: requestedTarget,
            workspaceCwd,
          })
        : request;
      if (
        !nextRequest
        || (workspaceSelectionRequired && !workspaceCwd)
        || busy
        || submitting
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onSubmit(nextRequest);
    };

    // Capture is intentional: the Star Map layer owns Escape at its root,
    // while the disabled editor can retain focus underneath this sibling.
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [
    branch,
    busy,
    commit,
    customInstructions,
    onCancel,
    onSubmit,
    request,
    submitting,
    workspaceCwd,
    workspaceSelectionRequired,
  ]);

  return (
    <section
      aria-label={`Start review for ${props.thread.title}`}
      className="star-map-review-setup"
      ref={dialogRef}
      role="dialog"
    >
      <header className="star-map-review-setup__header">
        <div>
          <span className="star-map-review-setup__eyebrow">Review target</span>
          <h2>Start review</h2>
        </div>
        <button
          aria-label="Close review setup"
          className="star-map-review-setup__close"
          data-review-dismiss
          disabled={props.submitting}
          onClick={props.onCancel}
          type="button"
        >
          ×
        </button>
      </header>

      <form className="star-map-review-setup__form" onSubmit={submit}>
        <div className="star-map-review-setup__content">
          {workspaceSelectionRequired ? (
            <label className="composer__review-field">
              <span>Project</span>
              <select
                aria-label="Review project"
                className="composer__review-input"
                value={workspaceCwd ?? ""}
                onChange={(event) => {
                  setWorkspaceCwd(event.target.value);
                  setBranchEdited(false);
                }}
              >
                <option disabled value="">Choose project</option>
                {workspaceOptions.map((option) => (
                  <option key={option.key} value={option.cwd}>
                    {option.label} — {option.cwd}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="composer__review-options">
            {REVIEW_TARGET_OPTIONS.map((option, index) => (
              <button
                aria-pressed={target === option.target}
                className={`composer__review-option${
                  target === option.target ? " is-active" : ""
                }`}
                data-review-target={option.target}
                key={option.target}
                onClick={() => setTarget(option.target)}
                ref={(node) => {
                  targetRefs.current[index] = node;
                }}
                type="button"
              >
                <span>{option.label}</span>
                <small>{option.description}</small>
              </button>
            ))}
          </div>

          {target === "baseBranch" ? (
            <label className="composer__review-field">
              <span>Base branch</span>
              <input
                aria-label="Base branch"
                className="composer__review-input"
                list={branchListId}
                onChange={(event) => {
                  setBranch(event.target.value);
                  setBranchEdited(true);
                }}
                value={branch}
              />
              <datalist id={branchListId}>
                {branchOptions.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </label>
          ) : null}

          {target === "commit" ? (
            <label className="composer__review-field">
              <span>Commit SHA</span>
              <input
                aria-label="Commit SHA"
                className="composer__review-input"
                list={commitListId}
                onChange={(event) => setCommit(event.target.value)}
                placeholder="abc1234"
                value={commit}
              />
              <datalist id={commitListId}>
                {(selectedDirectory?.gitStatus?.recentCommits ?? []).map(
                  (option) => (
                    <option key={option.sha} value={option.sha}>
                      {option.subject}
                    </option>
                  ),
                )}
              </datalist>
            </label>
          ) : null}

          {target === "custom" ? (
            <label className="composer__review-field">
              <span>Instructions</span>
              <textarea
                aria-label="Review instructions"
                className="composer__review-input composer__review-input--textarea"
                onChange={(event) => setCustomInstructions(event.target.value)}
                value={customInstructions}
              />
            </label>
          ) : null}

          {props.busy ? (
            <p className="star-map-review-setup__message" role="status">
              This review can start when the current turn finishes.
            </p>
          ) : null}
          {props.error ? (
            <p className="star-map-review-setup__error" role="alert">
              {props.error}
            </p>
          ) : null}
        </div>

        <footer className="star-map-review-setup__actions">
          <button
            className="composer__secondary-action"
            data-review-dismiss
            disabled={props.submitting}
            onClick={props.onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="composer__primary-action"
            disabled={!canSubmit}
            type="submit"
          >
            {props.submitting ? "Starting…" : "Start review"}
          </button>
        </footer>
      </form>
    </section>
  );
}
