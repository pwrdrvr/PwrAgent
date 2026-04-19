import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AppServerListSkillsResponse,
  AppServerSkillSummary,
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
} from "@pwragnt/shared";
import type { DesktopApi } from "./desktop-api";

type SkillState = {
  error?: string;
  loading: boolean;
  response?: AppServerListSkillsResponse;
};

export function useThreadSkills(params: {
  desktopApi?: DesktopApi;
  launchpad?: NavigationLaunchpadDraft;
  thread?: NavigationThreadSummary;
}): {
  error?: string;
  loading: boolean;
  response?: AppServerListSkillsResponse;
  skills: AppServerSkillSummary[];
} {
  const { desktopApi, launchpad, thread } = params;
  const [state, setState] = useState<SkillState>({ loading: false });
  const requestVersionRef = useRef(0);

  useEffect(() => {
    const backend = thread?.source ?? launchpad?.backend;
    if (!backend || backend !== "codex") {
      setState({ loading: false, error: undefined, response: undefined });
      return;
    }

    if (!desktopApi?.listSkills) {
      setState({
        loading: false,
        error: "Desktop bridge is missing listSkills().",
        response: undefined,
      });
      return;
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const cwds = thread
      ? [...new Set(
          thread.linkedDirectories
            .map((directory) => directory.worktreePath ?? directory.path)
            .filter(Boolean)
        )]
      : launchpad?.directoryPath
        ? [launchpad.directoryPath]
        : [];

    setState((current) => ({
      ...current,
      loading: true,
      error: undefined,
    }));

    void desktopApi
      .listSkills({
        backend,
        cwd: !thread && cwds.length === 1 ? cwds[0] : undefined,
        cwds: cwds.length > 0 ? cwds : undefined,
      })
      .then((response) => {
        if (requestVersionRef.current !== requestVersion) {
          return;
        }

        setState({
          loading: false,
          error: undefined,
          response,
        });
      })
      .catch((error: unknown) => {
        if (requestVersionRef.current !== requestVersion) {
          return;
        }

        setState({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          response: undefined,
        });
      });
  }, [desktopApi, launchpad, thread]);

  const skills = useMemo(() => {
    const deduped = new Map<string, AppServerSkillSummary>();

    for (const entry of state.response?.data ?? []) {
      for (const skill of entry.skills) {
        const key = skill.path ?? `${entry.cwd ?? "global"}:${skill.name}`;
        deduped.set(key, skill);
      }
    }

    return [...deduped.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  }, [state.response?.data]);

  return {
    error: state.error,
    loading: state.loading,
    response: state.response,
    skills,
  };
}
