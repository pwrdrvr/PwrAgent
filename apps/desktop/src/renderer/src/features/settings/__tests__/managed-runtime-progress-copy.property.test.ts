import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  ManagedRuntimeId,
  ManagedRuntimeProgress,
} from "../../../../../shared/managed-runtime-progress";
import {
  managedRuntimeProgressCopy,
  managedRuntimeStatusLines,
} from "../managed-runtime-progress-copy";

// The strip used to add and drop rows as an install moved through its phases:
// the message vanished when the download started, the byte meter wrapped the
// step rail onto a second line once a rate arrived, the message came back at
// verify, and the track left at ready. In a bottom-anchored notice each of
// those moved the whole card.
//
// The rule, stated over the copy the strip renders: from `checking` to
// `ready`, every phase has a track and a step rail, and the status line shows
// either a line the strip reserves for that runtime from the first frame
// (`managedRuntimeStatusLines`) or the one-line byte meter. The rendered
// examples in managed-runtime-progress-layout.test.tsx check that the strip
// turns this copy into the same rows.

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
  waitingForIdle: fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
});

function phases(install: {
  runtime: ManagedRuntimeId;
  tag: string;
  downloads: Array<{ receivedBytes: number; totalBytes?: number; bytesPerSecond?: number }>;
}): ManagedRuntimeProgress[] {
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

describe("managed runtime progress copy", () => {
  it("keeps the track, the step rail, and a reserved status line from checking to ready", () => {
    fc.assert(
      fc.property(installArb, (install) => {
        const reserved = managedRuntimeStatusLines(install.runtime);
        phases(install).forEach((progress, index) => {
          const copy = managedRuntimeProgressCopy(
            progress,
            install.waitingForIdle[index % install.waitingForIdle.length] === true,
          );
          const at = progress.phase;
          expect(copy.tone === "busy" || copy.full, `track at ${at}`).toBe(true);
          expect(copy.steps?.length, `steps at ${at}`).toBe(4);
          if (copy.message === undefined) {
            expect(copy.meter, `meter at ${at}`).toBeDefined();
          } else {
            expect(reserved, `reserved line at ${at}`).toContain(copy.message);
          }
        });
      }),
      { numRuns: 60 },
    );
  });
});
