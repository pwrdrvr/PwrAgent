import { useEffect, useMemo, useState } from "react";
import type { EditGroupCommitState } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { editGroupPaths, type EditedFileGroup } from "./edited-file-groups";

/**
 * Resolve the git commit lifecycle (uncommitted → committed → pushed/local)
 * of a thread's edited-file groups against the live worktree, via the main
 * process. Re-resolves when the group set changes or the worktree's working
 * state shifts (`refreshKey` — pass a signature of the thread's
 * `gitWorkingState` so a commit/push flips the badges). Returns an empty map
 * until the first resolution lands; groups simply render unbadged until then.
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
  // the actual groups/files change, not on every transcript re-render.
  const groupsInput = useMemo(
    () => groups.map((group) => ({ key: group.key, paths: editGroupPaths(group) })),
    [groups],
  );
  const groupsSignature = useMemo(
    () => JSON.stringify(groupsInput),
    [groupsInput],
  );

  useEffect(() => {
    const resolve = desktopApi?.resolveEditCommitStates;
    const normalizedWorktree = worktreePath?.trim();
    if (!resolve || !normalizedWorktree || groupsInput.length === 0) {
      setStates({});
      return;
    }

    let cancelled = false;
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

    return () => {
      cancelled = true;
    };
    // groupsSignature stands in for groupsInput (deep value), refreshKey for
    // the worktree's working state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopApi?.resolveEditCommitStates, worktreePath, groupsSignature, refreshKey]);

  return states;
}
