import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CodexEnvironmentActionRun } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvActionAnchorEntry } from "../Composer";

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
      // Duration formatter rounds <10s to 1 decimal.
      expect(screen.getByText(/ran 4\.3s/)).toBeInTheDocument();
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
