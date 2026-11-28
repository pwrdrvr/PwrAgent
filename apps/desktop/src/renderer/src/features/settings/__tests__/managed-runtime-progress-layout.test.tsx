import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ManagedRuntimeId,
  ManagedRuntimeProgress,
} from "../../../../../shared/managed-runtime-progress";
import {
  ManagedRuntimeProgressStrip,
  useManagedRuntimeProgress,
} from "../ManagedRuntimeProgress";

// The strip used to add and drop rows as an install moved through its phases:
// the message vanished when the download started, the byte meter wrapped the
// step rail onto a second line once a rate arrived, and the message came back
// at verify. In a bottom-anchored notice each of those moved the whole card.
//
// The rule, stated over what jsdom can see: from the first busy phase to the
// ready strip, the strip's rows are the same rows, and the status slot already
// holds every line it will show later. The slot is one grid cell sized by its
// tallest member, so a line it already holds cannot change its height.
//
// The property over every install lives on the pure copy in
// managed-runtime-progress-copy.property.test.ts; these are rendered examples
// of the same rule, one install per runtime.

afterEach(cleanup);

const RUNTIMES: ManagedRuntimeId[] = ["antigravity", "codex", "openai-codex", "grok", "git"];

const MB = 1024 * 1024;

/** One install per runtime: no total, then a rate, then a total, with
 *  `waitingForIdle` flipping on partway, as a Codex build that lands while
 *  turns run does. */
const DOWNLOADS = [
  { receivedBytes: 0 },
  { receivedBytes: 4.5 * MB, bytesPerSecond: 18 * MB },
  { receivedBytes: 41.2 * MB, totalBytes: 96 * MB, bytesPerSecond: 8.3 * MB },
];
const WAITING_FOR_IDLE = [false, false, false, false, false, true, false, true];

type Install = {
  runtime: ManagedRuntimeId;
  tag: string;
  downloads: Array<{ receivedBytes: number; totalBytes?: number; bytesPerSecond?: number }>;
};

function phases(install: Install): ManagedRuntimeProgress[] {
  const { runtime, tag } = install;
  return [
    { runtime, phase: "checking", updatedAt: 1 },
    ...install.downloads.map((download) => ({
      runtime,
      phase: "downloading" as const,
      tag,
      ...download,
      updatedAt: 2,
    })),
    { runtime, phase: "verifying", tag, updatedAt: 3 },
    { runtime, phase: "unpacking", tag, updatedAt: 4 },
    { runtime, phase: "activating", tag, updatedAt: 5 },
    { runtime, phase: "ready", tag, updatedAt: 6 },
  ];
}

type Layout = {
  rows: string[];
  /** Text the status slot shows now. */
  shown: string;
  /** Every text stacked in the status slot, visible or not. */
  held: string[];
  /** The slot holds a meter-styled line (the meter or its reserve). */
  holdsMeterLine: boolean;
};

function layout(container: HTMLElement): Layout {
  const strip = container.querySelector(".progress-strip");
  if (!strip) throw new Error("no strip rendered");
  const rows = [...strip.children].map((row) => row.className.split(" ")[0] ?? "");
  const slot = strip.querySelector(".progress-strip__status");
  const members = slot ? [...slot.children] : [];
  const visible = members.filter((member) => !member.classList.contains("progress-strip__reserve"));
  return {
    rows,
    shown: visible.map((member) => member.textContent ?? "").join("\n"),
    held: members
      .filter((member) => member.classList.contains("progress-strip__message"))
      .map((member) => member.textContent ?? ""),
    holdsMeterLine: members.some((member) => member.classList.contains("progress-strip__meter")),
  };
}

describe("managed runtime progress strip layout", () => {
  it.each(RUNTIMES)("keeps every row, and a slot that already holds each later line, for %s", (runtime) => {
    const steps = phases({ runtime, tag: "1.5.19", downloads: DOWNLOADS });
    const { container, rerender } = render(
      <ManagedRuntimeProgressStrip progress={steps[0]!} waitingForIdle={WAITING_FOR_IDLE[0]} />,
    );
    const seen: Layout[] = [];
    steps.forEach((progress, index) => {
      rerender(
        <ManagedRuntimeProgressStrip
          progress={progress}
          waitingForIdle={WAITING_FOR_IDLE[index % WAITING_FOR_IDLE.length]}
        />,
      );
      seen.push(layout(container));
    });

    const first = seen[0]!;
    for (const [index, current] of seen.entries()) {
      expect(current.rows, `rows at ${steps[index]!.phase}`).toEqual(first.rows);
      expect(current.holdsMeterLine).toBe(true);
      for (const later of seen.slice(index + 1)) {
        const isMeter = !later.held.includes(later.shown);
        if (isMeter) continue; // held by the meter line above
        expect(current.held, `${steps[index]!.phase} holds a later line`).toContain(later.shown);
      }
    }
  });
});

describe("useManagedRuntimeProgress", () => {
  function Probe(props: {
    api: Parameters<typeof useManagedRuntimeProgress>[0];
    runtime: ManagedRuntimeId;
    installing: boolean;
  }) {
    const current = useManagedRuntimeProgress(props.api, props.runtime, {
      installing: props.installing,
    });
    return <p data-testid="phase">{current?.phase ?? "none"}</p>;
  }

  function api() {
    let emit: (event: ManagedRuntimeProgress) => void = () => undefined;
    return {
      emit: (event: ManagedRuntimeProgress) => emit(event),
      value: {
        onManagedRuntimeProgress: (callback: (event: ManagedRuntimeProgress) => void) => {
          emit = callback;
          return () => undefined;
        },
        readManagedRuntimeProgress: async () => [],
      },
    };
  }

  it.each([
    { reportsChecking: false, priorReady: false },
    { reportsChecking: true, priorReady: false },
    { reportsChecking: false, priorReady: true },
    { reportsChecking: true, priorReady: true },
  ])(
    "shows a strip from the click to ready, and never for a check nobody asked to install (main reports checking: $reportsChecking, earlier ready strip: $priorReady)",
    async ({ reportsChecking, priorReady }) => {
      const runtime: ManagedRuntimeId = "antigravity";
      const host = api();
      const { getByTestId, rerender } = render(
        <Probe api={host.value} installing={false} runtime={runtime} />,
      );
      await act(async () => undefined);
      if (priorReady) {
        // A ready strip left from an earlier install, still lingering.
        act(() => host.emit({ runtime, phase: "ready", tag: "old", updatedAt: Date.now() - 1 }));
      }
      // A background check: never on screen.
      act(() => host.emit({ runtime, phase: "checking", updatedAt: Date.now() }));
      expect(getByTestId("phase")).toHaveTextContent("none");
      act(() => host.emit({ runtime, phase: "idle", updatedAt: Date.now() }));
      if (priorReady) {
        act(() => host.emit({ runtime, phase: "ready", tag: "old", updatedAt: Date.now() - 1 }));
      }

      // The operator clicks Install: a strip from that render on.
      await new Promise((resolve) => setTimeout(resolve, 2));
      rerender(<Probe api={host.value} installing runtime={runtime} />);
      expect(getByTestId("phase")).toHaveTextContent("checking");
      if (reportsChecking) {
        act(() => host.emit({ runtime, phase: "checking", updatedAt: Date.now() }));
        expect(getByTestId("phase")).toHaveTextContent("checking");
      }
      for (const phase of ["downloading", "verifying", "unpacking", "activating", "ready"] as const) {
        act(() => host.emit({ runtime, phase, tag: "new", updatedAt: Date.now() }));
        expect(getByTestId("phase")).toHaveTextContent(phase);
      }
      // The install's reply lands after ready: the ready strip stays.
      rerender(<Probe api={host.value} installing={false} runtime={runtime} />);
      expect(getByTestId("phase")).toHaveTextContent("ready");
    },
  );

  it("shows checking from another window when the runtime only checks to install", async () => {
    // PwrDrvr Git reports `checking` only as the first step of an install, so
    // a window that did not start it still shows it, and its buttons lock.
    const host = api();
    function GitProbe() {
      const current = useManagedRuntimeProgress(host.value, "git", { checkingStartsInstall: true });
      return <p data-testid="phase">{current?.phase ?? "none"}</p>;
    }
    const { getByTestId } = render(<GitProbe />);
    await act(async () => undefined);
    act(() => host.emit({ runtime: "git", phase: "checking", updatedAt: Date.now() }));
    expect(getByTestId("phase")).toHaveTextContent("checking");
  });

  it("hands back one starting object per install, so a memo on it holds", async () => {
    // A fresh object per render made AntigravityUpdateNotice rebuild its
    // notice every render, and the host's state update looped forever.
    const seen = new Set<unknown>();
    function Recorder(props: { installing: boolean; tick: number }) {
      const host = useMemo(() => api(), []);
      const current = useManagedRuntimeProgress(host.value, "antigravity", {
        installing: props.installing,
      });
      seen.add(current);
      return <p data-testid="tick">{props.tick}</p>;
    }
    const { rerender } = render(<Recorder installing tick={0} />);
    await act(async () => undefined);
    for (let tick = 1; tick < 5; tick += 1) rerender(<Recorder installing tick={tick} />);
    expect(seen.size).toBe(1);
  });
});
