import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FederationHealthStatus } from "@pwragent/shared";
import { FederationDisplayLabelsProvider } from "../../../lib/federation-display-label";
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

  it("shows the machine's short name and keeps the full name in the tooltip", async () => {
    const globals = window as FederationWindowGlobals;
    globals.__pwragentFederationLabel = "DESKTOP-17ISFOI / dev";
    globals.__pwragentFederationTarget = { scope: "remote", instanceId: "pwr_win" };
    const health = {
      instanceId: "pwr_local",
      localLabel: "Harold-MBP-M5-Max",
      localProfileName: "default",
      peers: [
        { id: "pwr_win", label: "DESKTOP-17ISFOI", profileName: "dev", shortLabel: "Win-Tower" },
      ],
    } as unknown as FederationHealthStatus;

    render(
      <FederationDisplayLabelsProvider health={health}>
        <FederationRemoteBadge />
      </FederationDisplayLabelsProvider>,
    );

    const badge = screen.getByRole("button", {
      name: "Remote instance: DESKTOP-17ISFOI / dev. Copy instance id.",
    });
    expect(badge).toHaveTextContent("Remote · Win-Tower / dev");

    fireEvent.mouseEnter(badge);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "DESKTOP-17ISFOI / dev · pwr_win\nClick to copy the instance id",
    );
  });
});
