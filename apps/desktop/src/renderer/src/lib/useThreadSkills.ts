import { useCallback, useMemo, useRef, useState } from "react";
import type {
  AppServerListSkillsResponse,
  AppServerSkillSummary,
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
} from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";
import type { DesktopApi } from "./desktop-api";

type SkillState = {
  error?: string;
  loading: boolean;
  response?: AppServerListSkillsResponse;
};

function createEmptySkillState(): SkillState {
  return { loading: false };
}

export function useThreadSkills(params: {
  desktopApi?: DesktopApi;
  launchpad?: NavigationLaunchpadDraft;
  thread?: NavigationThreadSummary;
}): {
  ensureLoaded: () => Promise<void>;
  error?: string;
  loading: boolean;
  response?: AppServerListSkillsResponse;
  skills: AppServerSkillSummary[];
} {
  const { desktopApi, thread } = params;
  const requestVersionsRef = useRef<Record<string, number>>({});
  const [stateByThreadKey, setStateByThreadKey] = useState<Record<string, SkillState>>({});
  const threadKey =
    thread && thread.source === "codex"
      ? buildThreadIdentityKey(thread.source, thread.id)
      : undefined;
  const state = threadKey ? stateByThreadKey[threadKey] : undefined;

  const ensureLoaded = useCallback(async (): Promise<void> => {
    if (!thread || thread.source !== "codex" || !threadKey) {
      return;
    }

    if (!desktopApi?.listSkills) {
      setStateByThreadKey((current) => ({
        ...current,
        [threadKey]: {
          error: "Desktop bridge is missing listSkills().",
          loading: false,
          response: undefined,
        },
      }));
      return;
    }

    const currentState = stateByThreadKey[threadKey];
    if (currentState?.loading || currentState?.response) {
      return;
    }

    const requestVersion = (requestVersionsRef.current[threadKey] ?? 0) + 1;
    requestVersionsRef.current[threadKey] = requestVersion;
    const cwds = [
      ...new Set(
        thread.linkedDirectories
          .map((directory) => directory.worktreePath ?? directory.path)
          .filter(Boolean)
      ),
    ];

    setStateByThreadKey((current) => ({
      ...current,
      [threadKey]: {
        ...createEmptySkillState(),
        loading: true,
      },
    }));

    try {
      const response = await desktopApi.listSkills({
        backend: thread.source,
        cwd: cwds.length === 1 ? cwds[0] : undefined,
        cwds: cwds.length > 0 ? cwds : undefined,
      });

      if (requestVersionsRef.current[threadKey] !== requestVersion) {
        return;
      }

      setStateByThreadKey((current) => ({
        ...current,
        [threadKey]: {
          error: undefined,
          loading: false,
          response,
        },
      }));
    } catch (error) {
      if (requestVersionsRef.current[threadKey] !== requestVersion) {
        return;
      }

      setStateByThreadKey((current) => ({
        ...current,
        [threadKey]: {
          error: error instanceof Error ? error.message : String(error),
          loading: false,
          response: undefined,
        },
      }));
    }
  }, [desktopApi, stateByThreadKey, thread, threadKey]);

  const skills = useMemo(() => {
    const deduped = new Map<string, AppServerSkillSummary>();

    for (const entry of state?.response?.data ?? []) {
      for (const skill of entry.skills) {
        const key = skill.path ?? `${entry.cwd ?? "global"}:${skill.name}`;
        deduped.set(key, skill);
      }
    }

    return [...deduped.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  }, [state?.response?.data]);

  return {
    ensureLoaded,
    error: state?.error,
    loading: state?.loading ?? false,
    response: state?.response,
    skills,
  };
}
