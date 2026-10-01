import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LaunchpadMachineChip,
  type LaunchpadMachineControl,
} from "../LaunchpadMachineChip";

afterEach(cleanup);

function control(overrides: Partial<LaunchpadMachineControl> = {}): LaunchpadMachineControl {
  return {
    local: { label: "Harbor Mac", instanceId: "harbor" },
    targets: [
      { availability: "available", instanceId: "studio", label: "Studio Mac" },
      { availability: "available", instanceId: "tower", label: "Tower PC" },
      { availability: "offline", instanceId: "attic", label: "Attic Mini" },
    ],
    project: { kind: "directory", label: "ProjectA", path: "/src/ProjectA" },
    localHasProject: true,
    planRetarget: async () => undefined,
    ...overrides,
  };
}

function options(): HTMLElement[] {
  return within(screen.getByRole("listbox", { name: "Machine" })).getAllByRole("option");
}

describe("LaunchpadMachineChip", () => {
  it("names this machine and stays neutral while the launchpad is local", () => {
    render(<LaunchpadMachineChip control={control()} onRetarget={() => undefined} />);

    const chip = screen.getByRole("button", { name: "Machine" });
    expect(chip).toHaveTextContent("Harbor Mac");
    expect(chip.closest(".composer-dropdown")).not.toHaveClass("composer-dropdown--remote");
  });

  it("marks a peer target and greys out a peer without the project", async () => {
    const check = vi.fn(async (instanceId: string) => instanceId !== "tower");
    render(
      <LaunchpadMachineChip
        control={control({ currentInstanceId: "studio", checkProject: check })}
        onRetarget={() => undefined}
      />,
    );

    const chip = screen.getByRole("button", { name: "Machine" });
    expect(chip).toHaveTextContent("Studio Mac");
    expect(chip.closest(".composer-dropdown")).toHaveClass("composer-dropdown--remote");

    await act(async () => {
      fireEvent.click(chip);
    });
    // The current machine is never asked; the offline one cannot answer.
    expect(check.mock.calls.map(([instanceId]) => instanceId)).toEqual(["tower"]);
    const [here, studio, tower, attic] = options();
    expect(here).toHaveTextContent("This machine");
    expect(studio).toHaveAttribute("aria-selected", "true");
    expect(tower).toHaveTextContent("No project");
    expect(tower).toHaveAttribute("aria-disabled", "true");
    expect(attic).toHaveTextContent("Offline");
    expect(attic).toHaveAttribute("aria-disabled", "true");
  });

  it("retargets to this machine or a peer, and refuses a disabled row", async () => {
    const onRetarget = vi.fn();
    render(
      <LaunchpadMachineChip
        control={control({ currentInstanceId: "studio", localHasProject: false })}
        onRetarget={onRetarget}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Machine" }));
    });
    const [here] = options();
    expect(here).toHaveTextContent("No project");
    fireEvent.click(here!);
    expect(onRetarget).not.toHaveBeenCalled();

    fireEvent.click(options()[2]!);
    expect(onRetarget).toHaveBeenCalledWith("tower");
  });

  it("reports a sub-thread's fixed machine without offering a choice", () => {
    render(
      <LaunchpadMachineChip
        control={control({ currentInstanceId: "studio", planRetarget: undefined })}
        onRetarget={() => undefined}
      />,
    );

    expect(screen.queryByRole("button", { name: "Machine" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Runs on Studio Mac")).toHaveTextContent("Studio Mac");
  });
});
