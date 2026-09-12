import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationDirectoryRow } from "@pwragent/shared";

const generateStructuredObject = vi.fn();
const ensureDirectoryLaunchpad = vi.fn();
const materializeDirectoryLaunchpad = vi.fn();
const publishLocalEvent = vi.fn(async () => undefined);
/**
 * Defaults to `undefined` — "no backend here can run an agent turn" — so every
 * test below that does not set it exercises the deterministic fallback. That
 * is deliberate: the fallback is still the path for a machine with no Codex
 * backend, and it is the one the agent tests would otherwise stop covering.
 */
const runStarMapIntakeAgentTurn = vi.fn();
const readLocalNavigationDirectoryIndex = vi.hoisted(() => vi.fn());

vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => ({
    ensureDirectoryLaunchpad,
    generateStructuredObject,
    materializeDirectoryLaunchpad,
    publishLocalEvent,
    runStarMapIntakeAgentTurn,
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
  runStarMapIntakeAgentTurn.mockResolvedValue(undefined);
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

  it("ranks by reported confidence rather than the resolver's array order", async () => {
    // The prompt asks for most-likely-first and nothing enforces it, so a
    // strong pick emitted second must still create the thread.
    generateStructuredObject.mockResolvedValue(
      ranked([
        { directoryKey: "dir-snap", confidence: 0.3 },
        { directoryKey: "dir-agent", confidence: 0.92 },
      ]),
    );

    const response = await dispatchStarMapIntake({
      requestId: "req-unsorted",
      request: "Fix the thread list",
    });

    expect(response.status).toBe("created");
    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({ directoryKey: "dir-agent" }),
      expect.anything(),
    );
  });

  it("orders a low-confidence disambiguation list by confidence", async () => {
    generateStructuredObject.mockResolvedValue(
      ranked([
        { directoryKey: "dir-snap", confidence: 0.1 },
        { directoryKey: "dir-agent", confidence: 0.4 },
      ]),
    );

    const response = await dispatchStarMapIntake({
      requestId: "req-unsorted-low",
      request: "Do something",
    });

    expect(response.status).toBe("needs_disambiguation");
    if (response.status === "needs_disambiguation") {
      expect(response.candidates.map((entry) => entry.directoryKey)).toEqual([
        "dir-agent",
        "dir-snap",
      ]);
    }
  });

  it("separates a resolver that could not run from one that pointed nowhere", async () => {
    generateStructuredObject.mockResolvedValue({
      status: "unavailable",
      reason: "codex_structured_generation_unavailable",
    });

    const response = await dispatchStarMapIntake({
      requestId: "req-unresolved",
      request: "Do a thing somewhere",
    });

    expect(response.status).toBe("needs_disambiguation");
    if (response.status === "needs_disambiguation") {
      // Not "recent": nothing judged that no project matched.
      expect(response.candidateSource).toBe("unresolved");
    }
  });

  it("truncates an overlong reason on a character boundary", async () => {
    const reason = `${"x".repeat(119)}🛰️ trailing`;
    generateStructuredObject.mockResolvedValue(
      ranked([{ directoryKey: "dir-snap", confidence: 0.2, reason }]),
    );

    const response = await dispatchStarMapIntake({
      requestId: "req-long-reason",
      request: "Do a thing somewhere",
    });

    expect(response.status).toBe("needs_disambiguation");
    if (response.status === "needs_disambiguation") {
      const truncated = response.candidates[0]?.reason ?? "";
      expect([...truncated]).toHaveLength(120);
      // A code-unit slice would leave the high half of the surrogate pair.
      expect(truncated).not.toMatch(/[\uD800-\uDBFF]$/u);
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

  it("gives the resolver a longer answering budget than the protocol round-trips", async () => {
    generateStructuredObject.mockResolvedValue(
      ranked([{ directoryKey: "dir-agent", confidence: 0.9 }]),
    );

    await dispatchStarMapIntake({
      requestId: "req-budget",
      request: "Fix the thread list",
    });

    const call = generateStructuredObject.mock.calls[0]?.[0] as {
      timeoutMs: number;
      turnTimeoutMs: number;
    };
    // One number for both would make a wedged server's cleanup — which runs
    // on the timeout path — as slow as the thinking budget is generous.
    expect(call.turnTimeoutMs).toBeGreaterThan(call.timeoutMs);
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

  it("names the real problem when no projects are registered", async () => {
    readLocalNavigationDirectoryIndex.mockResolvedValue([]);

    const response = await dispatchStarMapIntake({
      requestId: "req-empty-registry",
      request: "Do a thing",
    });

    // Not a candidate list with no rows: a heading promising options above
    // nothing is a dead end with no way forward.
    expect(response.status).toBe("failed");
    if (response.status === "failed") {
      expect(response.error).toContain("No projects are registered");
    }
    expect(generateStructuredObject).not.toHaveBeenCalled();
  });

  it("caps how many directories reach the resolver prompt", async () => {
    readLocalNavigationDirectoryIndex.mockResolvedValue(
      Array.from({ length: 200 }, (_unused, index) =>
        directory(`dir-${index}`, `Project${index}`, {
          latestUpdatedAt: index,
        }),
      ),
    );
    generateStructuredObject.mockResolvedValue(
      ranked([{ directoryKey: "dir-199", confidence: 0.9 }]),
    );

    await dispatchStarMapIntake({
      requestId: "req-many",
      request: "Do a thing",
    });

    const prompt = generateStructuredObject.mock.calls[0]?.[0].prompt as string;
    const listed = prompt.match(/^- key=/gmu)?.length ?? 0;
    expect(listed).toBeLessThanOrEqual(80);
    // Most recently active survive the cut; the oldest do not.
    expect(prompt).toContain("key=dir-199");
    expect(prompt).not.toContain("key=dir-0 ");
    expect(prompt).toContain("less recently active directories omitted");
  });

  it("asks rather than letting a lone label match overrule the resolver", async () => {
    generateStructuredObject.mockResolvedValue(
      ranked([{ directoryKey: "dir-agent", confidence: 0.45 }]),
    );

    // "PwrSnap" appears literally, but the resolver ranked PwrAgent first.
    const response = await dispatchStarMapIntake({
      requestId: "req-disagree",
      request: "Port the PwrSnap helper",
    });

    expect(materializeDirectoryLaunchpad).not.toHaveBeenCalled();
    expect(response.status).toBe("needs_disambiguation");
  });

  it("still short-circuits when a lone label match is the resolver's pick", async () => {
    generateStructuredObject.mockResolvedValue(
      ranked([{ directoryKey: "dir-snap", confidence: 0.45 }]),
    );

    const response = await dispatchStarMapIntake({
      requestId: "req-agree",
      request: "Port the PwrSnap helper",
    });

    expect(response.status).toBe("created");
    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({ directoryKey: "dir-snap" }),
      expect.anything(),
    );
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

/**
 * The agent path, which is what an instance with a Codex backend actually
 * runs. `runStarMapIntakeAgentTurn` stands in for the turn: these assert what
 * `dispatchStarMapIntake` does with each outcome the turn can produce, not
 * that a model produces the right one.
 */
describe("dispatchStarMapIntake via the intake agent", () => {
  /** The reported case: one thread, and the relay sentence never reaches it. */
  it("returns the thread the agent created and never resolves a project itself", async () => {
    runStarMapIntakeAgentTurn.mockResolvedValue({
      status: "ok",
      outcome: { kind: "created", backend: "codex", threadId: "thread-donut" },
    });

    const response = await dispatchStarMapIntake({
      requestId: "req-agent-1",
      request:
        "Make a thread in the PwrAgnt project and ask it to make the donuts.",
    });

    expect(response).toEqual({
      status: "created",
      requestId: "req-agent-1",
      backend: "codex",
      threadId: "thread-donut",
    });
    // Exactly one thread: the agent made it, and nothing here made a second.
    expect(materializeDirectoryLaunchpad).not.toHaveBeenCalled();
    // The deterministic classifier is a fallback now, not a first step.
    expect(generateStructuredObject).not.toHaveBeenCalled();
  });

  it("passes the agent's ranking and extracted payload to the dialog", async () => {
    runStarMapIntakeAgentTurn.mockResolvedValue({
      status: "ok",
      outcome: {
        kind: "needs_disambiguation",
        candidates: [{ directoryKey: "dir-agent", reason: "recent icon work" }],
        input: "Make the donuts.",
      },
    });

    const response = await dispatchStarMapIntake({
      requestId: "req-agent-2",
      request: "Make a thread and ask it to make the donuts.",
    });

    expect(response).toMatchObject({
      status: "needs_disambiguation",
      candidateSource: "resolver",
      candidates: [
        expect.objectContaining({
          directoryKey: "dir-agent",
          label: "PwrAgent",
          reason: "recent icon work",
        }),
      ],
      input: "Make the donuts.",
    });
    expect(generateStructuredObject).not.toHaveBeenCalled();
  });

  /**
   * An ask naming nothing usable still asked. Recency is the honest source for
   * the list it gets shown, the same thing the deterministic path says when
   * its resolver ran and pointed nowhere — "closest match first" over a
   * recency ordering would claim a judgment nobody made.
   */
  it("falls back to recency when the agent asked with no usable candidate", async () => {
    runStarMapIntakeAgentTurn.mockResolvedValue({
      status: "ok",
      outcome: { kind: "needs_disambiguation", candidates: [] },
    });

    const response = await dispatchStarMapIntake({
      requestId: "req-agent-3",
      request: "Fix the thing",
    });

    expect(response).toMatchObject({
      status: "needs_disambiguation",
      candidateSource: "recent",
    });
    expect(
      response.status === "needs_disambiguation"
        ? response.candidates.map((candidate) => candidate.directoryKey)
        : [],
    ).toEqual(["dir-agent", "dir-snap"]);
  });

  /**
   * The operator's answer to "which project?". The agent already separated the
   * task from the instruction when it asked, so the pick creates the thread
   * directly — one agent turn per intake, however many times it has to ask.
   */
  it("creates with the carried payload when the operator picks a project", async () => {
    const response = await dispatchStarMapIntake({
      requestId: "req-agent-4",
      request:
        "Make a thread in the PwrAgnt project and ask it to make the donuts.",
      directoryKey: "dir-agent",
      input: "Make the donuts.",
    });

    expect(response).toMatchObject({ status: "created" });
    expect(runStarMapIntakeAgentTurn).not.toHaveBeenCalled();
    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        directoryKey: "dir-agent",
        input: [{ type: "text", text: "Make the donuts." }],
      }),
      expect.anything(),
    );
  });

  /**
   * The negative control, at the seam this owns. An ordinary work request that
   * merely mentions threads carries no instruction to strip, so the agent
   * passes it through and it reaches the thread unchanged. (What keeps the
   * model from stripping it anyway is the system prompt, asserted in
   * star-map-intake-agent.test.ts.)
   */
  it("sends an ordinary request that merely mentions threads through unchanged", async () => {
    const request = "Write a feature that creates threads from a template";

    const response = await dispatchStarMapIntake({
      requestId: "req-agent-5",
      request,
      directoryKey: "dir-agent",
      input: request,
    });

    expect(response).toMatchObject({ status: "created" });
    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({ input: [{ type: "text", text: request }] }),
      expect.anything(),
    );
  });

  it("ignores a carried payload without a project, so it cannot skip the agent", async () => {
    runStarMapIntakeAgentTurn.mockResolvedValue({
      status: "ok",
      outcome: { kind: "created", backend: "codex", threadId: "thread-donut" },
    });

    await dispatchStarMapIntake({
      requestId: "req-agent-6",
      request: "Make a thread and ask it to make the donuts.",
      input: "Make the donuts.",
    });

    expect(runStarMapIntakeAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Make a thread and ask it to make the donuts.",
      }),
    );
  });

  it("falls back to the deterministic resolver when the agent turn fails", async () => {
    runStarMapIntakeAgentTurn.mockResolvedValue({
      status: "failed",
      reason: "codex_title_turn_timeout",
    });
    generateStructuredObject.mockResolvedValue(
      ranked([{ directoryKey: "dir-snap", confidence: 0.9 }]),
    );

    const response = await dispatchStarMapIntake({
      requestId: "req-agent-7",
      request: "Look into the screenshot issue in PwrSnap",
    });

    expect(response).toMatchObject({ status: "created" });
    expect(generateStructuredObject).toHaveBeenCalled();
    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({ directoryKey: "dir-snap" }),
      expect.anything(),
    );
  });

  it("falls back when the agent turn throws", async () => {
    runStarMapIntakeAgentTurn.mockRejectedValue(new Error("client closed"));
    generateStructuredObject.mockResolvedValue(
      ranked([{ directoryKey: "dir-snap", confidence: 0.9 }]),
    );

    const response = await dispatchStarMapIntake({
      requestId: "req-agent-8",
      request: "Look into the screenshot issue in PwrSnap",
    });

    expect(response).toMatchObject({ status: "created" });
    expect(generateStructuredObject).toHaveBeenCalled();
  });

  /**
   * A turn that created the thread and then timed out has still created the
   * thread. Reporting that as a failure would send the fallback on to create
   * a second one, which is the one outcome a single intake must never have.
   */
  it("keeps a thread the agent created even when the turn reports ok with an outcome after trouble", async () => {
    runStarMapIntakeAgentTurn.mockResolvedValue({
      status: "ok",
      outcome: { kind: "created", backend: "codex", threadId: "thread-late" },
    });

    const response = await dispatchStarMapIntake({
      requestId: "req-agent-9",
      request: "Make the donuts in PwrAgent",
    });

    expect(response).toMatchObject({ threadId: "thread-late" });
    expect(materializeDirectoryLaunchpad).not.toHaveBeenCalled();
  });

  it("never runs the agent when no project is registered", async () => {
    readLocalNavigationDirectoryIndex.mockResolvedValue([]);

    const response = await dispatchStarMapIntake({
      requestId: "req-agent-10",
      request: "Make the donuts",
    });

    expect(response).toMatchObject({
      status: "failed",
      error: "No projects are registered on this instance. Add a directory first.",
    });
    expect(runStarMapIntakeAgentTurn).not.toHaveBeenCalled();
  });
});

describe("dispatchStarMapIntake payload carrying", () => {
  /**
   * The payload was extracted for the project the operator picked. When that
   * project is gone by the time they answer, the pick is discarded and the
   * fallback resolves somewhere else — the payload must not ride along to it.
   */
  it("drops a carried payload when the picked project no longer exists", async () => {
    generateStructuredObject.mockResolvedValue(
      ranked([{ directoryKey: "dir-snap", confidence: 0.9 }]),
    );

    const response = await dispatchStarMapIntake({
      requestId: "req-stale",
      request: "Make a thread in the gone project and ask it to make the donuts.",
      directoryKey: "dir-removed",
      input: "Make the donuts.",
    });

    expect(response).toMatchObject({ status: "created" });
    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        directoryKey: "dir-snap",
        input: [
          {
            type: "text",
            text: "Make a thread in the gone project and ask it to make the donuts.",
          },
        ],
      }),
      expect.anything(),
    );
  });

  it("keeps the operator's request when the pick carried no payload", async () => {
    const response = await dispatchStarMapIntake({
      requestId: "req-no-payload",
      request: "Fix the recorder crash",
      directoryKey: "dir-agent",
    });

    expect(response).toMatchObject({ status: "created" });
    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [{ type: "text", text: "Fix the recorder crash" }],
      }),
      expect.anything(),
    );
  });
});
