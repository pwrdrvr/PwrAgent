import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerAvailableCommandSummary,
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
  providerCommands: AppServerAvailableCommandSummary[];
  response?: AppServerListSkillsResponse;
  skills: AppServerSkillSummary[];
} {
  const { desktopApi, launchpad, thread } = params;
  const requestVersionsRef = useRef<Record<string, number>>({});
  const [stateByThreadKey, setStateByThreadKey] = useState<Record<string, SkillState>>({});
  const skillTarget = useMemo(() => {
    if (thread) {
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
        threadId: thread.id,
      };
    }

    if (launchpad?.backend === "codex") {
      const cwds = launchpad.directoryPath?.trim() ? [launchpad.directoryPath.trim()] : [];
      return {
        backend: launchpad.backend,
        cwds,
        key: `launchpad:${launchpad.backend}:${launchpad.directoryKey}`,
        threadId: undefined,
      };
    }

    return undefined;
  }, [launchpad, thread]);
  const state = skillTarget ? stateByThreadKey[skillTarget.key] : undefined;

  useEffect(() => {
    if (!desktopApi?.onAgentEvent || !skillTarget?.threadId) {
      return;
    }

    const { backend, key, threadId } = skillTarget;
    return desktopApi.onAgentEvent((event) => {
      if (
        event.backend !== backend ||
        event.notification.method !== "thread/availableCommands/updated" ||
        event.notification.params.threadId !== threadId
      ) {
        return;
      }

      const commands = Array.isArray(
        (event.notification.params as { commands?: unknown }).commands,
      )
        ? ((event.notification.params as {
            commands: AppServerAvailableCommandSummary[];
          }).commands)
        : [];
      requestVersionsRef.current[key] =
        (requestVersionsRef.current[key] ?? 0) + 1;
      setStateByThreadKey((current) => ({
        ...current,
        [key]: {
          error: undefined,
          loading: false,
          response: {
            backend,
            fetchedAt: Date.now(),
            data: [
              {
                commands,
                skills: [],
              },
            ],
          },
        },
      }));
    });
  }, [desktopApi, skillTarget]);

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
        ...(cwds.length === 1 ? { cwd: cwds[0] } : {}),
        ...(cwds.length > 0 ? { cwds } : {}),
        ...(skillTarget.threadId ? { threadId: skillTarget.threadId } : {}),
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

  const providerCommands = useMemo(() => {
    const deduped = new Map<string, AppServerAvailableCommandSummary>();

    for (const entry of state?.response?.data ?? []) {
      for (const command of entry.commands ?? []) {
        deduped.set(
          `${command.backend ?? skillTarget?.backend ?? "unknown"}:${command.name}`,
          command,
        );
      }
    }

    return [...deduped.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  }, [skillTarget?.backend, state?.response?.data]);

  return {
    ensureLoaded,
    error: state?.error,
    loading: state?.loading ?? false,
    providerCommands,
    response: state?.response,
    skills,
  };
}
