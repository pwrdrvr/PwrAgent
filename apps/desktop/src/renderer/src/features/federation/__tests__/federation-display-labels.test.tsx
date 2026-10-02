import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FederationHealthStatus } from "@pwragent/shared";
import { FederationDisplayLabelsProvider, federationLocalDisplayLabel } from "../../../lib/federation-display-label";
import { buildFederationThreadTargets } from "../../chrome/federation-thread-targets";
import { FederationTargetMenuSection } from "../../chrome/FederationTargetMenuSection";
import { LaunchpadMachineChip } from "../../composer/LaunchpadMachineChip";
import { InstanceChip } from "../InstanceGlyph";

afterEach(cleanup);

const health: FederationHealthStatus = {
  enabled: true, role: "gateway", status: "listening",
  localLabel: "Studio-Mac-Mini-M4", localShortLabel: "M4 Mini", localProfileName: "default",
  peers: [
    { id: "mini-dev", label: "Studio-Mac-Mini-M4", shortLabel: "M4 Mini", profileName: "dev",
      role: "client", status: "disconnected", capabilities: ["thread_navigation", "launchpad_metadata", "environment_actions"] },
    { id: "max", label: "Studio-MBP-M5-Max", shortLabel: "M5 Max", profileName: "default",
      role: "client", status: "connected", capabilities: ["thread_navigation", "launchpad_metadata", "environment_actions"] },
  ],
};

describe("federation machine names", () => {
  it("shows short names in the New chat on menu and routes by instance id", () => {
    const onSelect = vi.fn();
    render(<FederationTargetMenuSection targets={buildFederationThreadTargets(health)} onSelect={onSelect} />);
    const max = screen.getByRole("menuitem", { name: "M5 Max" });
    expect(max).toHaveAttribute("title", "Studio-MBP-M5-Max");
    expect(screen.getByRole("menuitem", { name: /^M4 Mini \/ dev/ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(max);
    expect(onSelect).toHaveBeenCalledWith("max");
  });

  it("shows the same local and remote short names on the composer chip and machine choices", () => {
    render(<LaunchpadMachineChip control={{
      local: { label: "Studio-Mac-Mini-M4 / default", shortLabel: federationLocalDisplayLabel(health) },
      targets: buildFederationThreadTargets(health), localHasProject: true, planRetarget: async () => undefined,
    }} onRetarget={() => undefined} />);
    const chip = screen.getByRole("button", { name: "Machine" });
    expect(chip).toHaveTextContent("M4 Mini / default");
    fireEvent.click(chip);
    expect(screen.getByRole("option", { name: /M5 Max/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /M4 Mini \/ dev/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("resolves thread chips from live health while preserving the original name in the tooltip", () => {
    const { rerender } = render(<FederationDisplayLabelsProvider health={health}>
      <InstanceChip instanceId="max" label="Studio-MBP-M5-Max" />
    </FederationDisplayLabelsProvider>);
    expect(screen.getByLabelText("Runs on M5 Max (Studio-MBP-M5-Max)")).toHaveTextContent("M5 Max");
    expect(screen.getByTitle("Studio-MBP-M5-Max · max")).toBeInTheDocument();
    rerender(<FederationDisplayLabelsProvider health={{ ...health, peers: health.peers.map((peer) => ({ ...peer, shortLabel: "Laptop" })) }}>
      <InstanceChip instanceId="max" label="Studio-MBP-M5-Max" />
    </FederationDisplayLabelsProvider>);
    expect(screen.getByLabelText("Runs on Laptop (Studio-MBP-M5-Max)")).toHaveTextContent("Laptop");
  });
});
