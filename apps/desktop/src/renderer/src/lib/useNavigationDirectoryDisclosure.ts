import { useMemo, useRef, useState, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { NavigationResumeState } from "@pwragent/shared";
import { navigationThreadSelectionKey } from "./navigation-query-state";

/** Window-owned disclosure survives lens unmounts and determines explicit directory demand. */
export type NavigationDirectoryDisclosure = {
  previousSelectedItemKeyRef: RefObject<string | undefined>;
  handledRevealRequestRef: RefObject<number>;
  expandedByKey: Record<string, boolean>;
  unpinnedExpandedByKey: Record<string, boolean>;
  setExpandedByKey: Dispatch<SetStateAction<Record<string, boolean>>>;
  setUnpinnedExpandedByKey: Dispatch<SetStateAction<Record<string, boolean>>>;
};

export function useNavigationDirectoryDisclosure(resume?: NavigationResumeState): NavigationDirectoryDisclosure {
  const previousSelectedItemKeyRef = useRef<string | undefined>(resume?.selection ? navigationThreadSelectionKey(resume.selection) : undefined);
  const handledRevealRequestRef = useRef(0);
  const [expandedByKey, setExpandedByKey] = useState<Record<string, boolean>>(() => resume?.expandedByKey ?? {});
  const [unpinnedExpandedByKey, setUnpinnedExpandedByKey] = useState<Record<string, boolean>>(() => resume?.unpinnedExpandedByKey ?? {});
  return useMemo(() => ({
    expandedByKey, unpinnedExpandedByKey, setExpandedByKey, setUnpinnedExpandedByKey, previousSelectedItemKeyRef, handledRevealRequestRef,
  }), [expandedByKey, unpinnedExpandedByKey]);
}
