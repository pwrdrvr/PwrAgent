import { useEffect, useMemo, useState } from "react";
import type { EditGroupCommitState } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  editGroupFileSetSignature,
  editGroupPaths,
  type EditedFileGroup,
} from "./edited-file-groups";

/**
 * Per-group resolve input, cached by group identity. The collector keeps a
 * group's identity while its bucket is unchanged, so a streamed delta rebuilds
 * only the live turn's entry instead of every retained group's path list.
 */
const resolveInputByGroup = new WeakMap<
  EditedFileGroup,
  { key: string; paths: string[] }
>();

function toResolveInput(group: EditedFileGroup): {
  key: string;
  paths: string[];
} {
  const cached = resolveInputByGroup.get(group);
  if (cached) {
    return cached;
  }
  const input = { key: group.key, paths: editGroupPaths(group) };
  resolveInputByGroup.set(group, input);
  return input;
}

/**
 * Debounce window before resolving. A git-heavy turn pushes a fresh working
 * state after every commit; without this each push would spawn its own burst
 * of `git` probes in the main process. Coalesce a flurry into one resolve.
 */
const RESOLVE_DEBOUNCE_MS = 300;

/**
 * Resolve current Git file state for edited-file groups against the live
 * worktree, via the main process. Re-resolves (debounced) when the group set
 * changes or the worktree's working state shifts (`refreshKey` — pass a
 * signature of the thread's `gitWorkingState` so status badges can update).
 * Pass an empty `groups` array when the edits surface isn't shown to skip
 * resolution entirely. Returns an empty map until the first resolution lands.
 */
export function useEditCommitStates(params: {
  desktopApi?: Pick<DesktopApi, "resolveEditCommitStates">;
  worktreePath?: string;
  groups: readonly EditedFileGroup[];
  refreshKey?: string;
}): Record<string, EditGroupCommitState> {
  const { desktopApi, worktreePath, groups, refreshKey } = params;
  const [states, setStates] = useState<Record<string, EditGroupCommitState>>(
    {},
  );

  // A stable signature of the {key → paths} inputs so we only re-resolve when
  // the actual groups/files change, not on every transcript re-render. Each
  // group carries its own file-set signature, maintained as the group is
  // built, so this stays O(groups) per render — serializing the whole set here
  // would run on every streamed delta, since a live turn hands us a new array
  // each time.
  const groupsInput = useMemo(() => groups.map(toResolveInput), [groups]);
  const groupsSignature = useMemo(
    () => groups.map(editGroupFileSetSignature).join("\u0001"),
    [groups],
  );

  useEffect(() => {
    const resolve = desktopApi?.resolveEditCommitStates;
    const normalizedWorktree = worktreePath?.trim();
    if (!resolve || !normalizedWorktree || groupsInput.length === 0) {
      setStates({});
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void resolve({ worktreePath: normalizedWorktree, groups: groupsInput })
        .then((response) => {
          if (!cancelled) {
            setStates(response.states);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setStates({});
          }
        });
    }, RESOLVE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // groupsSignature stands in for groupsInput (deep value), refreshKey for
    // the worktree's working state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopApi?.resolveEditCommitStates, worktreePath, groupsSignature, refreshKey]);

  return states;
}
