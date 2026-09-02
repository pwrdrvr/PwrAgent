// Regression budget for standard Vitest worker-process churn.
//
// Vitest 4 defaults to the `forks` pool. In this workspace that produced one
// fresh Node OS process per test file: 356 fork-worker execs for desktop-main
// alone. Ten concurrent worktrees therefore multiply ordinary test discovery
// into thousands of executable provenance events on macOS.
//
// `threads` keeps Vitest's default file isolation but does not exec an OS
// process for each file. Keep the budget explicit so a pool default change or
// a newly added project cannot quietly restore per-file process scaling.
import { describe, expect, it } from "vitest";
import workspaceConfig from "../../../../../vitest.workspace";

const EXPECTED_PROJECTS = [
  "desktop-main",
  "desktop-renderer",
  "messaging",
  "shared",
];
const OS_WORKER_PROCESS_BUDGET_PER_TEST_FILE = 0;

type ConfiguredProject = {
  test?: {
    name?: string;
    pool?: string;
  };
};

describe("standard test process budget", () => {
  it("keeps every project on an in-process worker pool", () => {
    const projects = configuredProjects();

    expect(projects.map((project) => project.test?.name).sort()).toEqual(
      EXPECTED_PROJECTS,
    );
    expect(projects).toHaveLength(EXPECTED_PROJECTS.length);
    expect(
      projects.map((project) => ({
        name: project.test?.name,
        osWorkerProcessesPerTestFile:
          project.test?.pool === "threads" ? 0 : 1,
      })),
    ).toEqual(
      EXPECTED_PROJECTS.map((name) => ({
        name,
        osWorkerProcessesPerTestFile:
          OS_WORKER_PROCESS_BUDGET_PER_TEST_FILE,
      })),
    );
  });
});

function configuredProjects(): ConfiguredProject[] {
  return (workspaceConfig.test?.projects ?? [])
    .filter(
      (project): project is ConfiguredProject =>
        typeof project === "object"
        && project !== null
        && typeof (project as ConfiguredProject).test?.name === "string",
    )
    .sort((left, right) =>
      (left.test?.name ?? "").localeCompare(right.test?.name ?? ""),
    );
}
