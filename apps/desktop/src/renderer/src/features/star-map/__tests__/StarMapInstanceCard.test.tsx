import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StarMapInstanceCard } from "../StarMapInstanceCard";

type CardProps = Parameters<typeof StarMapInstanceCard>[0];

function renderCard(overrides: Partial<CardProps> = {}): CardProps {
  const props: CardProps = {
    instanceId: "pwr_studio",
    label: "Studio Mac",
    status: "connected",
    isLocal: false,
    isHub: false,
    onSelect: vi.fn(),
    ...overrides,
  };
  render(<StarMapInstanceCard {...props} />);
  return props;
}

function tooltipText(): string[] {
  return [...document.querySelectorAll(".viewport-tooltip")].map(
    (node) => node.textContent ?? "",
  );
}

describe("StarMapInstanceCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("selects the instance on body click instead of opening a window", () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    renderCard({ onSelect, onOpen });

    fireEvent.click(screen.getByRole("button", { name: "Focus Studio Mac" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    // The window-level commitment stays on its own control: the biggest,
    // most inviting target on the map must do the cheap, reversible thing.
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("puts opening a remote viewer on a dedicated action", () => {
    const onOpen = vi.fn();
    renderCard({ onOpen });

    fireEvent.click(
      screen.getByRole("button", { name: "Open remote viewer for Studio Mac" }),
    );

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("names the open action for the local instance differently", () => {
    renderCard({ isLocal: true, label: "This Mac", onOpen: vi.fn() });

    expect(
      screen.getByRole("button", { name: "Open this instance (This Mac)" }),
    ).toBeTruthy();
  });

  it("keeps the profile in every action name so two profiles stay distinct", () => {
    renderCard({
      label: "Harold-MBP-M5-Max",
      profileName: "dev",
      onIntake: vi.fn(),
      onToggleLoad: vi.fn(),
      onOpen: vi.fn(),
    });

    for (const name of [
      "New thread on Harold-MBP-M5-Max / dev",
      "Show load for Harold-MBP-M5-Max / dev (CPU, memory, disk)",
      "Open remote viewer for Harold-MBP-M5-Max / dev",
      "Focus Harold-MBP-M5-Max / dev",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("reports load-card state through aria-pressed and flips the label", () => {
    const onToggleLoad = vi.fn();
    renderCard({ onToggleLoad, loadShown: false });

    const show = screen.getByRole("button", {
      name: "Show load for Studio Mac (CPU, memory, disk)",
    });
    expect(show.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(show);
    expect(onToggleLoad).toHaveBeenCalledTimes(1);

    cleanup();
    renderCard({ onToggleLoad, loadShown: true });

    expect(
      screen
        .getByRole("button", { name: "Hide load for Studio Mac" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("marks the body pressed while selected", () => {
    renderCard({ selected: true });

    expect(
      screen
        .getByRole("button", { name: "Focus Studio Mac" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("omits actions the instance cannot perform", () => {
    renderCard();

    // A disconnected peer gets no intake and no load query, so those
    // controls must not render at all rather than render disabled.
    expect(screen.queryByRole("button", { name: /New thread on/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Show load for/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Open remote viewer/ }),
    ).toBeNull();
  });

  it("clicking an action never reaches the body underneath it", () => {
    // The row tucks into the body's empty top margin, so their boxes overlap
    // and the body is the later sibling. Without the row claiming a layer,
    // the body wins the overlap and a click on the lower half of a button
    // selects the instance instead of firing the action.
    const onSelect = vi.fn();
    const onToggleLoad = vi.fn();
    const { container } = render(
      <StarMapInstanceCard
        instanceId="pwr_studio"
        label="Studio Mac"
        status="connected"
        isLocal={false}
        isHub={false}
        onSelect={onSelect}
        onToggleLoad={onToggleLoad}
      />,
    );

    const actions = container.querySelector<HTMLElement>(
      ".star-map-instance__actions",
    );
    const body = container.querySelector<HTMLElement>(
      ".star-map-instance__body",
    );
    // The row must come BEFORE the body in the DOM (so it is the earlier
    // sibling) and carry its own stacking order.
    expect(actions).not.toBeNull();
    expect(body).not.toBeNull();
    expect(
      actions!.compareDocumentPosition(body!)
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show load for Studio Mac (CPU, memory, disk)",
      }),
    );
    expect(onToggleLoad).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows an icon-only action's name on focus, not just on hover", () => {
    renderCard({ onToggleLoad: vi.fn() });
    const button = screen.getByRole("button", {
      name: "Show load for Studio Mac (CPU, memory, disk)",
    });

    // Keyboard users never hover, and the tooltip carries the whole meaning
    // of an icon-only control, so focus has to surface it too.
    fireEvent.focus(button);
    expect(tooltipText()).toContain(
      "Show load for Studio Mac (CPU, memory, disk)",
    );

    fireEvent.blur(button);
    expect(tooltipText()).not.toContain(
      "Show load for Studio Mac (CPU, memory, disk)",
    );
  });
});
