import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTemporaryTestDirectory } from "@pwragent/agent-core";
import {
  analyzeCpuProfile,
  analyzeStartupCpuProfileSession,
  type CpuProfile,
  renderStartupCpuAnalysisSummary,
} from "../diagnostics/startup-cpu-analysis";

function buildProfile(params: {
  rootUrl?: string;
  topFunctionName?: string;
  topUrl?: string;
  secondFunctionName?: string;
  secondUrl?: string;
}): CpuProfile {
  return {
    startTime: 0,
    endTime: 15000,
    samples: [2, 2, 2, 3, 3],
    timeDeltas: [1000, 4000, 3000, 1500, 500],
    nodes: [
      {
        id: 1,
        callFrame: {
          functionName: "(root)",
          scriptId: "0",
          url: params.rootUrl ?? "",
          lineNumber: -1,
          columnNumber: -1,
        },
        children: [2, 3],
      },
      {
        id: 2,
        callFrame: {
          functionName: params.topFunctionName ?? "refreshNavigationSnapshot",
          scriptId: "1",
          url: params.topUrl ?? "file:///repo/apps/desktop/src/main/ipc/app-server.ts",
          lineNumber: 1,
          columnNumber: 1,
        },
      },
      {
        id: 3,
        callFrame: {
          functionName: params.secondFunctionName ?? "parseOverlayState",
          scriptId: "2",
          url:
            params.secondUrl
            ?? "http://127.0.0.1:5173/src/renderer/src/lib/useThreadNavigation.ts?t=1234",
          lineNumber: 1,
          columnNumber: 1,
        },
      },
    ],
  };
}

describe("startup CPU analysis", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("ranks dominant functions and source buckets by process", () => {
    const analysis = analyzeCpuProfile({
      process: "main",
      profile: buildProfile({}),
      repoRoot: "/repo",
      desktopRoot: "/repo/apps/desktop",
    });

    expect(analysis.durationMicros).toBe(10000);
    expect(analysis.topFunctionsBySelf[0]).toMatchObject({
      functionName: "refreshNavigationSnapshot",
      selfMicros: 8000,
      totalMicros: 8000,
      sourceBucket: "apps/desktop/src/main/ipc/app-server.ts",
    });
    expect(analysis.topFunctionsBySelf[1]).toMatchObject({
      functionName: "parseOverlayState",
      selfMicros: 2000,
      sourceBucket: "apps/desktop/src/renderer/src/lib/useThreadNavigation.ts",
    });
    expect(analysis.topSourcesBySelf[0]).toMatchObject({
      sourceBucket: "apps/desktop/src/main/ipc/app-server.ts",
      selfMicros: 8000,
      totalMicros: 8000,
    });
  });

  it("groups Electron and unmapped frames separately", () => {
    const analysis = analyzeCpuProfile({
      process: "renderer",
      profile: buildProfile({
        topFunctionName: "nativeImageDecode",
        topUrl: "electron/js2c/renderer_init",
        secondFunctionName: "(program)",
        secondUrl: "",
      }),
      repoRoot: "/repo",
      desktopRoot: "/repo/apps/desktop",
    });

    expect(analysis.topFunctionsBySelf[0]).toMatchObject({
      sourceBucket: "electron/js2c",
    });
    expect(analysis.topFunctionsBySelf[1]).toMatchObject({
      sourceBucket: "(unmapped)",
    });
  });

  it("aggregates duplicate function frames from repeated optimized nodes", () => {
    const analysis = analyzeCpuProfile({
      process: "renderer",
      profile: {
        startTime: 0,
        endTime: 3000,
        samples: [2, 3, 3],
        timeDeltas: [1000, 750, 1250],
        nodes: [
          {
            id: 1,
            callFrame: {
              functionName: "(root)",
              scriptId: "0",
              url: "",
            },
            children: [2, 3],
          },
          {
            id: 2,
            callFrame: {
              functionName: "formatRelativeTime",
              scriptId: "1",
              url: "http://127.0.0.1:5173/src/features/navigation/ThreadRow.tsx",
              lineNumber: 10,
              columnNumber: 2,
            },
          },
          {
            id: 3,
            callFrame: {
              functionName: "formatRelativeTime",
              scriptId: "2",
              url: "http://127.0.0.1:5173/src/features/navigation/ThreadRow.tsx",
              lineNumber: 10,
              columnNumber: 2,
            },
          },
        ],
      },
      repoRoot: "/repo",
      desktopRoot: "/repo/apps/desktop",
    });

    expect(analysis.topFunctionsBySelf[0]).toMatchObject({
      functionName: "formatRelativeTime",
      selfMicros: 3000,
      totalMicros: 3000,
      lineNumber: 10,
    });
    expect(
      analysis.topFunctionsBySelf.filter(
        (entry) => entry.functionName === "formatRelativeTime"
      )
    ).toHaveLength(1);
  });

  it("renders a human-readable summary for both processes", () => {
    const main = analyzeCpuProfile({
      process: "main",
      profile: buildProfile({}),
      repoRoot: "/repo",
      desktopRoot: "/repo/apps/desktop",
    });
    const renderer = analyzeCpuProfile({
      process: "renderer",
      profile: buildProfile({
        topFunctionName: "renderThreadList",
        topUrl: "http://127.0.0.1:5173/src/renderer/src/App.tsx",
      }),
      repoRoot: "/repo",
      desktopRoot: "/repo/apps/desktop",
    });

    const summary = renderStartupCpuAnalysisSummary({
      sessionDirectoryName: "startup-cpu-2026-04-19-0930-abc123",
      results: [main, renderer],
    });

    expect(summary).toContain("# Startup CPU Analysis");
    expect(summary).toContain("startup-cpu-2026-04-19-0930-abc123");
    expect(summary).toContain("## Main Process");
    expect(summary).toContain("## Renderer Process");
    expect(summary).toContain("refreshNavigationSnapshot");
    expect(summary).toContain("renderThreadList");
    expect(summary).toContain("apps/desktop/src/main/ipc/app-server.ts");
  });

  it("writes analysis and summary artifacts for a session directory", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const sessionDirectoryPath = path.join(
      workspace.path,
      ".local",
      "startup-cpu-2026-04-19-0930-abc123",
    );
    await fs.mkdir(sessionDirectoryPath, { recursive: true });
    await fs.writeFile(
      path.join(sessionDirectoryPath, "main.cpuprofile"),
      `${JSON.stringify(buildProfile({}))}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(sessionDirectoryPath, "renderer.cpuprofile"),
      `${JSON.stringify(
        buildProfile({
          topFunctionName: "renderThreadList",
          topUrl: "http://127.0.0.1:5173/src/renderer/src/App.tsx",
        }),
      )}\n`,
      "utf8",
    );

    const analysisPath = path.join(sessionDirectoryPath, "analysis.json");
    const summaryPath = path.join(sessionDirectoryPath, "summary.md");
    const analysis = await analyzeStartupCpuProfileSession({
      sessionDirectoryPath,
      repoRoot: workspace.path,
      analysisPath,
      summaryPath,
    });

    expect(analysis.analysisPath).toBe(analysisPath);
    expect(analysis.summaryPath).toBe(summaryPath);
    expect(analysis.results).toHaveLength(2);

    const writtenAnalysis = JSON.parse(await fs.readFile(analysisPath, "utf8"));
    expect(writtenAnalysis).toMatchObject({
      sessionDirectoryName: "startup-cpu-2026-04-19-0930-abc123",
      analysisPath,
      summaryPath,
    });

    const summary = await fs.readFile(summaryPath, "utf8");
    expect(summary).toContain("# Startup CPU Analysis");
    expect(summary).toContain("## Main Process");
    expect(summary).toContain("## Renderer Process");
  });
});
