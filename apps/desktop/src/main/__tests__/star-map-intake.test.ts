import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationDirectorySummary } from "@pwragent/shared";

const generateGrokObject = vi.fn();
const materializeDirectoryLaunchpad = vi.fn();
const publishLocalEvent = vi.fn(async () => undefined);
const getNavigationSnapshot = vi.fn();

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => ({
    generateGrokObject,
    materializeDirectoryLaunchpad,
    publishLocalEvent,
  }),
}));

vi.mock("../messaging/desktop-backend-bridge", () => ({
  DesktopMessagingBackendBridge: class {
    getNavigationSnapshot = getNavigationSnapshot;
  },
}));

vi.mock("../profile", () => ({
  resolveActiveProfileDir: () => "/nonexistent/profile",
  resolvePwragentRoot: () => "/nonexistent/root",
}));

import { dispatchStarMapIntake } from "../app-server/star-map-intake";

function directory(
  key: string,
  label: string,
): NavigationDirectorySummary {
  return {
    key,
    kind: "directory",
    label,
    path: `/repos/${label}`,
    threadKeys: [],
    needsAttentionCount: 0,
  } as unknown as NavigationDirectorySummary;
}

beforeEach(() => {
  vi.clearAllMocks();
  getNavigationSnapshot.mockResolvedValue({
    directories: [
      directory("dir-snap", "PwrSnap"),
      directory("dir-agent", "PwrAgent"),
    ],
  });
  materializeDirectoryLaunchpad.mockResolvedValue({
    backend: "codex",
    threadId: "thread-9",
  });
});

describe("dispatchStarMapIntake", () => {
  it("creates a thread in the Grok-resolved directory with the request as first turn", async () => {
    generateGrokObject.mockResolvedValue({
      object: {
        title: "Investigate PwrSnap issue",
        directoryKey: "dir-snap",
        confidence: 0.9,
      },
    });

    const response = await dispatchStarMapIntake({
      requestId: "req-1",
      request: "Look into the screenshot issue in PwrSnap",
    });

    expect(response).toMatchObject({
      status: "created",
      backend: "codex",
      threadId: "thread-9",
      title: "Investigate PwrSnap issue",
    });
    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      {
        directoryKey: "dir-snap",
        input: [
          { type: "text", text: "Look into the screenshot issue in PwrSnap" },
        ],
      },
      { messageOrigin: { kind: "pwragent" } },
    );
    const phases = publishLocalEvent.mock.calls.map(
      (call) =>
        (call as unknown as [{ notification: { params: { phase: string } } }])[0]
          .notification.params.phase,
    );
    expect(phases).toEqual(["resolving", "creating", "done"]);
  });

  it("falls back to a deterministic label match when Grok is unavailable", async () => {
    generateGrokObject.mockRejectedValue(new Error("grok unavailable"));

    const response = await dispatchStarMapIntake({
      requestId: "req-2",
      request: "Fix the flaky test in pwragent",
    });

    expect(response.status).toBe("created");
    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({ directoryKey: "dir-agent" }),
      expect.anything(),
    );
  });

  it("asks for disambiguation when no directory clearly matches", async () => {
    generateGrokObject.mockResolvedValue({
      object: { title: "Do a thing", directoryKey: null, confidence: 0.1 },
    });

    const response = await dispatchStarMapIntake({
      requestId: "req-3",
      request: "Do a thing somewhere",
    });

    expect(response.status).toBe("needs_disambiguation");
    if (response.status === "needs_disambiguation") {
      expect(response.candidates.map((entry) => entry.directoryKey)).toEqual([
        "dir-snap",
        "dir-agent",
      ]);
    }
    expect(materializeDirectoryLaunchpad).not.toHaveBeenCalled();
  });

  it("honors a disambiguation resubmit without re-resolving", async () => {
    const response = await dispatchStarMapIntake({
      requestId: "req-4",
      request: "Do a thing somewhere",
      directoryKey: "dir-agent",
    });

    expect(response.status).toBe("created");
    expect(generateGrokObject).not.toHaveBeenCalled();
  });

  it("reports creation failures with a failed status event", async () => {
    generateGrokObject.mockResolvedValue({
      object: { title: "T", directoryKey: "dir-snap", confidence: 0.9 },
    });
    materializeDirectoryLaunchpad.mockRejectedValue(
      new Error("launchpad exploded"),
    );

    const response = await dispatchStarMapIntake({
      requestId: "req-5",
      request: "Break things in PwrSnap",
    });

    expect(response).toMatchObject({
      status: "failed",
      error: "launchpad exploded",
    });
  });

  it("rejects empty requests without touching the registry", async () => {
    const response = await dispatchStarMapIntake({
      requestId: "req-6",
      request: "   ",
    });
    expect(response.status).toBe("failed");
    expect(getNavigationSnapshot).not.toHaveBeenCalled();
  });
});
