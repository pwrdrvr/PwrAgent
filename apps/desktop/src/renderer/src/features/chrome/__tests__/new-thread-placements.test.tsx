import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTitleBar } from "../AppTitleBar";
import { MastheadActions } from "../MastheadActions";

const remoteTargets = [
  {
    availability: "available" as const,
    instanceId: "studio-work",
    label: "Studio Mac / work",
  },
];

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: undefined,
  });
});

describe("federation New Thread placements", () => {
  it("offers targets from the hidden-sidebar masthead placement", () => {
    const onCreateThreadOnFederationTarget = vi.fn();
    render(
      <MastheadActions
        newThreadFederationTargets={remoteTargets}
        onCreateThread={vi.fn()}
        onCreateThreadOnFederationTarget={onCreateThreadOnFederationTarget}
      />,
    );

    const button = screen.getByRole("button", { name: "New thread" });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    fireEvent.click(screen.getByRole("menuitem", {
      name: "Studio Mac / work",
    }));

    expect(onCreateThreadOnFederationTarget).toHaveBeenCalledWith("studio-work");
  });

  it("offers targets from the Windows title-bar placement", () => {
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: { platform: "win32" },
    });
    const onCreateThreadOnFederationTarget = vi.fn();
    render(
      <AppTitleBar
        actions={{
          automationsActive: false,
          creatingThread: false,
          newThreadFederationTargets: remoteTargets,
          onCreateThread: vi.fn(),
          onCreateThreadOnFederationTarget,
          onOpenAutomations: vi.fn(),
          onOpenSettings: vi.fn(),
          settingsActive: false,
        }}
      />,
    );

    const button = screen.getByRole("button", { name: "New thread" });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    fireEvent.click(screen.getByRole("menuitem", {
      name: "Studio Mac / work",
    }));

    expect(onCreateThreadOnFederationTarget).toHaveBeenCalledWith("studio-work");
  });
});
