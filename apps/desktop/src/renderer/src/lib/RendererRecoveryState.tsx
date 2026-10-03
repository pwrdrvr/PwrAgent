import {
  createContext, useContext, useLayoutEffect, useMemo, useRef, useState,
  type Dispatch, type ReactNode, type SetStateAction,
} from "react";
import { useComposerDraftStore, type ComposerDraftStore } from "../features/composer/useComposerDraftStore";
import { useDurableComposerDraftStore } from "../features/composer/useDurableComposerDraftStore";
import { getDesktopApi, type DesktopApi } from "./desktop-api";

type RecoveryState = {
  composerDraftStore: ComposerDraftStore;
  values: Map<string, unknown>;
};

const RecoveryContext = createContext<RecoveryState | undefined>(undefined);

// Lives above the boundary, per window. No disk writes or cross-window draft
// sharing, and no retention beyond a page reload or renderer-process death.
export function RendererRecoveryStateProvider({ children, draftsEnabled = true }: {
  children: ReactNode;
  draftsEnabled?: boolean;
}) {
  const values = useRef(new Map<string, unknown>());
  const baseStore = useComposerDraftStore();
  const composerDraftStore = useDurableComposerDraftStore(baseStore, draftsEnabled ? getDesktopApi() : undefined);
  const retained = useMemo(() => ({ composerDraftStore, values: values.current }), [composerDraftStore]);
  return <RecoveryContext.Provider value={retained}>{children}</RecoveryContext.Provider>;
}

export function useRendererRecoveryState(): RecoveryState | undefined {
  return useContext(RecoveryContext);
}

export function useRecoverableComposerDraftStore(desktopApi?: DesktopApi): ComposerDraftStore {
  const retained = useRendererRecoveryState();
  // Standalone component tests/embedders keep their existing local lifetime.
  // The fallback must not hydrate/write a second store in a protected window.
  const localBaseStore = useComposerDraftStore();
  const localStore = useDurableComposerDraftStore(localBaseStore, retained ? undefined : desktopApi);
  return retained?.composerDraftStore ?? localStore;
}

export function useRecoverableState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const retained = useRendererRecoveryState();
  const [value, setValue] = useState<T>(() => {
    if (retained?.values.has(key)) return retained.values.get(key) as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  // Checkpoint only committed state, never a render that might be discarded.
  useLayoutEffect(() => {
    retained?.values.set(key, value);
  }, [key, retained, value]);
  return [value, setValue];
}
