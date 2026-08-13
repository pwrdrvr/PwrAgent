import { renderHook, waitFor } from "@testing-library/react";
import type {
  FederationCapability,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../desktop-api";
import {
  buildFederationThreadEventSubscriptions,
  useFederationThreadEventSubscriptions,
} from "../useFederationThreadEventSubscriptions";

function remoteThread(params: {
  capabilities: FederationCapability[];
  id: string;
  instanceId: string;
  peerStatus?: "connected" | "disconnected";
}): NavigationThreadSummary {
  return {
    id: params.id,
    source: "codex",
    title: params.id,
    titleSource: "explicit",
    executionMode: "default",
    linkedDirectories: [],
    inbox: { inInbox: false },
    federation: {
      ref: {
        backend: "codex",
        target: {
          scope: "remote",
          instanceId: params.instanceId,
        },
        threadId: params.id,
      },
      instanceLabel: params.instanceId,
      peerStatus: params.peerStatus ?? "connected",
      capabilities: params.capabilities,
    },
  } as NavigationThreadSummary;
}

const fullCapabilities: FederationCapability[] = [
  "event_subscriptions",
  "thread_navigation",
  "thread_detail",
  "pending_request_control",
  "scheduled_actions",
];

describe("useFederationThreadEventSubscriptions", () => {
  it("keeps pinned owners live and adds detail events for the selected owner", () => {
    const selected = remoteThread({
      capabilities: fullCapabilities,
      id: "selected",
      instanceId: "owner_one",
    });
    const background = remoteThread({
      capabilities: fullCapabilities,
      id: "background",
      instanceId: "owner_two",
    });
    const offline = remoteThread({
      capabilities: fullCapabilities,
      id: "offline",
      instanceId: "owner_three",
      peerStatus: "disconnected",
    });

    expect(buildFederationThreadEventSubscriptions({
      selectedThread: selected,
      threads: [selected, background, offline],
    })).toEqual([
      {
        sourceInstanceId: "owner_one",
        eventClasses: [
          "navigation",
          "transcript",
          "pending_requests",
          "scheduled_actions",
        ],
        threadSelection: {
          kind: "threads",
          threads: [{ backend: "codex", threadId: "selected" }],
        },
      },
      {
        sourceInstanceId: "owner_two",
        eventClasses: ["navigation", "scheduled_actions"],
        threadSelection: {
          kind: "threads",
          threads: [{ backend: "codex", threadId: "background" }],
        },
      },
    ]);
  });

  it("owns a separate subscription consumer and clears it on unmount", async () => {
    const setFederationEventSubscriptions = vi.fn(async (request) => ({
      subscriptions: request.subscriptions,
    }));
    const desktopApi = {
      setFederationEventSubscriptions,
    } as DesktopApi;
    const selected = remoteThread({
      capabilities: fullCapabilities,
      id: "selected",
      instanceId: "owner_one",
    });

    const rendered = renderHook(() =>
      useFederationThreadEventSubscriptions({
        desktopApi,
        enabled: true,
        selectedThread: selected,
        threads: [selected],
      }),
    );

    await waitFor(() => {
      expect(setFederationEventSubscriptions).toHaveBeenCalledWith({
        consumer: "thread_view",
        subscriptions: [{
          sourceInstanceId: "owner_one",
          eventClasses: [
            "navigation",
            "transcript",
            "pending_requests",
            "scheduled_actions",
          ],
          threadSelection: {
            kind: "threads",
            threads: [{ backend: "codex", threadId: "selected" }],
          },
        }],
      });
    });
    expect(rendered.result.current).toEqual([{
      scope: "remote",
      instanceId: "owner_one",
    }]);

    rendered.unmount();
    expect(setFederationEventSubscriptions).toHaveBeenLastCalledWith({
      consumer: "thread_view",
      subscriptions: [],
    });
  });
});
