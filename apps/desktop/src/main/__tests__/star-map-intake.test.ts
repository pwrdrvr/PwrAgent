import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationDirectoryRow } from "@pwragent/shared";

const generateStructuredObject = vi.fn();
const ensureDirectoryLaunchpad = vi.fn();
const materializeDirectoryLaunchpad = vi.fn();
const publishLocalEvent = vi.fn(async () => undefined);
const readLocalNavigationDirectoryIndex = vi.hoisted(() => vi.fn());

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => ({
    ensureDirectoryLaunchpad,
    generateStructuredObject,
    materializeDirectoryLaunchpad,
    publishLocalEvent,
  }),
}));

vi.mock("../app-server/navigation-directory-index", () => ({ readLocalNavigationDirectoryIndex }));

vi.mock("../profile", () => ({
  resolveActiveProfileDir: () => "/nonexistent/profile",
  resolvePwragentRoot: () => "/nonexistent/root",
}));

import { dispatchStarMapIntake } from "../app-server/star-map-intake";

function directory(
  key: string,
  label: string,
  options?: { latestUpdatedAt?: number; currentBranch?: string },
): NavigationDirectoryRow {
  return {
    key,
    kind: "directory",
    label,
    path: `/repos/${label}`,
    counts: { total: 0, active: 0, unread: 0, review: 0 },
    latestUpdatedAt: options?.latestUpdatedAt,
    ...(options?.currentBranch
      ? { gitStatus: { currentBranch: options.currentBranch } }
      : {}),
    pinnedRootCount: 0, unpinnedRootCount: 0, launchpadPresent: false,
  } as unknown as NavigationDirectoryRow;
}

/** The ranked shape the resolver now returns. */
function ranked(
  entries: Array<{ directoryKey: string; confidence: number; reason?: string }>,
) {
  return {
    status: "ok",
    object: {
      candidates: entries.map((entry) => ({
        reason: "because",
        ...entry,
      })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  readLocalNavigationDirectoryIndex.mockResolvedValue([
      directory("dir-snap", "PwrSnap", { latestUpdatedAt: 10 }),
      directory("dir-agent", "PwrAgent", {
        currentBranch: "feat/icons",
        latestUpdatedAt: 20,
      }),
  ]);
  materializeDirectoryLaunchpad.mockResolvedValue({
    backend: "codex",
    threadId: "thread-9",
  });
  ensureDirectoryLaunchpad.mockImplementation(async (request) => ({
    launchpad: {
      ...request,
      backend: "codex",
      executionMode: "default",
      prompt: "",
      workMode: "local",
      createdAt: 1,
      updatedAt: 1,
    },
    defaults: {
      backend: "codex",
      executionMode: "default",
    },
  }));
});

describe("dispatchStarMapIntake", () => {
  it("creates a thread in the backend-resolved directory with the request as first turn", async () => {
    generateStructuredObject.mockResolvedValue(
      ranked([{ directoryKey: "dir-snap", confidence: 0.9 }]),
    );

    const response = await dispatchStarMapIntake({
      requestId: "req-1",
      request: "Look into the screenshot issue in PwrSnap",
    });

    expect(response).toMatchObject({
      status: "created",
      backend: "codex",
      threadId: "thread-9",
    });
    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "dir-snap",
      directoryKind: "directory",
      directoryLabel: "PwrSnap",
      directoryPath: "/repos/PwrSnap",
      currentBranch: undefined,
      preferredBackend: undefined,
    });
    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      {
        directoryKey: "dir-snap",
        launchpad: expect.objectContaining({
          directoryKey: "dir-snap",
          directoryLabel: "PwrSnap",
        }),
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

  it("falls back to a deterministic label match when structured generation is unavailable", async () => {
    generateStructuredObject.mockResolvedValue({
      status: "unavailable",
      reason: "acp:grok_structured_generation_unavailable",
    });

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

  it("includes staged image attachments in the created thread's first turn", async () => {
    const response = await dispatchStarMapIntake({
      requestId: "req-image",
      request: "Fix the screenshot issue in PwrAgent",
      directoryKey: "dir-agent",
      attachments: [
        {
          type: "localImage",
          name: "screenshot.png",
          path: "/pwragent/image-inputs/screenshot.png",
        },
      ],
    });

    expect(response.status).toBe("created");
    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        directoryKey: "dir-agent",
        input: [
          { type: "text", text: "Fix the screenshot issue in PwrAgent" },
          {
            type: "localImage",
            name: "screenshot.png",
            path: "/pwragent/image-inputs/screenshot.png",
          },
        ],
      }),
      { messageOrigin: { kind: "pwragent" } },
    );
  });

  it("asks for disambiguation when no directory clearly matches", async () => {
    generateStructuredObject.mockResolvedValue(ranked([]));

    const response = await dispatchStarMapIntake({
      requestId: "req-3",
      request: "Do a thing somewhere",
    });

    expect(response.status).toBe("needs_disambiguation");
    if (response.status === "needs_disambiguation") {
      // Recency order, not registry order: dir-agent is the newer of the two.
      expect(response.candidateSource).toBe("recent");
      expect(response.candidates.map((entry) => entry.directoryKey)).toEqual([
        "dir-agent",
        "dir-snap",
      ]);
    }
    expect(materializeDirectoryLaunchpad).not.toHaveBeenCalled();
  });

  it("offers the resolver's ranking with its reasons when no pick is confident enough", async () => {
    generateStructuredObject.mockResolvedValue(
      ranked([
        { directoryKey: "dir-agent", confidence: 0.4, reason: "mentions threads" },
        { directoryKey: "dir-snap", confidence: 0.2, reason: "also takes shots" },
      ]),
    );

    const response = await dispatchStarMapIntake({
      requestId: "req-ranked",
      request: "Tidy up the thread list",
    });

    expect(response.status).toBe("needs_disambiguation");
    if (response.status === "needs_disambiguation") {
      expect(response.candidateSource).toBe("resolver");
      expect(response.candidates).toEqual([
        {
          directoryKey: "dir-agent",
          label: "PwrAgent",
          path: "/repos/PwrAgent",
          reason: "mentions threads",
        },
        {
          directoryKey: "dir-snap",
          label: "PwrSnap",
          path: "/repos/PwrSnap",
          reason: "also takes shots",
        },
      ]);
    }
  });

  it("labels a multi-name request as a name match, not a recency fallback", async () => {
    generateStructuredObject.mockResolvedValue(ranked([]));

    const response = await dispatchStarMapIntake({
      requestId: "req-both",
      request: "Port the PwrSnap capture helper into PwrAgent",
    });

    expect(response.status).toBe("needs_disambiguation");
    if (response.status === "needs_disambiguation") {
      expect(response.candidateSource).toBe("label");
      expect(response.candidates.map((entry) => entry.directoryKey)).toEqual([
        "dir-agent",
        "dir-snap",
      ]);
    }
  });

  it("drops resolver candidates that name a directory outside the registry", async () => {
    generateStructuredObject.mockResolvedValue(
      ranked([
        { directoryKey: "dir-invented", confidence: 0.95 },
        { directoryKey: "dir-snap", confidence: 0.3 },
      ]),
    );

    const response = await dispatchStarMapIntake({
      requestId: "req-hallucinated",
      request: "Do a thing somewhere",
    });

    // The invented leader must not create a thread, and must not survive
    // into the list the operator picks from.
    expect(materializeDirectoryLaunchpad).not.toHaveBeenCalled();
    expect(response.status).toBe("needs_disambiguation");
    if (response.status === "needs_disambiguation") {
      expect(response.candidates.map((entry) => entry.directoryKey)).toEqual([
        "dir-snap",
      ]);
    }
  });

  it("gives the resolver each directory's current branch", async () => {
    generateStructuredObject.mockResolvedValue(
      ranked([{ directoryKey: "dir-agent", confidence: 0.9 }]),
    );

    await dispatchStarMapIntake({
      requestId: "req-branch",
      request: "Finish the icon work",
    });

    const prompt = generateStructuredObject.mock.calls[0]?.[0].prompt as string;
    expect(prompt).toContain("branch=feat/icons");
  });

  it("names the resolved project on the creating event", async () => {
    generateStructuredObject.mockResolvedValue(
      ranked([{ directoryKey: "dir-snap", confidence: 0.9 }]),
    );

    await dispatchStarMapIntake({
      requestId: "req-label",
      request: "Look into the screenshot issue",
    });

    const creating = publishLocalEvent.mock.calls
      .map(
        (call) =>
          (call as unknown as [{
            notification: {
              params: { phase: string; directoryLabel?: string };
            };
          }])[0].notification.params,
      )
      .find((params) => params.phase === "creating");
    expect(creating?.directoryLabel).toBe("PwrSnap");
  });

  it("honors a disambiguation resubmit without re-resolving", async () => {
    const response = await dispatchStarMapIntake({
      requestId: "req-4",
      request: "Do a thing somewhere",
      directoryKey: "dir-agent",
    });

    expect(response.status).toBe("created");
    expect(generateStructuredObject).not.toHaveBeenCalled();
  });

  it("reports creation failures with a failed status event", async () => {
    generateStructuredObject.mockResolvedValue(
      ranked([{ directoryKey: "dir-snap", confidence: 0.9 }]),
    );
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
    expect(readLocalNavigationDirectoryIndex).not.toHaveBeenCalled();
  });
});
