import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { WorktreeReflinkTarget } from "@pwragent/shared/contracts/worktree-reflink";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatByteCount } from "../../lib/format-bytes";
import { useModalDialog } from "../../lib/useModalDialog";
import {
  INITIAL_WORKTREE_STORAGE_STATE,
  reduceWorktreeStorage,
  worktreeStorageRunRequest,
  type WorktreeStorageEvent,
  type WorktreeStorageOutcome,
  type WorktreeStorageRunMode,
  type WorktreeStorageState,
} from "./worktree-storage-session";

export type WorktreeStorageApi = Pick<
  DesktopApi,
  "onSettingsRuntimeChanged" | "readWorktreeReflinkCapabilities" | "runWorktreeReflink"
>;

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * One worktree's sharing session: the selected Git's capabilities, read
 * again whenever that Git may have changed, and the runs made against them.
 * State changes go through `reduceWorktreeStorage`, which drops late answers.
 */
export function useWorktreeStorageSession(
  api: WorktreeStorageApi | undefined,
  target: WorktreeReflinkTarget | undefined,
): {
  state: WorktreeStorageState;
  run: (mode: WorktreeStorageRunMode) => void;
  setVerifyFilters: (checked: boolean) => void;
} {
  const [state, setState] = useState(INITIAL_WORKTREE_STORAGE_STATE);
  const stateRef = useRef(state);
  const mountedRef = useRef(true);
  const targetKey = target ? `${target.backend ?? ""}\0${target.threadId}\0${target.worktreePath}` : "";
  const targetRef = useRef(target);
  targetRef.current = target;
  const apply = useCallback((event: WorktreeStorageEvent): WorktreeStorageState => {
    if (!mountedRef.current) return stateRef.current;
    const next = reduceWorktreeStorage(stateRef.current, event);
    stateRef.current = next;
    setState(next);
    return next;
  }, []);

  const readCapabilities = useCallback(() => {
    const read = api?.readWorktreeReflinkCapabilities;
    const current = targetRef.current;
    if (!read || !current) return;
    const request = apply({ type: "capabilities-requested" }).capabilityRequest;
    read(current).then(
      (response) => apply({ type: "capabilities-answered", request, response }),
      (error: unknown) => apply({ type: "capabilities-failed", request, reason: errorText(error) }),
    );
  }, [api, apply]);

  useEffect(() => {
    mountedRef.current = true;
    stateRef.current = INITIAL_WORKTREE_STORAGE_STATE;
    setState(INITIAL_WORKTREE_STORAGE_STATE);
    if (!targetKey) return undefined;
    readCapabilities();
    // Settings announces most runtime changes; a config file edited by hand,
    // or another window, is caught when this window is looked at again.
    const unsubscribe = api?.onSettingsRuntimeChanged?.(() => readCapabilities());
    window.addEventListener("focus", readCapabilities);
    return () => {
      mountedRef.current = false;
      unsubscribe?.();
      window.removeEventListener("focus", readCapabilities);
    };
  }, [api, readCapabilities, targetKey]);

  const run = useCallback((mode: WorktreeStorageRunMode) => {
    const execute = api?.runWorktreeReflink;
    const current = targetRef.current;
    if (!execute || !current) return;
    const request = worktreeStorageRunRequest(stateRef.current, current, mode);
    if (!request) return;
    const before = stateRef.current.runRequest;
    const started = apply({ type: "run-started", mode });
    if (started.runRequest === before) return;
    execute(request).then(
      (response) => apply({ type: "run-answered", request: started.runRequest, response }),
      (error: unknown) => apply({ type: "run-failed", request: started.runRequest, reason: errorText(error) }),
    );
  }, [api, apply]);

  const setVerifyFilters = useCallback((checked: boolean) => {
    apply({ type: "verify-filters-set", checked });
  }, [apply]);

  return { state, run, setVerifyFilters };
}

function files(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "file" : "files"}`;
}

function estimateText(outcome: WorktreeStorageOutcome): string {
  const { summary } = outcome;
  if (!outcome.supported) return "This volume cannot share file storage in place.";
  if (summary.eligible === 0) {
    return summary.alreadyShared > 0
      ? `Nothing more to share. ${summary.alreadyShared.toLocaleString()} of ${files(summary.scanned)} already share storage.`
      : `None of the ${files(summary.scanned)} can be shared.`;
  }
  return `${summary.eligible.toLocaleString()} of ${files(summary.scanned)} can be shared, freeing about ${
    formatByteCount(summary.potentialPrivateReduction)
  }.`;
}

function sharedText(outcome: WorktreeStorageOutcome): string {
  const { summary } = outcome;
  if (!outcome.supported) return "This volume cannot share file storage in place.";
  const freed = summary.reshared === 0
    ? "No files needed sharing."
    : `Shared ${files(summary.reshared)}, freeing ${formatByteCount(summary.observedPrivateReduction)}.`;
  return summary.failed > 0 ? `${freed} ${files(summary.failed)} could not be shared.` : freed;
}

type WorktreeStorageDialogProps = {
  api: WorktreeStorageApi;
  label: string;
  target: WorktreeReflinkTarget;
  /** Sharing replaces files, so it waits for a running turn to finish. */
  turnActive: boolean;
  onClose: () => void;
};

/**
 * Shares one worktree's storage with its source checkout through
 * `git worktree reflink`. Opening it estimates, which runs no filters.
 * Filter verification is offered only when the selected Git's help lists
 * `--verify-filters`, and is off until the operator ticks it.
 */
export function WorktreeStorageDialog(props: WorktreeStorageDialogProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const { state, run, setVerifyFilters } = useWorktreeStorageSession(props.api, props.target);
  const sharing = state.running === "share";
  const dialogRef = useModalDialog({
    initialFocus: closeRef,
    onClose: () => {
      if (!sharing) props.onClose();
    },
  });
  const capabilities = state.runtime?.capabilities;
  const runtimeKey = state.capabilities === "ready" && capabilities?.reflink
    ? state.runtime?.runtimeKey
    : undefined;
  // One estimate for each Git that can make one.
  const estimatedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!runtimeKey || estimatedFor.current === runtimeKey) return;
    estimatedFor.current = runtimeKey;
    run("estimate");
  }, [run, runtimeKey]);

  const status = state.capabilities === "loading"
    ? "Checking the selected Git..."
    : !capabilities?.reflink
      ? state.capabilities === "unavailable"
        ? undefined
        : "The selected Git cannot share worktree storage."
      : state.running === "estimate"
        ? "Estimating..."
        : sharing
          ? "Sharing storage..."
          : state.shared
            ? sharedText(state.shared)
            : state.estimate
              ? estimateText(state.estimate)
              : undefined;
  const skipped = (state.shared ?? state.estimate)?.summary.skipped ?? 0;
  const unsupported = (state.shared ?? state.estimate)?.supported === false;
  const canShare = Boolean(capabilities?.reflink) && !state.running && !state.shared
    && !unsupported && !props.turnActive;

  return (
    <div
      className="worktree-storage-modal"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !sharing) props.onClose();
      }}
    >
      <div
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-modal="true"
        className="worktree-storage-dialog"
        role="dialog"
      >
        <h2 id={titleId}>Share worktree storage</h2>
        <p>
          Files in <strong>{props.label}</strong> that match its source checkout
          byte for byte are replaced with copy-on-write clones, so they stop
          taking their own disk space. File contents do not change.
        </p>
        {status ? (
          <p aria-live="polite" className="worktree-storage-dialog__status">
            {status}
            {skipped > 0 && !state.running ? ` ${files(skipped)} skipped.` : null}
            {state.shared?.verifiedFilters ? " Filtered files were verified." : null}
          </p>
        ) : null}
        {capabilities?.reflink && capabilities.verifyFilters && !state.shared ? (
          <label className="composer__checkbox worktree-storage-dialog__option">
            <input
              checked={state.verifyFilters}
              disabled={Boolean(state.running)}
              type="checkbox"
              onChange={(event) => setVerifyFilters(event.currentTarget.checked)}
            />
            <span>
              Verify filtered files
              <small>
                Runs this repository's clean filters, such as Git LFS, on
                files Git cannot match by size and time alone. Off, those
                files are skipped.
              </small>
            </span>
          </label>
        ) : null}
        {state.runtimeChanged ? (
          <p className="worktree-storage-dialog__notice" role="status">
            The selected Git changed. Check the options before sharing.
          </p>
        ) : null}
        {props.turnActive && !state.shared ? (
          <p className="worktree-storage-dialog__notice">
            Sharing is available when the current turn finishes.
          </p>
        ) : null}
        {state.error ? (
          <p className="worktree-storage-dialog__error" role="alert">{state.error}</p>
        ) : null}
        <div className="worktree-storage-dialog__actions">
          <button ref={closeRef} disabled={sharing} type="button" onClick={props.onClose}>
            {state.shared ? "Done" : "Cancel"}
          </button>
          {state.shared ? null : (
            <button
              className="worktree-storage-dialog__confirm"
              disabled={!canShare}
              type="button"
              onClick={() => run("share")}
            >
              {sharing ? "Sharing..." : "Share storage"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
