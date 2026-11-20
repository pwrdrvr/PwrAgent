import { act, cleanup, render, screen } from "@testing-library/react";
import { DESKTOP_LOGS_VIEWER_DEFAULTS } from "@pwragent/shared/contracts/settings";
import type {
  DesktopMarkdownRenderingPreferences,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import { afterEach, expect, it, vi } from "vitest";
import { navigationOwnerApiFixture } from "../test/navigation-owner-api-fixture";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.doUnmock("../features/thread-detail/ThreadView");
  vi.doUnmock("../features/thread-detail/IncrementalMarkdown");
  vi.doUnmock("../lib/markdown-math-runtime");
});

async function startApp(markdown?: DesktopMarkdownRenderingPreferences) {
  vi.resetModules();
  const incremental = vi.fn(() => ({ IncrementalMarkdown: () => [] }));
  const math = vi.fn(() => ({
    markdownMathRuntime: { normalize: (text: string) => text, remarkPlugins: [], rehypePlugins: [] },
  }));
  vi.doMock("../features/thread-detail/IncrementalMarkdown", incremental);
  vi.doMock("../lib/markdown-math-runtime", math);
  vi.doMock("../features/thread-detail/ThreadView", async () => {
    const { useIncrementalMarkdownRenderer, useMarkdownMathRuntime } =
      await import("../lib/markdown-rendering-options");
    return {
      ThreadView() {
        const renderer = useIncrementalMarkdownRenderer();
        const runtime = useMarkdownMathRuntime("$$x$$");
        return <div data-testid="transcript">{renderer ? "incremental" : "standard"} {runtime ? "math" : "plain"}</div>;
      },
    };
  });
  const settings = Promise.withResolvers<{ snapshot: DesktopSettingsSnapshot }>();
  const readSettings = vi.fn(() => settings.promise);
  vi.stubGlobal("pwragent", navigationOwnerApiFixture({
    readSettings,
    readConfigBootstrap: async () => ({
      snapshot: {
        version: 1,
        configRevision: "fixture",
        appearance: {
          theme: "system",
          darkTheme: "tangerine-dark",
          lightTheme: "tangerine-light",
          density: "mission-control",
          sidebarTextSize: "md",
          transcriptTextSize: "md",
          calmMotion: false,
        },
        onboarding: { completed: true, completedSource: "migrated" },
        logs: DESKTOP_LOGS_VIEWER_DEFAULTS,
        htmlPreviewRunScripts: false,
        markdown,
      },
    }),
    listBackends: async () => ({ fetchedAt: 1, backends: [] }),
    readPopulation: async () => ({
      backend: "all",
      fetchedAt: 1,
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      launchpadDefaults: { backend: "codex", executionMode: "default" },
    }),
  }));
  const { App } = await import("../App");
  await act(async () => { render(<App />); });
  await screen.findByTestId("transcript");
  await settleImports();
  expect(readSettings).toHaveBeenCalledTimes(1);
  return { settings, incremental, math };
}

async function settleImports() {
  await act(async () => { await vi.dynamicImportSettled(); });
}

it.each([
  { incrementalRendering: true, mathRendering: false, transcript: "incremental plain" },
  { incrementalRendering: false, mathRendering: true, transcript: "standard math" },
])("loads $transcript only after Markdown preferences arrive", async (preferences) => {
  // An earlier bootstrap response can unlock navigation without Markdown preferences.
  const { settings, incremental, math } = await startApp();
  expect([incremental.mock.calls.length, math.mock.calls.length]).toEqual([0, 0]);
  expect(screen.getByTestId("transcript").textContent).toBe("standard plain");

  await act(async () => {
    settings.resolve({
      snapshot: {
        general: {
          appearance: {
            theme: { value: "system", source: "default" },
            darkTheme: { value: "tangerine-dark", source: "default" },
            lightTheme: { value: "tangerine-light", source: "default" },
            density: { value: "mission-control", source: "default" },
            sidebarTextSize: { value: "md", source: "default" },
            transcriptTextSize: { value: "md", source: "default" },
            calmMotion: { value: false, source: "default" },
          },
          markdown: {
            incrementalRendering: { value: preferences.incrementalRendering, source: "config" },
            mathRendering: { value: preferences.mathRendering, source: "config" },
          },
        },
        experimental: { fullAccessRiskWarningDismissed: { value: false, source: "default" } },
        imageUploads: { pastedImageMaxPatches: { value: 1536, source: "default" } },
        onboarding: { completed: { value: true, source: "default" } },
      } as DesktopSettingsSnapshot,
    });
  });
  await settleImports();
  expect(incremental).toHaveBeenCalledTimes(Number(preferences.incrementalRendering));
  expect(math).toHaveBeenCalledTimes(Number(preferences.mathRendering));
  expect(screen.getByTestId("transcript").textContent).toBe(preferences.transcript);
});

it("keeps honoring bootstrap preferences when the full settings read fails", async () => {
  const { settings, incremental, math } = await startApp({ incrementalRendering: false, mathRendering: true });
  await act(async () => { settings.reject(new Error("Settings read failed")); });
  await settleImports();
  expect(incremental).not.toHaveBeenCalled();
  expect(math).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("transcript").textContent).toBe("standard math");
});
