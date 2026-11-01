import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  NavigationThreadSummary,
  PrSummary,
  ThreadPrAutoFixState,
  ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  buildWatchCiRequestText,
  canWatchPrCi,
  resolvePrChipWatch,
  resolveThreadAutoFixRepository,
  summarizeThreadPrWatches,
  ThreadPrWatchIndicatorsContext,
  useThreadPrWatches,
  useThreadPrWatchIndicators,
} from "../useThreadPrWatchIndicators";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ciWatch: ThreadPullRequestWatchSummary = {
  watchId: "watch-ci",
  backend: "codex",
  threadId: "consumer",
  prKey: "github.com/pwrdrvr/pwragent#3174",
  prUrl: "https://github.com/pwrdrvr/PwrAgent/pull/3174",
  prNumber: 3174,
  headSha: "9f2c41a0000000000000000000000000000000000",
  notifyOn: ["success", "failure"],
  createdAt: 10,
  failureHandledByAutoFix: false,
  kind: "checks",
  baseline: { outcome: "failure", observedAt: 9, runAttempt: 2 },
};
const terminalWatch: ThreadPullRequestWatchSummary = {
  ...ciWatch,
  watchId: "watch-merge",
  notifyOn: ["merged", "closed"],
  createdAt: 5,
  kind: "terminal",
  baseline: undefined,
};
const pr: PrSummary = {
  provider: "github.com",
  number: 3174,
  org: "pwrdrvr",
  repo: "PwrAgent",
  state: "failing",
  checkState: "failing",
  lifecycleState: "open",
  url: "https://github.com/pwrdrvr/PwrAgent/pull/3174",
};
const thread: NavigationThreadSummary = {
  id: "consumer", source: "codex", title: "Fix CI", titleSource: "explicit",
  linkedDirectories: [], inbox: { inInbox: false },
};
const update = {
  backend: "codex",
  notification: { method: "thread/prWatches/updated", params: { backend: "codex", threadId: "consumer" } },
} as AgentEvent;

describe("summarizeThreadPrWatches", () => {
  it("groups by thread, oldest first, and folds a PR's watches into one chip entry", () => {
    const summary = summarizeThreadPrWatches([ciWatch, terminalWatch]).get("codex:consumer");
    expect(summary?.watches.map((watch) => watch.watchId)).toEqual(["watch-merge", "watch-ci"]);
    expect(summary?.byPrKey.get(ciWatch.prKey)).toEqual({
      ci: { runAttempt: 2, createdAt: 10, notifyOn: ["success", "failure"] },
      terminal: { createdAt: 5 },
    });
  });

  it("keeps a re-run's attempt once the baseline clears, preferring the watch's own copy", () => {
    // The baseline clears as soon as checks run; the attempt must outlive it.
    const running = { ...ciWatch, baseline: undefined, runAttempt: 3 };
    expect(summarizeThreadPrWatches([running]).get("codex:consumer")?.byPrKey.get(ciWatch.prKey))
      .toMatchObject({ ci: { runAttempt: 3 } });
    // Rows written before the top-level field carry it on the baseline only.
    expect(summarizeThreadPrWatches([{ ...ciWatch, runAttempt: 4 }]).get("codex:consumer")
      ?.byPrKey.get(ciWatch.prKey)).toMatchObject({ ci: { runAttempt: 4 } });
  });

  it("gives a thread with only Auto-fix states an entry", () => {
    const state: ThreadPrAutoFixState = {
      backend: "codex", threadId: "consumer", prKey: ciWatch.prKey, state: "paused",
    };
    const summary = summarizeThreadPrWatches([], [state]).get("codex:consumer");
    expect(summary?.watches).toEqual([]);
    expect(summary?.autoFixByPrKey?.get(ciWatch.prKey)).toBe(state);
    // An owner that sends no projection leaves it absent.
    expect(summarizeThreadPrWatches([ciWatch]).get("codex:consumer")).not.toHaveProperty("autoFixByPrKey");
  });

  it("treats a row written before kinds existed as a CI watch", () => {
    const legacy = { ...ciWatch, kind: undefined, baseline: undefined };
    expect(summarizeThreadPrWatches([legacy]).get("codex:consumer")?.byPrKey.get(ciWatch.prKey))
      .toEqual({ ci: { createdAt: 10, notifyOn: ["success", "failure"] } });
  });
});

const REPOSITORY = "github.com/pwrdrvr/pwragent";

describe("resolvePrChipWatch", () => {
  it("adds Auto-fix to an open PR and keeps one object per entry", () => {
    const watches = summarizeThreadPrWatches([ciWatch]).get("codex:consumer");
    const first = resolvePrChipWatch(watches, pr, REPOSITORY);
    expect(first).toMatchObject({ ci: { runAttempt: 2 }, autoFix: true });
    expect(resolvePrChipWatch(watches, { ...pr }, REPOSITORY)).toBe(first);
    expect(resolvePrChipWatch(watches, pr, undefined)).toBe(watches?.byPrKey.get(ciWatch.prKey));
    expect(resolvePrChipWatch(undefined, pr, REPOSITORY)).toBe(resolvePrChipWatch(undefined, pr, REPOSITORY));
    expect(resolvePrChipWatch(undefined, { ...pr, lifecycleState: "merged" }, REPOSITORY)).toBeUndefined();
    expect(resolvePrChipWatch(undefined, pr, undefined)).toBeUndefined();
  });

  it("says why Auto-fix will not wake the thread when main projects it paused or elsewhere", () => {
    const paused: ThreadPrAutoFixState = {
      backend: "codex", threadId: "consumer", prKey: ciWatch.prKey, state: "paused",
    };
    const pausedWatches = summarizeThreadPrWatches([ciWatch], [paused]).get("codex:consumer");
    const blocked = resolvePrChipWatch(pausedWatches, pr, REPOSITORY);
    expect(blocked).toMatchObject({ ci: { runAttempt: 2 }, autoFixBlocked: { reason: "paused" } });
    expect(blocked).not.toHaveProperty("autoFix");
    expect(resolvePrChipWatch(pausedWatches, { ...pr }, REPOSITORY)).toBe(blocked);

    const elsewhere: ThreadPrAutoFixState = {
      ...paused, state: "handled_by_other_thread",
      handledBy: { backend: "codex", threadId: "owner", title: "Owns the repairs" },
    };
    expect(resolvePrChipWatch(summarizeThreadPrWatches([], [elsewhere]).get("codex:consumer"), pr, REPOSITORY))
      .toEqual({ autoFixBlocked: { reason: "handled_by_other_thread", threadTitle: "Owns the repairs" } });
    const active: ThreadPrAutoFixState = { ...paused, state: "active" };
    expect(resolvePrChipWatch(summarizeThreadPrWatches([], [active]).get("codex:consumer"), pr, REPOSITORY))
      .toEqual({ autoFix: true });
  });

  it("claims no Auto-fix for a PR outside the primary workspace's repository", () => {
    // Main repairs primary-workspace PRs only; a linked directory's PR is not polled for it.
    const linked = { ...pr, repo: "docs.pwragent.ai", url: "https://github.com/pwrdrvr/docs.pwragent.ai/pull/1" };
    expect(resolvePrChipWatch(undefined, linked, REPOSITORY)).toBeUndefined();
  });
});

describe("resolveThreadAutoFixRepository", () => {
  const optedIn = { ...thread, prAutoDispatchEnabled: true, primaryGitRepository: REPOSITORY };

  it("names the primary repository only while the thread opted in and Git settings allow Auto-fix", () => {
    expect(resolveThreadAutoFixRepository(optedIn, true)).toBe(REPOSITORY);
    expect(resolveThreadAutoFixRepository(optedIn, undefined)).toBe(REPOSITORY);
    // Turned off in Git settings, or polling paused: main dispatches nothing.
    expect(resolveThreadAutoFixRepository(optedIn, false)).toBeUndefined();
    expect(resolveThreadAutoFixRepository({ ...optedIn, prAutoDispatchEnabled: false }, true)).toBeUndefined();
    expect(resolveThreadAutoFixRepository({ ...optedIn, primaryGitRepository: undefined }, true)).toBeUndefined();
  });

  it("does not apply this instance's settings to a peer's thread", () => {
    const peer = {
      ...optedIn,
      federation: {
        ref: { backend: "codex", target: { scope: "remote", instanceId: "peer" }, threadId: "consumer" },
        instanceLabel: "Laptop", peerStatus: "connected", capabilities: [],
      },
    } as NavigationThreadSummary;
    expect(resolveThreadAutoFixRepository(peer, false)).toBe(REPOSITORY);
  });
});

describe("useThreadPrWatchIndicators", () => {
  function apiWith(manage: DesktopApi["manageThreadPrWatches"]) {
    let listener: ((event: AgentEvent) => void) | undefined;
    const api = {
      manageThreadPrWatches: manage,
      onAgentEvent: (callback: (event: AgentEvent) => void) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    } as unknown as DesktopApi;
    return { api, emit: (event: AgentEvent) => listener!(event) };
  }

  function Probe(props: { api: DesktopApi }) {
    const indicators = useThreadPrWatchIndicators(props.api);
    return <output>{indicators.get("codex:consumer")?.watches.length ?? "none"}</output>;
  }

  it("lists active watches once, then refreshes once per burst of updates", async () => {
    vi.useFakeTimers();
    let current = [ciWatch];
    const manage = vi.fn(async () => ({ ok: true as const, active: current }));
    const { api, emit } = apiWith(manage);
    render(<Probe api={api} />);
    await act(async () => {});
    expect(manage).toHaveBeenCalledWith({ action: "active" });
    expect(screen.getByRole("status")).toHaveTextContent("1");

    current = [];
    act(() => emit(update));
    act(() => emit(update));
    act(() => emit({ backend: "codex", notification: { method: "turn/started", params: {} } } as unknown as AgentEvent));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(manage).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("none");
  });

  it("keeps the same map, and the same thread entry, when an update changes nothing", async () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    function Identity(props: { api: DesktopApi }) {
      const indicators = useThreadPrWatchIndicators(props.api);
      if (seen.at(-1) !== indicators) seen.push(indicators);
      return null;
    }
    const other = { ...ciWatch, watchId: "watch-other", threadId: "other" };
    let current = [ciWatch];
    const manage = vi.fn(async () => ({ ok: true as const, active: current.map((watch) => ({ ...watch })) }));
    const { api, emit } = apiWith(manage);
    render(<Identity api={api} />);
    await act(async () => {});
    expect(seen).toHaveLength(2);
    const entry = (seen[1] as ReadonlyMap<string, unknown>).get("codex:consumer");

    act(() => emit(update));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(manage).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(2);

    // Another thread's watch changes the map but not this thread's entry.
    current = [ciWatch, other];
    act(() => emit(update));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(seen).toHaveLength(3);
    expect((seen[2] as ReadonlyMap<string, unknown>).get("codex:consumer")).toBe(entry);
  });

  it("keeps the last list when a refresh fails or is refused", async () => {
    vi.useFakeTimers();
    const manage = vi.fn()
      .mockResolvedValueOnce({ ok: true, active: [ciWatch] })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: false, error: { code: "federation_unsupported", message: "no" } });
    const { api, emit } = apiWith(manage);
    render(<Probe api={api} />);
    await act(async () => {});
    for (let index = 0; index < 2; index++) {
      act(() => emit(update));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
    }
    expect(manage).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("status")).toHaveTextContent("1");
  });

  it("ignores a peer's update events", async () => {
    vi.useFakeTimers();
    const manage = vi.fn(async () => ({ ok: true as const, active: [] }));
    const { api, emit } = apiWith(manage);
    render(<Probe api={api} />);
    await act(async () => {});
    act(() => emit({ ...update, federationTarget: { scope: "remote", instanceId: "peer" } } as AgentEvent));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(manage).toHaveBeenCalledTimes(1);
  });
});

describe("useThreadPrWatches", () => {
  function Reader(props: { thread: NavigationThreadSummary }) {
    const watches = useThreadPrWatches(props.thread);
    return <output>{watches?.watches.length ?? "none"}</output>;
  }

  it("reads a local thread's watches and none for a peer's thread", () => {
    const value = { byThreadKey: summarizeThreadPrWatches([ciWatch]) };
    render(
      <ThreadPrWatchIndicatorsContext.Provider value={value}>
        <Reader thread={thread} />
      </ThreadPrWatchIndicatorsContext.Provider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("1");
    cleanup();
    render(
      <ThreadPrWatchIndicatorsContext.Provider value={value}>
        <Reader thread={{
          ...thread,
          federation: {
            ref: { backend: "codex", target: { scope: "remote", instanceId: "peer" }, threadId: "consumer" },
            instanceLabel: "Laptop", peerStatus: "connected", capabilities: [],
          },
        } as NavigationThreadSummary} />
      </ThreadPrWatchIndicatorsContext.Provider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("none");
  });
});

describe("buildWatchCiRequestText", () => {
  it("asks for a pass-or-fail wake in plain words", () => {
    expect(buildWatchCiRequestText(pr)).toBe(
      "Watch CI on #3174 and wake this thread when it finishes, pass or fail.",
    );
  });
});

describe("canWatchPrCi", () => {
  it("allows only an open PR on the thread's primary repository, the kind main watches", () => {
    expect(canWatchPrCi({ primaryGitRepository: REPOSITORY }, pr)).toBe(true);
    expect(canWatchPrCi({ primaryGitRepository: undefined }, pr)).toBe(false);
    const linked = { ...pr, repo: "docs.pwragent.ai", url: "https://github.com/pwrdrvr/docs.pwragent.ai/pull/1" };
    expect(canWatchPrCi({ primaryGitRepository: REPOSITORY }, linked)).toBe(false);
    expect(canWatchPrCi(
      { primaryGitRepository: REPOSITORY },
      { ...pr, lifecycleState: "merged", state: "merged" },
    )).toBe(false);
  });
});
