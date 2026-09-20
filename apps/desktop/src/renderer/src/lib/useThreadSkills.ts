import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  compareSkillOrigins,
  withSkillOrigins,
  type AppServerAvailableCommandSummary,
  type AppServerListSkillsResponse,
  type AppServerSkillSummary,
  type NavigationLaunchpadDraft,
  type NavigationThreadSummary,
  type SkillOriginDirectory,
} from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import {
  agentEventMatchesThread,
  federationTargetsEqual,
  threadSummaryIdentityKey,
} from "./federated-thread-events";

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
  const stateByThreadKeyRef = useRef<Record<string, SkillState>>({});
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
        federationTarget: thread.federation?.ref.target,
        key: threadSummaryIdentityKey(thread),
        threadId: thread.id,
      };
    }

    // Every backend, not just Codex: an ACP agent's slash commands are served
    // from the repo's last-observed list (see the registry's ACP branch of
    // `listSkills`), so a draft that has never been launched still populates
    // the `/` menu instead of falling back to PwrAgent's own commands alone.
    if (launchpad) {
      const cwds = launchpad.directoryPath?.trim() ? [launchpad.directoryPath.trim()] : [];
      const targetKey = launchpad.federationTarget?.scope === "remote"
        ? `${launchpad.federationTarget.instanceId}:`
        : "";
      return {
        backend: launchpad.backend,
        cwds,
        federationTarget: launchpad.federationTarget,
        key: `launchpad:${launchpad.backend}:${targetKey}${launchpad.directoryKey}`,
        threadId: undefined,
      };
    }

    return undefined;
  }, [launchpad, thread]);
  const state = skillTarget ? stateByThreadKey[skillTarget.key] : undefined;

  useEffect(() => {
    stateByThreadKeyRef.current = stateByThreadKey;
  }, [stateByThreadKey]);

  // Writes the ref and the React state together. The in-flight guard below is
  // read synchronously, and the composer fires `ensureLoaded` once per
  // keystroke after `/` — leaving the ref to catch up in an effect let a burst
  // of keystrokes issue one request each.
  const commitState = useCallback(
    (
      updater: (
        current: Record<string, SkillState>,
      ) => Record<string, SkillState>,
    ): void => {
      const next = updater(stateByThreadKeyRef.current);
      stateByThreadKeyRef.current = next;
      setStateByThreadKey(next);
    },
    [],
  );

  const loadTarget = useCallback(
    async (options: { force?: boolean } = {}): Promise<void> => {
      if (!skillTarget) {
        return;
      }

      if (!desktopApi?.listSkills) {
        commitState((current) => ({
          ...current,
          [skillTarget.key]: {
            error: "Desktop bridge is missing listSkills().",
            loading: false,
            response: undefined,
          },
        }));
        return;
      }

      const currentState = stateByThreadKeyRef.current[skillTarget.key];
      if (!options.force && (currentState?.loading || currentState?.response)) {
        return;
      }

      const requestVersion =
        (requestVersionsRef.current[skillTarget.key] ?? 0) + 1;
      requestVersionsRef.current[skillTarget.key] = requestVersion;
      const cwds = skillTarget.cwds;

      commitState((current) => ({
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
          ...(skillTarget.federationTarget
            ? { federationTarget: skillTarget.federationTarget }
            : {}),
          ...(skillTarget.threadId ? { threadId: skillTarget.threadId } : {}),
        });

        if (requestVersionsRef.current[skillTarget.key] !== requestVersion) {
          return;
        }

        commitState((current) => ({
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

        commitState((current) => ({
          ...current,
          [skillTarget.key]: {
            error: error instanceof Error ? error.message : String(error),
            loading: false,
            response: undefined,
          },
        }));
      }
    },
    [commitState, desktopApi, skillTarget],
  );

  useEffect(() => {
    if (!desktopApi?.onAgentEvent || !skillTarget) {
      return;
    }

    const { backend, federationTarget, key, threadId } = skillTarget;
    return desktopApi.onAgentEvent((event) => {
      if (event.backend !== backend) {
        return;
      }
      if (!federationTargetsEqual(event.federationTarget, federationTarget)) {
        return;
      }

      if (event.notification.method === "skills/changed") {
        const currentState = stateByThreadKeyRef.current[key];
        if (!currentState?.loading && !currentState?.response) {
          return;
        }
        const staleKeyPrefixes = [`${backend}:`, `launchpad:${backend}:`];
        const retainedEntries: Array<[string, SkillState]> = [];

        for (const [cachedKey, cachedState] of Object.entries(
          stateByThreadKeyRef.current,
        )) {
          if (staleKeyPrefixes.some((prefix) => cachedKey.startsWith(prefix))) {
            requestVersionsRef.current[cachedKey] =
              (requestVersionsRef.current[cachedKey] ?? 0) + 1;
            continue;
          }
          retainedEntries.push([cachedKey, cachedState]);
        }
        const next = Object.fromEntries(retainedEntries);
        stateByThreadKeyRef.current = next;
        setStateByThreadKey(next);

        void loadTarget({ force: true });
        return;
      }

      if (
        !thread ||
        !threadId ||
        event.notification.method !== "thread/availableCommands/updated" ||
        !agentEventMatchesThread(event, thread, event.notification.params.threadId)
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
      commitState((current) => ({
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
  }, [commitState, desktopApi, loadTarget, skillTarget, thread]);

  const ensureLoaded = useCallback(async (): Promise<void> => {
    await loadTarget();
  }, [loadTarget]);

  // Keyed on the directories' content, not the thread's identity: the summary
  // is replaced on every streamed item, and `skills` feeds memoized transcript
  // and composer consumers that should not rebuild for a turn's progress.
  const currentOriginDirectories = readSkillOriginDirectories(thread, launchpad);
  const originDirectoriesKey = currentOriginDirectories
    .map((directory) => [
      directory.label,
      directory.path,
      directory.worktreePath ?? "",
    ].join("\u0000"))
    .join("\u001f");
  const originDirectories = useMemo(
    (): SkillOriginDirectory[] => currentOriginDirectories,
    // The key is the dependency: the array is rebuilt every render and only
    // its content decides whether consumers see a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [originDirectoriesKey],
  );

  // A thread with more than one linked project can hold two skills of the
  // same name, and the transcript's sent chips say which project each
  // `$release` ran from. That answer is in the catalog, so it cannot wait
  // for the operator to open the `$` picker. Single-project threads — which
  // have nothing to disambiguate — still pay nothing.
  //
  // Asked once per thread, tracked here rather than left to `loadTarget`'s
  // guard: that guard lets an error state through, and `loadTarget`'s
  // identity changes with the thread summary, which is replaced on every
  // streamed item. Without this ref a thread whose first `listSkills` failed
  // would re-request on every delta of the turn.
  const autoLoadedKeysRef = useRef<Set<string>>(new Set());
  const autoLoadKey = originDirectories.length > 1 ? skillTarget?.key : undefined;
  useEffect(() => {
    if (!autoLoadKey || autoLoadedKeysRef.current.has(autoLoadKey)) {
      return;
    }
    autoLoadedKeysRef.current.add(autoLoadKey);
    void loadTarget();
    // `loadTarget` is deliberately not a dependency: it is re-created for
    // every thread summary, and the key is what decides whether to ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoadKey]);

  const skills = useMemo(() => {
    const deduped = new Map<string, AppServerSkillSummary>();

    for (const entry of state?.response?.data ?? []) {
      for (const skill of entry.skills) {
        const key = skill.path ?? `${entry.cwd ?? "global"}:${skill.name}`;
        deduped.set(key, skill);
      }
    }

    // Same-named skills from different linked projects sort by origin, so the
    // primary project's `$release` is the one Enter takes.
    return withSkillOrigins([...deduped.values()], originDirectories).sort(
      (left, right) =>
        left.name.localeCompare(right.name)
        || compareSkillOrigins(left.origin, right.origin)
    );
  }, [originDirectories, state?.response?.data]);

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

function readSkillOriginDirectories(
  thread: NavigationThreadSummary | undefined,
  launchpad: NavigationLaunchpadDraft | undefined,
): SkillOriginDirectory[] {
  if (thread) {
    return thread.linkedDirectories.map((directory) => ({
      label: directory.label,
      path: directory.path,
      ...(directory.worktreePath ? { worktreePath: directory.worktreePath } : {}),
    }));
  }
  const directoryPath = launchpad?.directoryPath?.trim();
  return launchpad && directoryPath
    ? [{ label: launchpad.directoryLabel, path: directoryPath }]
    : [];
}
