import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentSetupRow, type EnvironmentSetupRowModel } from "../EnvironmentSetupRow";

afterEach(() => {
  cleanup();
});

const OUTPUT = [
  "Progress: resolved 1204, reused 1198, downloaded 6, added 1204",
  "node_modules/.pnpm/esbuild@0.25.0/node_modules/esbuild: Running postinstall script, done in 412ms",
].join("\n");

function model(overrides: Partial<EnvironmentSetupRowModel>): EnvironmentSetupRowModel {
  return {
    key: "run-1",
    phase: "setup",
    status: "running",
    environmentName: "Fixture env",
    command: "pnpm install",
    cwd: "/fixture",
    output: OUTPUT,
    startedAt: Date.now(),
    ...overrides,
  };
}

function summary(row: HTMLElement): string {
  return row.querySelector(".composer__queued-text")?.textContent ?? "";
}

describe("EnvironmentSetupRow", () => {
  it("keeps output out of the collapsed summary while the command runs", () => {
    const { rerender } = render(<EnvironmentSetupRow model={model({})} />);
    const row = screen.getByLabelText("Env setup running");
    expect(summary(row)).toMatch(/^Fixture env · \d+s$/u);
    expect(row).not.toHaveTextContent("postinstall");

    // A new line does not change what the collapsed row says.
    rerender(
      <EnvironmentSetupRow
        model={model({ output: `${OUTPUT}\nDone in 9.8s using pnpm v10.18.0` })}
      />,
    );
    expect(summary(row)).toMatch(/^Fixture env · \d+s$/u);
    expect(row).not.toHaveTextContent("Done in");

    fireEvent.click(within(row).getByRole("button", { expanded: false }));
    expect(screen.getByLabelText("Env setup output")).toHaveTextContent("Done in 9.8s");
  });

  it("summarizes a failure by exit code and duration, not its last line", () => {
    render(
      <EnvironmentSetupRow
        model={model({
          status: "failed",
          exitCode: 1,
          durationMs: 4_000,
          error: "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH lockfile is out of date",
        })}
      />,
    );
    const row = screen.getByLabelText("Env setup failed");
    expect(summary(row)).toBe("Fixture env · exit 1 · ran 4s");
    expect(row).not.toHaveTextContent("ERR_PNPM");

    fireEvent.click(within(row).getByRole("button", { expanded: false }));
    expect(screen.getByLabelText("Env setup output")).toHaveTextContent("ERR_PNPM");
  });
});
