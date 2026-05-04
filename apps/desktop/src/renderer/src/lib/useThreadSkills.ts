import { useCallback, useMemo, useRef, useState } from "react";
import type {
  AppServerListSkillsResponse,
  AppServerSkillSummary,
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
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
  const { desktopApi, launchpad, thread } = params;
  const requestVersionsRef = useRef<Record<string, number>>({});
  const [stateByThreadKey, setStateByThreadKey] = useState<Record<string, SkillState>>({});
  const skillTarget = useMemo(() => {
    if (thread && thread.source === "codex") {
      const cwds = [
        ...new Set(
          thread.linkedDirectories
            .map((directory) => directory.worktreePath ?? directory.path)
            .filter(Boolean)
        ),
      ];

      return {
        backend: thread.source,
        cwds,
        key: buildThreadIdentityKey(thread.source, thread.id),
      };
    }

    if (launchpad?.backend === "codex") {
      const cwds = launchpad.directoryPath?.trim() ? [launchpad.directoryPath.trim()] : [];
      return {
        backend: launchpad.backend,
        cwds,
        key: `launchpad:${launchpad.backend}:${launchpad.directoryKey}`,
      };
    }

    return undefined;
  }, [launchpad, thread]);
  const state = skillTarget ? stateByThreadKey[skillTarget.key] : undefined;

  const ensureLoaded = useCallback(async (): Promise<void> => {
    if (!skillTarget) {
      return;
    }

    if (!desktopApi?.listSkills) {
      setStateByThreadKey((current) => ({
        ...current,
        [skillTarget.key]: {
          error: "Desktop bridge is missing listSkills().",
          loading: false,
          response: undefined,
        },
      }));
      return;
    }

    const currentState = stateByThreadKey[skillTarget.key];
    if (currentState?.loading || currentState?.response) {
      return;
    }

    const requestVersion = (requestVersionsRef.current[skillTarget.key] ?? 0) + 1;
    requestVersionsRef.current[skillTarget.key] = requestVersion;
    const cwds = skillTarget.cwds;

    setStateByThreadKey((current) => ({
      ...current,
      [skillTarget.key]: {
        ...createEmptySkillState(),
        loading: true,
      },
    }));

    try {
      const response = await desktopApi.listSkills({
        backend: skillTarget.backend,
        cwd: cwds.length === 1 ? cwds[0] : undefined,
        cwds: cwds.length > 0 ? cwds : undefined,
      });

      if (requestVersionsRef.current[skillTarget.key] !== requestVersion) {
        return;
      }

      setStateByThreadKey((current) => ({
        ...current,
        [skillTarget.key]: {
          error: undefined,
          loading: false,
          response,
        },
      }));
    } catch (error) {
      if (requestVersionsRef.current[skillTarget.key] !== requestVersion) {
        return;
      }

      setStateByThreadKey((current) => ({
        ...current,
        [skillTarget.key]: {
          error: error instanceof Error ? error.message : String(error),
          loading: false,
          response: undefined,
        },
      }));
    }
  }, [desktopApi, skillTarget, stateByThreadKey]);

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
