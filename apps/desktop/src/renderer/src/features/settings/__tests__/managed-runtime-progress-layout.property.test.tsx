import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useMemo } from "react";
import fc from "fast-check";
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

afterEach(cleanup);

const RUNTIMES: ManagedRuntimeId[] = ["antigravity", "codex", "openai-codex", "grok", "git"];

const downloadArb = fc.record({
  receivedBytes: fc.integer({ min: 0, max: 900 * 1024 * 1024 }),
  totalBytes: fc.option(fc.integer({ min: 1, max: 900 * 1024 * 1024 }), { nil: undefined }),
  bytesPerSecond: fc.option(fc.integer({ min: 1, max: 90 * 1024 * 1024 }), { nil: undefined }),
});

/** One install as main reports it: checking, a run of byte reports, the
 *  remaining steps, and the ready strip. Each step may or may not wait for idle. */
const installArb = fc.record({
  runtime: fc.constantFrom(...RUNTIMES),
  tag: fc.constantFrom("1.5.19", "v0.128.0-pwrdrvr.3", "v2.53.0.pwrdrvr.1"),
  downloads: fc.array(downloadArb, { minLength: 1, maxLength: 6, size: "max" }),
  waitingForIdle: fc.array(fc.boolean(), { minLength: 32, maxLength: 32 }),
});

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
  const strip = container.querySelector(".managed-progress");
  if (!strip) throw new Error("no strip rendered");
  const rows = [...strip.children].map((row) => row.className.split(" ")[0] ?? "");
  const slot = strip.querySelector(".managed-progress__status");
  const members = slot ? [...slot.children] : [];
  const visible = members.filter((member) => !member.classList.contains("managed-progress__reserve"));
  return {
    rows,
    shown: visible.map((member) => member.textContent ?? "").join("\n"),
    held: members
      .filter((member) => member.classList.contains("managed-progress__message"))
      .map((member) => member.textContent ?? ""),
    holdsMeterLine: members.some((member) => member.classList.contains("managed-progress__meter")),
  };
}

describe("managed runtime progress strip layout", () => {
  it("keeps every row, and a slot that already holds each later line, from checking to ready", () => {
    fc.assert(
      fc.property(installArb, (install) => {
        const steps = phases(install);
        const { container, rerender } = render(
          <ManagedRuntimeProgressStrip
            progress={steps[0]!}
            waitingForIdle={install.waitingForIdle[0]}
          />,
        );
        const seen: Layout[] = [];
        steps.forEach((progress, index) => {
          rerender(
            <ManagedRuntimeProgressStrip
              progress={progress}
              waitingForIdle={install.waitingForIdle[index % 32]}
            />,
          );
          seen.push(layout(container));
        });
        cleanup();

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
      }),
      { numRuns: 60 },
    );
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

  it("shows a strip from the click to ready, and never for a check nobody asked to install", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...RUNTIMES),
        fc.boolean(),
        fc.boolean(),
        async (runtime, reportsChecking, priorReady) => {
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
          cleanup();
        },
      ),
      { numRuns: 24 },
    );
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
