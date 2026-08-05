import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FederationRemoteBadge } from "../FederationRemoteBadge";

type FederationWindowGlobals = typeof window & {
  __pwragentFederationLabel?: unknown;
  __pwragentFederationTarget?: unknown;
};

afterEach(() => {
  const globals = window as FederationWindowGlobals;
  delete globals.__pwragentFederationLabel;
  delete globals.__pwragentFederationTarget;
  vi.restoreAllMocks();
});

describe("FederationRemoteBadge", () => {
  it("renders nothing outside a federation window", () => {
    const { container } = render(<FederationRemoteBadge />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the machine name and copies the instance id on click", async () => {
    const globals = window as FederationWindowGlobals;
    globals.__pwragentFederationLabel = "Tart VM";
    globals.__pwragentFederationTarget = {
      scope: "remote",
      instanceId: "pwr_remote-instance",
    };
    const copyText = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: { copyText },
    });

    render(<FederationRemoteBadge />);

    const badge = screen.getByRole("button", {
      name: "Remote instance: Tart VM. Copy instance id.",
    });
    expect(badge).toHaveTextContent("Remote · Tart VM");

    fireEvent.mouseEnter(badge);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Tart VM · pwr_remote-instance\nClick to copy the instance id",
    );

    fireEvent.click(badge);
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith("pwr_remote-instance");
    });
    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(
        "Copied instance id",
      );
    });
  });
});
