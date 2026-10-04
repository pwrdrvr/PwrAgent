import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeLaunchpadMachineOffline,
  FixedMachineChip,
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
  it("opens its menu below the chip when it sits in the title rail", () => {
    render(
      <LaunchpadMachineChip
        control={control()}
        menuPlacement="below"
        onRetarget={() => undefined}
      />,
    );
    const chip = screen.getByRole("button", { name: "Machine" });
    vi.spyOn(chip, "getBoundingClientRect").mockReturnValue(
      { bottom: 32, right: 900, top: 8, left: 780, width: 120, height: 24, x: 780, y: 8 } as DOMRect,
    );
    fireEvent.click(chip);
    // Fixed under the trigger, so the header's clipping row cannot cut it.
    const menu = screen.getByRole("listbox", { name: "Machine" });
    expect(menu).toHaveClass("composer-dropdown__menu--below");
    expect(menu.style.top).toBe("40px");
    expect(menu.style.right).toBe(`${window.innerWidth - 900}px`);
  });

  it("names a thread's machine by its short label", () => {
    render(
      <FixedMachineChip
        machine={{ label: "Studio Mac / default", shortLabel: "Studio", instanceId: "studio", remote: true }}
      />,
    );
    const chip = screen.getByLabelText("Runs on Studio");
    expect(chip).toHaveTextContent("Studio");
    expect(chip).toHaveAttribute("title", "Studio Mac / default");
    expect(chip).toHaveAttribute("data-remote", "true");
  });

  it("names this machine and stays neutral while the launchpad is local", () => {
    render(<LaunchpadMachineChip control={control()} onRetarget={() => undefined} />);

    const chip = screen.getByRole("button", { name: "Machine" });
    expect(chip).toHaveTextContent("Harbor Mac");
    expect(chip.closest(".composer-dropdown")).not.toHaveClass("composer-dropdown--remote");
  });

  it("marks a viewer's default owner as remote and offers other peers", async () => {
    const onRetarget = vi.fn();
    render(
      <LaunchpadMachineChip
        control={control({
          local: { label: "Remote owner", instanceId: "owner", remote: true },
        })}
        onRetarget={onRetarget}
      />,
    );
    const chip = screen.getByRole("button", { name: "Machine" });
    expect(chip).toHaveTextContent("Remote owner");
    expect(chip.closest(".composer-dropdown")).toHaveClass("composer-dropdown--remote");
    fireEvent.click(chip);
    expect(options()[0]).toHaveTextContent("This window");
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.click(options()[1]!);
    expect(onRetarget).toHaveBeenCalledWith("studio");
  });

  it.each(["offline", "unsupported"] as const)("blocks returning to an %s viewer owner until it is available", (availability) => {
    const onRetarget = vi.fn();
    const selected = control({
      currentInstanceId: "studio",
      local: { label: "Remote owner", instanceId: "owner", remote: true, availability },
    });
    const view = render(<LaunchpadMachineChip control={selected} onRetarget={onRetarget} />);
    fireEvent.click(screen.getByRole("button", { name: "Machine" }));
    const owner = options()[0]!;
    expect(owner).toHaveAttribute("aria-disabled", "true");
    expect(owner).toHaveTextContent(availability === "offline" ? "Offline" : "Unsupported");
    fireEvent.click(owner);
    expect(onRetarget).not.toHaveBeenCalled();

    view.rerender(<LaunchpadMachineChip
      control={{ ...selected, local: { ...selected.local, availability: "available" } }}
      onRetarget={onRetarget}
    />);
    expect(options()[0]).not.toHaveAttribute("aria-disabled");
    expect(options()[0]).toHaveTextContent("This window");
    fireEvent.click(options()[0]!);
    expect(onRetarget).toHaveBeenCalledWith(undefined);
  });

  it("marks the selected viewer owner offline while allowing a move to another peer", () => {
    const selected = control({
      local: { label: "Remote owner", instanceId: "owner", remote: true, availability: "offline" },
    });
    const onRetarget = vi.fn();
    render(<LaunchpadMachineChip control={selected} onRetarget={onRetarget} />);
    expect(screen.getByRole("button", { name: "Machine" }).closest(".composer-dropdown"))
      .toHaveClass("composer-dropdown--offline");
    expect(describeLaunchpadMachineOffline(selected))
      .toBe("Remote owner is offline. Your draft stays here until it reconnects.");
    fireEvent.click(screen.getByRole("button", { name: "Machine" }));
    fireEvent.click(options()[1]!);
    expect(onRetarget).toHaveBeenCalledWith("studio");
  });

  it("reports a viewer sub-thread's default owner as remote", () => {
    render(
      <LaunchpadMachineChip
        control={control({
          local: { label: "Remote owner", instanceId: "owner", remote: true },
          targets: [],
          planRetarget: undefined,
        })}
        onRetarget={() => undefined}
      />,
    );
    expect(screen.getByLabelText("Runs on Remote owner")).toHaveAttribute("data-remote", "true");
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

  it("dashes an offline target and says why sends wait", () => {
    const offline = control({ currentInstanceId: "attic" });
    render(<LaunchpadMachineChip control={offline} onRetarget={() => undefined} />);

    const chip = screen.getByRole("button", { name: "Machine" });
    expect(chip.closest(".composer-dropdown")).toHaveClass("composer-dropdown--offline");
    expect(chip.closest(".composer-dropdown")).not.toHaveClass("composer-dropdown--remote");
    expect(describeLaunchpadMachineOffline(offline))
      .toBe("Attic Mini is offline. Your draft stays here until it reconnects.");
    expect(describeLaunchpadMachineOffline(control({ currentInstanceId: "studio" })))
      .toBeUndefined();
    expect(describeLaunchpadMachineOffline(control())).toBeUndefined();
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
