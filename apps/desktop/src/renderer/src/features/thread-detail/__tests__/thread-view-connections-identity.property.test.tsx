import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { NavigationDirectorySummary, NavigationLaunchpadDraft } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useIntegratedTerminals } from "../../../lib/useIntegratedTerminals";
import { ThreadView, type ThreadViewProps } from "../ThreadView";

const directory = {
  key: "directory:/repo",
  kind: "directory",
  label: "Repo",
  path: "/repo",
  threadKeys: [],
  needsAttentionCount: 0,
} satisfies NavigationDirectorySummary;
const launchpad = {
  backend: "codex",
  createdAt: 1_000,
  directoryKey: directory.key,
  directoryKind: directory.kind,
  directoryLabel: directory.label,
  directoryPath: directory.path,
  executionMode: "default",
  prompt: "",
  updatedAt: 1_000,
  workMode: "local",
} satisfies NavigationLaunchpadDraft;

function Launchpad(props: { desktopApi: DesktopApi; sidebarHidden: boolean; contextRailPinned: boolean }) {
  const terminals = useIntegratedTerminals(props.desktopApi);
  const view: ThreadViewProps = {
    ...props,
    terminals,
    addOptimisticUserMessage: () => "optimistic-1",
    backends: [],
    clearPendingRequest: () => undefined,
    composerDisabled: false,
    launchpadConnectionsDock: "launchpad",
    loading: false,
    loadingMore: false,
    messageCount: 0,
    selectedDirectory: directory,
    selectedLaunchpad: launchpad,
    skills: [],
    transcriptEntries: [],
    onLoadOlder: async () => undefined,
    removeOptimisticMessage: () => undefined,
  };
  return <ThreadView {...view} />;
}

// A parent update must keep the connection tiles mounted. A locally declared
// React component would replace the DOM and reread status on every update.
it("retains connection tile identity through window layout changes", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ sidebarHidden: fc.boolean(), contextRailPinned: fc.boolean() }), {
      minLength: 1, maxLength: 5, size: "max",
    }),
    async (changes) => {
      const readStatus = vi.fn<NonNullable<DesktopApi["readPwrSnapConnectionStatus"]>>().mockResolvedValue({
        connectionId: "pwrsnap", displayName: "PwrSnap", availability: "running", configured: false,
      });
      const desktopApi: DesktopApi = {
        listMcpConnections: async () => ({ connections: [] }),
        readPwrSnapConnectionStatus: readStatus,
      };
      try {
        const view = render(<Launchpad desktopApi={desktopApi} sidebarHidden={false} contextRailPinned />);
        const button = await screen.findByRole("button", { name: "Update PwrSnap" });
        for (const change of changes) {
          view.rerender(<Launchpad desktopApi={desktopApi} {...change} />);
          expect(screen.getByRole("button", { name: "Update PwrSnap" })).toBe(button);
          expect(readStatus).toHaveBeenCalledTimes(1);
        }
      } finally {
        cleanup();
      }
    },
  ), { numRuns: 25 });
});
