import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  compareSkillOrigins,
  withSkillOrigins,
  type SkillOriginDirectory,
} from "@pwragent/shared/skill-origin";
import {
  type AppServerAvailableCommandSummary,
  type AppServerListSkillsResponse,
  type AppServerSkillSummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  type NavigationLaunchpadDraft,
  type NavigationThreadSummary,
} from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "./desktop-api";
import {
  agentEventMatchesThread,
  federationTargetsEqual,
  threadSummaryIdentityKey,
} from "./federated-thread-events";

type SkillState = {
  error?: string;
  loadedAt?: number;
  loading: boolean;
  response?: AppServerListSkillsResponse;
};

const SKILL_CATALOG_FRESH_MS = 30_000;

function createEmptySkillState(): SkillState {
  return { loading: false };
}

type EnsureSkillsOptions = { force?: boolean; includeCommands?: boolean };

export type ThreadProviderCommand = AppServerAvailableCommandSummary & {
  /** Renderer-only match against the owning workspace's Antigravity catalog. */
  skill?: AppServerSkillSummary;
};

function slashSkillKey(name: string, description: string | undefined): string | undefined {
  const summary = description?.replace(/\s+/g, " ").trim();
  return summary ? `${name.replace(/^\//, "")}\0${summary}` : undefined;
}

function indexAntigravitySlashSkills(
  skills: AppServerSkillSummary[],
): Map<string, AppServerSkillSummary | undefined> {
  const matches = new Map<string, AppServerSkillSummary | undefined>();
  for (const skill of skills) {
    if (!skill.path || !skill.origin || skill.enabled === false || skill.mentionOnly) continue;
    const prefix = skill.pluginId ? `${skill.pluginId}:` : undefined;
    const names = prefix && skill.name.startsWith(prefix)
      ? [skill.name, skill.name.slice(prefix.length)]
      : [skill.name];
    for (const name of names) {
      const key = slashSkillKey(name, skill.description);
      // ACP doesn't identify the selected file. Multiple distinct paths with
      // the same advertisement leave provenance unknown.
      if (key && matches.get(key)?.path !== skill.path) {
        matches.set(key, matches.has(key) ? undefined : skill);
      }
    }
  }
  return matches;
}

export function useThreadSkills(params: {
  desktopApi?: DesktopApi;
  launchpad?: NavigationLaunchpadDraft;
  thread?: NavigationThreadSummary;
  now?: () => number;
}): {
  ensureLoaded: (options?: EnsureSkillsOptions) => Promise<void>;
  error?: string;
  loading: boolean;
  providerCommands: ThreadProviderCommand[];
  response?: AppServerListSkillsResponse;
  skillCatalogTargetKey?: string;
  skills: AppServerSkillSummary[];
} {
  const { desktopApi, launchpad, thread } = params;
  const now = params.now ?? Date.now;
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
        key: thread.source === "acp:antigravity"
          ? `${threadSummaryIdentityKey(thread)}:${JSON.stringify(cwds)}`
          : threadSummaryIdentityKey(thread),
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
        key: `launchpad:${launchpad.backend}:${targetKey}${launchpad.directoryKey}`
          + (launchpad.backend === "acp:antigravity" ? `:${JSON.stringify(cwds)}` : ""),
        threadId: undefined,
      };
    }

    return undefined;
  }, [launchpad, thread]);
  const state = skillTarget ? stateByThreadKey[skillTarget.key] : undefined;
  const separateCommands = skillTarget?.backend === "acp:antigravity";
  const commandState = separateCommands && skillTarget
    ? stateByThreadKey[`${skillTarget.key}:commands`]
    : state;

  useEffect(() => {
    stateByThreadKeyRef.current = stateByThreadKey;
  }, [stateByThreadKey]);

  // Writes the ref and the React state together. The in-flight guard below is
  // read synchronously so concurrent picker opens share a request instead
  // of waiting for a React effect to publish the in-flight state.
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
    async (options: { force?: boolean; replacePending?: boolean; commandsOnly?: boolean } = {}): Promise<void> => {
      if (!skillTarget) {
        return;
      }

      const key = options.commandsOnly ? `${skillTarget.key}:commands` : skillTarget.key;
      if (!desktopApi?.listSkills) {
        commitState((current) => ({
          ...current,
          [key]: {
            error: "Desktop bridge is missing listSkills().",
            loading: false,
            response: undefined,
          },
        }));
        return;
      }

      const currentState = stateByThreadKeyRef.current[key];
      // An empty slash response can be a timed-out or cooling-down owner
      // probe. Reopening the picker should ask again after the owner recovers.
      const hasCachedResult = currentState?.response && (!options.commandsOnly
        || currentState.response.data.some(({ commands }) => commands?.length));
      if ((currentState?.loading && !options.replacePending) || (!options.force && hasCachedResult)) {
        return;
      }

      const requestVersion =
        (requestVersionsRef.current[key] ?? 0) + 1;
      requestVersionsRef.current[key] = requestVersion;
      const cwds = skillTarget.cwds;

      commitState((current) => ({
        ...current,
        [key]: {
          ...(currentState ?? createEmptySkillState()),
          error: undefined,
          loading: true,
        },
      }));

      try {
        const response = await desktopApi.listSkills({
          backend: skillTarget.backend,
          ...(skillTarget.backend === "acp:antigravity"
            ? { catalog: options.commandsOnly ? "commands" : "skills" }
            : {}),
          ...(cwds.length === 1 ? { cwd: cwds[0] } : {}),
          ...(cwds.length > 0 ? { cwds } : {}),
          ...(skillTarget.federationTarget
            ? { federationTarget: skillTarget.federationTarget }
            : {}),
          ...(skillTarget.threadId ? { threadId: skillTarget.threadId } : {}),
        });

        if (requestVersionsRef.current[key] !== requestVersion) {
          return;
        }

        commitState((current) => ({
          ...current,
          [key]: {
            error: undefined,
            loadedAt: now(),
            loading: false,
            response,
          },
        }));
      } catch (error) {
        if (requestVersionsRef.current[key] !== requestVersion) {
          return;
        }

        commitState((current) => ({
          ...current,
          [key]: {
            error: error instanceof Error ? error.message : String(error),
            loading: false,
            response: undefined,
          },
        }));
      }
    },
    [commitState, desktopApi, now, skillTarget],
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

      const { cwd, commands: incoming } = event.notification.params;
      const commands = Array.isArray(incoming) ? incoming : [];
      const commandKey = backend === "acp:antigravity" ? `${key}:commands` : key;
      requestVersionsRef.current[commandKey] =
        (requestVersionsRef.current[commandKey] ?? 0) + 1;
      commitState((current) => ({
        ...current,
        [commandKey]: {
          error: undefined,
          loading: false,
          response: {
            backend,
            fetchedAt: Date.now(),
            data: [
              {
                ...(typeof cwd === "string" ? { cwd } : {}),
                commands,
                // The update carries commands only. A backend that lists its
                // skills beside them (Claude) keeps the ones already loaded.
                skills: current[commandKey]?.response?.data.flatMap((entry) => entry.skills) ?? [],
              },
            ],
          },
        },
      }));
    });
  }, [commitState, desktopApi, loadTarget, skillTarget, thread]);

  const ensureLoaded = useCallback(async (options?: EnsureSkillsOptions): Promise<void> => {
    // Reuse recent results across picker openings. Freshness uses this
    // renderer's clock, not a remote owner's fetchedAt. Explicit Refresh
    // bypasses the window; nothing polls while the picker is closed.
    const loadedAt = skillTarget ? stateByThreadKeyRef.current[skillTarget.key]?.loadedAt : undefined;
    const age = loadedAt === undefined ? undefined : now() - loadedAt;
    const stale = (skillTarget?.backend === "codex" || separateCommands)
      && (age === undefined || age >= SKILL_CATALOG_FRESH_MS || age < 0);
    await Promise.all([
      loadTarget({ force: options?.force || stale }),
      separateCommands && options?.includeCommands
        ? loadTarget({ force: options.force, commandsOnly: true })
        : undefined,
    ]);
  }, [loadTarget, now, separateCommands, skillTarget]);

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
  const needsRemoteProfiles = skillTarget?.federationTarget?.scope === "remote"
    && skillTarget.backend === "codex" && (!thread || Boolean(thread.codexSkillProfile));
  const remoteLaunchpadKey = !thread && needsRemoteProfiles ? skillTarget?.key : undefined;
  const previousRemoteLaunchpadKey = useRef<string>(undefined);
  const autoLoadKey = originDirectories.length > 1 || needsRemoteProfiles ? skillTarget?.key : undefined;
  useEffect(() => {
    const selectedNewRemoteLaunchpad = remoteLaunchpadKey !== previousRemoteLaunchpadKey.current;
    previousRemoteLaunchpadKey.current = remoteLaunchpadKey;
    if (remoteLaunchpadKey) {
      if (selectedNewRemoteLaunchpad) void loadTarget({ force: true, replacePending: true });
      return;
    }
    if (!autoLoadKey || autoLoadedKeysRef.current.has(autoLoadKey)) {
      return;
    }
    autoLoadedKeysRef.current.add(autoLoadKey);
    void loadTarget();
    // `loadTarget` is deliberately not a dependency: it is re-created for
    // every thread summary, and the key is what decides whether to ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoadKey, remoteLaunchpadKey]);

  // Main sends its bundled skill root only on a local listing. A peer's skill
  // paths are on the peer's machine, so a remote target never uses one, even
  // if a response somehow carried it.
  const isRemoteTarget = skillTarget?.federationTarget?.scope === "remote";
  const bundledSkillRoots = isRemoteTarget
    ? undefined
    : state?.response?.bundledSkillRoots;

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
    return withSkillOrigins(
      [...deduped.values()],
      originDirectories,
      { bundledSkillRoots },
    ).sort(
      (left, right) =>
        left.name.localeCompare(right.name)
        || compareSkillOrigins(left.origin, right.origin)
    );
  }, [bundledSkillRoots, originDirectories, state?.response?.data]);

  const antigravityCatalog = separateCommands ? state?.response?.data : undefined;
  const providerCommands = useMemo(() => {
    const deduped = new Map<string, ThreadProviderCommand>();
    const matchesByWorkspace = new Map<string, ReturnType<typeof indexAntigravitySlashSkills>>();

    for (const entry of commandState?.response?.data ?? []) {
      let matches = entry.cwd ? matchesByWorkspace.get(entry.cwd) : undefined;
      if (!matches && entry.cwd && entry.commands?.length && antigravityCatalog) {
        const workspaceSkills = antigravityCatalog.flatMap(({ cwd, skills }) => cwd === entry.cwd ? skills : []);
        matches = indexAntigravitySlashSkills(withSkillOrigins(workspaceSkills, originDirectories));
        matchesByWorkspace.set(entry.cwd, matches);
      }
      for (const command of entry.commands ?? []) {
        const backend = command.backend ?? skillTarget?.backend;
        const skillKey = backend === "acp:antigravity" && !command.argumentHint
          ? slashSkillKey(command.name, command.description)
          : undefined;
        const skill = skillKey ? matches?.get(skillKey) : undefined;
        deduped.set(`${backend ?? "unknown"}:${command.name}`, skill ? { ...command, skill } : command);
      }
    }

    return [...deduped.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  }, [antigravityCatalog, originDirectories, skillTarget?.backend, commandState?.response?.data]);

  return {
    ensureLoaded,
    error: state?.error,
    loading: state?.loading ?? false,
    providerCommands,
    response: state?.response,
    skillCatalogTargetKey: separateCommands ? skillTarget.key : undefined,
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
