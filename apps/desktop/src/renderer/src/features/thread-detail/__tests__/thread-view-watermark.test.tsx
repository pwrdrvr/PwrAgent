import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CelestialIconId, FederationRemoteTarget } from "@pwragent/shared";
import { CelestialWatermark } from "../../../components/CelestialWatermark";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useIntegratedTerminals } from "../../../lib/useIntegratedTerminals";
import {
  ThreadView as ThreadViewWithTerminals,
  type ThreadViewProps,
} from "../ThreadView";

function ThreadView(props: Omit<ThreadViewProps, "terminals">): ReactElement {
  const terminals = useIntegratedTerminals(props.desktopApi);
  return <ThreadViewWithTerminals {...props} terminals={terminals} />;
}

function buildDesktopApi(): DesktopApi {
  return {
    readFederationHealth: vi.fn(async () => ({
      health: {
        enabled: true,
        role: "gateway" as const,
        status: "listening" as const,
        instanceId: "pwr_local",
        localCelestialIcon: "sun" as const,
        peers: [
          {
            id: "peer_one",
            label: "Example-Peer",
            role: "client" as const,
            status: "connected" as const,
            capabilities: [],
            celestialIcon: "moon" as const,
          },
        ],
      },
    })),
    onAgentEvent: vi.fn(() => () => undefined),
  };
}

function watermarkMarkup(icon: CelestialIconId): string {
  return renderToStaticMarkup(<CelestialWatermark icon={icon} />);
}

afterEach(() => {
  cleanup();
});

describe("ThreadView launchpad watermark", () => {
  it.each<[string, FederationRemoteTarget | undefined, CelestialIconId]>([
    ["the peer it will start on", { scope: "remote", instanceId: "peer_one" }, "moon"],
    ["this machine", undefined, "sun"],
  ])("marks a new thread with %s", async (_label, activeFederationTarget, icon) => {
    const view = render(
      <ThreadView
        activeFederationTarget={activeFederationTarget}
        addOptimisticUserMessage={() => "optimistic-1"}
        backends={[]}
        clearPendingRequest={() => undefined}
        composerDisabled={false}
        desktopApi={buildDesktopApi()}
        loading={false}
        loadingMore={false}
        messageCount={0}
        selectedDirectory={{
          key: "directory:/repo", kind: "directory", label: "Example", path: "/repo",
        }}
        selectedLaunchpad={{
          backend: "codex", directoryKey: "directory:/repo", directoryKind: "directory",
          directoryLabel: "Example", directoryPath: "/repo", executionMode: "default",
          prompt: "", workMode: "worktree", createdAt: 1, updatedAt: 1,
        }}
        skills={[]}
        transcriptEntries={[]}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={() => undefined}
      />,
    );

    await waitFor(() => {
      const watermark = view.container.querySelector(
        ".thread-view__primary > .celestial-watermark",
      );
      expect(watermark?.outerHTML).toBe(watermarkMarkup(icon));
    });
  });
});
