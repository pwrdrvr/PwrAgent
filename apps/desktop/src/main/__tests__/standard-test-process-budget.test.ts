// Regression budget for standard Vitest worker-process churn.
//
// The desktop main suite loads native runtime bindings. Vitest documents that
// native modules can segfault in the worker-thread pool, so that project owns
// its bindings in forked OS processes. The pure projects retain `threads` to
// avoid expanding normal test discovery into per-file process churn.
import { describe, expect, it } from "vitest";
import workspaceConfig from "../../../../../vitest.workspace";

const EXPECTED_PROJECTS = [
  "desktop-main",
  "desktop-renderer",
  "messaging",
  "shared",
];
const EXPECTED_POOLS = {
  "desktop-main": "forks",
  "desktop-renderer": "threads",
  messaging: "threads",
  shared: "threads",
} as const;
const EXPECTED_OS_WORKER_PROCESSES_PER_TEST_FILE = [
  { name: "desktop-main", osWorkerProcessesPerTestFile: 1 },
  { name: "desktop-renderer", osWorkerProcessesPerTestFile: 0 },
  { name: "messaging", osWorkerProcessesPerTestFile: 0 },
  { name: "shared", osWorkerProcessesPerTestFile: 0 },
];

type ConfiguredProject = {
  test?: {
    name?: string;
    pool?: string;
  };
};

describe("standard test process budget", () => {
  it("keeps native desktop-main in process-isolated workers", () => {
    const projects = configuredProjects();

    expect(projects.map((project) => project.test?.name).sort()).toEqual(
      EXPECTED_PROJECTS,
    );
    expect(projects).toHaveLength(EXPECTED_PROJECTS.length);
    expect(
      Object.fromEntries(
        projects.map((project) => [project.test?.name, project.test?.pool]),
      ),
    ).toEqual(EXPECTED_POOLS);
  });

  it.runIf(process.platform !== "win32")(
    "keeps the POSIX OS worker process budget explicit per test file",
    () => {
      const projects = configuredProjects();

      expect(
        projects.map((project) => ({
          name: project.test?.name,
          osWorkerProcessesPerTestFile:
            project.test?.pool === "threads" ? 0 : 1,
        })),
      ).toEqual(EXPECTED_OS_WORKER_PROCESSES_PER_TEST_FILE);
    },
  );
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
