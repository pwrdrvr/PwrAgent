import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CodexEnvironmentActionRun } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvActionAnchorEntry, formatDurationMs } from "../Composer";

afterEach(() => {
  cleanup();
});

function buildRun(
  overrides: Partial<CodexEnvironmentActionRun> = {},
): CodexEnvironmentActionRun {
  return {
    runId: overrides.runId ?? "run-1",
    actionId: overrides.actionId ?? "test",
    actionName: overrides.actionName ?? "Test",
    command: overrides.command ?? "pnpm test",
    status: overrides.status ?? "started",
    startedAt: overrides.startedAt ?? 1_700_000_000_000,
    pid: overrides.pid,
    exitedAt: overrides.exitedAt,
    exitCode: overrides.exitCode,
    exitSignal: overrides.exitSignal,
    durationMs: overrides.durationMs,
    output: overrides.output,
  };
}

describe("EnvActionAnchorEntry", () => {
  describe("status branches", () => {
    it("renders the running label with always-visible Dismiss while started", () => {
      render(
        <EnvActionAnchorEntry
          run={buildRun({ status: "started", pid: 12345 })}
          environmentName="PwrAgnt"
          onDismiss={() => {}}
        />,
      );
      expect(
        screen.getByLabelText("Env action running"),
      ).toBeInTheDocument();
      // Dismiss is always available now, regardless of status — a
      // long-running action that the user no longer cares about
      // should be clearable without having to wait for it to exit.
      expect(
        screen.getByRole("button", { name: "Dismiss" }),
      ).toBeInTheDocument();
      // The pid meta and the command echo land in the same anchor.
      expect(screen.getByText(/pid 12345/)).toBeInTheDocument();
      expect(screen.getByText(/\$ pnpm test/)).toBeInTheDocument();
    });

    it("renders the exited label with exit code + duration meta and shows Dismiss", () => {
      render(
        <EnvActionAnchorEntry
          run={buildRun({
            status: "exited",
            exitCode: 0,
            durationMs: 4_321,
            output: "build done\nready",
          })}
          environmentName={undefined}
          onDismiss={() => {}}
        />,
      );
      expect(
        screen.getByLabelText("Env action exited"),
      ).toBeInTheDocument();
      expect(screen.getByText(/exit 0/)).toBeInTheDocument();
      // Duration formatter rounds to integer seconds (4321ms → 4s).
      expect(screen.getByText(/ran 4s/)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Dismiss" }),
      ).toBeInTheDocument();
      // Output is rendered inside the collapsible <details>.
      expect(screen.getByText(/build done/)).toBeInTheDocument();
    });

    it("renders the failed label and surfaces a non-zero exit code", () => {
      render(
        <EnvActionAnchorEntry
          run={buildRun({
            status: "failed",
            exitCode: 1,
            durationMs: 750,
            output: "ERR_PNPM_IGNORED_BUILDS",
          })}
          environmentName="PwrAgnt"
          onDismiss={() => {}}
        />,
      );
      expect(
        screen.getByLabelText("Env action failed"),
      ).toBeInTheDocument();
      expect(screen.getByText(/exit 1/)).toBeInTheDocument();
      expect(
        screen.getByText(/ERR_PNPM_IGNORED_BUILDS/),
      ).toBeInTheDocument();
      // Sub-second durations format in ms.
      expect(screen.getByText(/ran 750ms/)).toBeInTheDocument();
    });

    it("falls back to signal meta when exit code is undefined", () => {
      render(
        <EnvActionAnchorEntry
          run={buildRun({
            status: "failed",
            exitCode: undefined,
            exitSignal: "SIGTERM",
          })}
          environmentName={undefined}
          onDismiss={() => {}}
        />,
      );
      expect(screen.getByText(/signal SIGTERM/)).toBeInTheDocument();
      expect(screen.queryByText(/exit /)).toBeNull();
    });
  });

  describe("output placeholders", () => {
    it("shows the waiting-for-output placeholder while running with no output", () => {
      render(
        <EnvActionAnchorEntry
          run={buildRun({ status: "started", output: undefined })}
          environmentName={undefined}
          onDismiss={() => {}}
        />,
      );
      expect(
        screen.getByText(/no output yet — waiting for the command/),
      ).toBeInTheDocument();
    });

    it("shows the captured-empty placeholder after exit with no output", () => {
      render(
        <EnvActionAnchorEntry
          run={buildRun({
            status: "exited",
            exitCode: 0,
            output: undefined,
          })}
          environmentName={undefined}
          onDismiss={() => {}}
        />,
      );
      expect(
        screen.getByText("(no output captured)"),
      ).toBeInTheDocument();
    });
  });

  describe("dismiss interaction", () => {
    it("invokes onDismiss when the user clicks Dismiss", () => {
      const onDismiss = vi.fn();
      render(
        <EnvActionAnchorEntry
          run={buildRun({ status: "failed", exitCode: 1 })}
          environmentName={undefined}
          onDismiss={onDismiss}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  describe("environment-name decoration", () => {
    it("appends environmentName when provided", () => {
      render(
        <EnvActionAnchorEntry
          run={buildRun({ actionName: "E2E Tests" })}
          environmentName="PwrAgnt"
          onDismiss={() => {}}
        />,
      );
      expect(
        screen.getByText(/E2E Tests · PwrAgnt/),
      ).toBeInTheDocument();
    });

    it("omits the env-name when undefined", () => {
      render(
        <EnvActionAnchorEntry
          run={buildRun({ actionName: "E2E Tests" })}
          environmentName={undefined}
          onDismiss={() => {}}
        />,
      );
      // The env-name "PwrAgnt" should not appear anywhere in the rendered
      // anchor; meta (pid, running-for, exit) still uses the · separator,
      // but the env-name slot specifically is empty.
      expect(screen.queryByText(/PwrAgnt/)).toBeNull();
    });
  });

  describe("multi-line command rendering", () => {
    // Regression: previously rendered with white-space: nowrap, which
    // flattened a multi-line script (`nvm use --silent\ncorepack
    // enable\npnpm dev`) onto a single horizontally-scrolling line,
    // making it look as though only the last line was running.
    it("preserves newlines in commands so each line is visible", () => {
      const multiLineCommand = "nvm use --silent\ncorepack enable\npnpm dev";
      render(
        <EnvActionAnchorEntry
          run={buildRun({
            status: "started",
            command: multiLineCommand,
          })}
          environmentName="PwrSnap"
          onDismiss={() => {}}
        />,
      );
      // The command body lives inside a <pre><code> with white-space:
      // pre, so the textContent retains the newlines verbatim.
      const codeBlock = screen.getByText(/nvm use --silent/);
      expect(codeBlock.textContent).toContain("nvm use --silent");
      expect(codeBlock.textContent).toContain("corepack enable");
      expect(codeBlock.textContent).toContain("pnpm dev");
    });
  });

  describe("backend-converted zombie display", () => {
    // EnvActionAnchorEntry itself doesn't apply the session-start filter
    // (its parent EnvActionAnchorList does), but we assert the entry
    // renders correctly for the "converted-by-backend-cleanup" path:
    // a previously-started run that backend cleanup has flipped to
    // "failed" must show with a Dismiss button so the user isn't stuck.
    it("renders a backend-converted zombie run with a Dismiss button", () => {
      render(
        <EnvActionAnchorEntry
          run={buildRun({
            status: "failed",
            startedAt: 1, // legacy-synthesised values may be 0/1 here
            exitedAt: 1_700_000_000_000,
            output: undefined,
          })}
          environmentName="PwrAgnt"
          onDismiss={() => {}}
        />,
      );
      expect(
        screen.getByLabelText("Env action failed"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Dismiss" }),
      ).toBeInTheDocument();
    });
  });
});

describe("formatDurationMs", () => {
  it("returns empty for falsy / non-finite inputs", () => {
    expect(formatDurationMs(undefined)).toBe("");
    expect(formatDurationMs(0)).toBe("");
    expect(formatDurationMs(Number.NaN)).toBe("");
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("formats sub-second elapsed in integer milliseconds", () => {
    expect(formatDurationMs(1)).toBe("1ms");
    expect(formatDurationMs(750)).toBe("750ms");
    expect(formatDurationMs(999)).toBe("999ms");
  });

  it("formats sub-minute elapsed in integer seconds (no decimal)", () => {
    // Regression: the previous `toFixed(1)` for elapsed < 10s produced
    // "0.9s" / "1.9s" displays that the user spotted as visual noise.
    expect(formatDurationMs(1_000)).toBe("1s");
    expect(formatDurationMs(1_499)).toBe("1s"); // rounds down
    expect(formatDurationMs(1_500)).toBe("2s"); // rounds up
    expect(formatDurationMs(9_400)).toBe("9s"); // never "9.4s"
    expect(formatDurationMs(10_000)).toBe("10s");
    expect(formatDurationMs(59_000)).toBe("59s");
  });

  it("crosses the 60-second boundary cleanly without producing 'Xm 60s'", () => {
    // Regression: with `Math.round(seconds % 60)`, an elapsed of 59.5s
    // produced "1m 60s" because half-up rounding rolled the remainder
    // past 60 without bumping the minute.
    expect(formatDurationMs(59_499)).toBe("59s");
    expect(formatDurationMs(59_500)).toBe("1m");
    expect(formatDurationMs(60_000)).toBe("1m");
    expect(formatDurationMs(60_499)).toBe("1m");
    expect(formatDurationMs(60_500)).toBe("1m 1s");
    expect(formatDurationMs(119_499)).toBe("1m 59s");
    expect(formatDurationMs(119_500)).toBe("2m");
    expect(formatDurationMs(120_000)).toBe("2m");
  });

  it("formats hour-plus durations with the minute portion only", () => {
    expect(formatDurationMs(60 * 60_000)).toBe("60m");
    expect(formatDurationMs(60 * 60_000 + 5_000)).toBe("60m 5s");
    expect(formatDurationMs(2 * 60 * 60_000)).toBe("120m");
  });

  describe("coarseAfterMinute", () => {
    it("drops the seconds portion entirely past 1 minute", () => {
      // For the live "running for X" anchor meta, we want minute-only
      // updates past the 1-minute mark to avoid distracting the user
      // with a ticking sub-minute display.
      expect(formatDurationMs(60_500, { coarseAfterMinute: true })).toBe("1m");
      expect(formatDurationMs(118_000, { coarseAfterMinute: true })).toBe("1m");
      expect(formatDurationMs(119_499, { coarseAfterMinute: true })).toBe("1m");
      expect(formatDurationMs(119_500, { coarseAfterMinute: true })).toBe("2m");
      expect(formatDurationMs(6 * 60_000 + 23_000, { coarseAfterMinute: true })).toBe("6m");
    });

    it("does not affect sub-minute formatting", () => {
      // Sub-minute uses second-precision in either mode — there's no
      // distraction problem there since the display does update.
      expect(formatDurationMs(5_500, { coarseAfterMinute: true })).toBe("6s");
      expect(formatDurationMs(59_499, { coarseAfterMinute: true })).toBe("59s");
    });

    it("leaves the default precise behavior unchanged", () => {
      // The "ran 2m 30s" suffix on completed runs is a static one-shot
      // display, not a ticker — keep the seconds precision intact.
      expect(formatDurationMs(60_500)).toBe("1m 1s");
      expect(formatDurationMs(6 * 60_000 + 23_000)).toBe("6m 23s");
    });
  });
});
