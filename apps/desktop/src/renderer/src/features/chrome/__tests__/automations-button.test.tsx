import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationsButton } from "../AutomationsButton";

afterEach(cleanup);

describe("AutomationsButton", () => {
  it("shows nothing extra while this instance runs automations", () => {
    const { container } = render(<AutomationsButton schedulingStatus={{ state: "active" }} />);
    expect(screen.getByRole("button", { name: "Open automations" })).not.toHaveClass("is-automations-paused");
    expect(container.querySelector(".automations-paused-dot")).toBeNull();
  });

  it("shows automations paused and names the instance that runs them", () => {
    const { container } = render(
      <AutomationsButton
        schedulingStatus={{
          state: "elsewhere",
          holder: { instanceId: "runtime-v2-other", processId: 4242, cwdHint: "/Users/dev/PwrAgnt" },
        }}
      />,
    );
    const button = screen.getByRole("button", { name: "Open automations, paused in this window" });
    expect(button).toHaveClass("is-automations-paused");
    expect(container.querySelector(".automations-paused-dot")).not.toBeNull();

    fireEvent.mouseEnter(button);
    const tooltip = document.body.querySelector(".viewport-tooltip");
    expect(tooltip?.textContent).toContain("Automations are paused in this window");
    expect(tooltip?.textContent).toContain("(/Users/dev/PwrAgnt - pid 4242)");
    expect(tooltip?.textContent).toContain("takes over when that instance quits");
  });

  it("shows automations paused without naming a holder when the lease could not be read", () => {
    render(<AutomationsButton schedulingStatus={{ state: "elsewhere" }} />);
    const button = screen.getByRole("button", { name: "Open automations, paused in this window" });
    fireEvent.mouseEnter(button);
    const tooltip = document.body.querySelector(".viewport-tooltip");
    expect(tooltip?.textContent).toContain("could not take the profile's background lease");
    expect(tooltip?.textContent).not.toContain("Another PwrAgent instance");
  });

  it("shows automations off when this instance was launched without them", () => {
    render(<AutomationsButton schedulingStatus={{ state: "disabled", reason: "--disable-automations" }} />);
    expect(screen.getByRole("button", { name: "Open automations, off for this app instance" }))
      .toHaveClass("is-automations-paused");
  });
});
