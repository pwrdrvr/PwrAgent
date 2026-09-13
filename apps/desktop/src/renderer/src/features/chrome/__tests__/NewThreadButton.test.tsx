import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOVER_TRANSITION_GRACE_MS } from "../../../lib/useHoverTransitionGrace";
import { NewThreadButton } from "../NewThreadButton";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("NewThreadButton", () => {
  it("clicking runs the default action and shows no flyout without a directory", () => {
    const onCreateThread = vi.fn();
    render(<NewThreadButton onCreateThread={onCreateThread} />);

    const button = screen.getByRole("button", { name: "New thread" });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(onCreateThread).toHaveBeenCalledTimes(1);
  });

  it("falls back to a 'New thread' tooltip when there is no flyout", async () => {
    render(<NewThreadButton onCreateThread={vi.fn()} />);

    const button = screen.getByRole("button", { name: "New thread" });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    expect((await screen.findByRole("tooltip")).textContent).toBe("New thread");

    vi.useFakeTimers();
    fireEvent.mouseLeave(button.parentElement as HTMLElement);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("reveals the flyout on hover and suppresses the tooltip when a directory is set", async () => {
    const onCreateThread = vi.fn();
    const onCreateThreadWithoutDirectory = vi.fn();
    render(
      <NewThreadButton
        directoryLabel="PwrAgnt"
        onCreateThread={onCreateThread}
        onCreateThreadWithoutDirectory={onCreateThreadWithoutDirectory}
      />,
    );

    const button = screen.getByRole("button", { name: "New thread" });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);

    expect(
      await screen.findByRole("menuitem", { name: "New chat in PwrAgnt" }),
    ).toBeInTheDocument();
    // The flyout replaces the plain tooltip.
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("menuitem", { name: "New chat without a directory" }),
    );
    expect(onCreateThreadWithoutDirectory).toHaveBeenCalledTimes(1);
    expect(onCreateThread).not.toHaveBeenCalled();
  });

  it("keeps the flyout mounted while the pointer crosses and cancels dismissal on re-entry", () => {
    vi.useFakeTimers();
    render(
      <NewThreadButton
        directoryLabel="PwrAgent"
        onCreateThread={vi.fn()}
        onCreateThreadWithoutDirectory={vi.fn()}
      />,
    );

    const wrapper = screen.getByRole("button", { name: "New thread" })
      .parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // Windows can report leave at the native title-bar/content boundary even
    // though the pointer is travelling into the descendant flyout.
    fireEvent.mouseLeave(wrapper);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByRole("menu").parentElement as HTMLElement);
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseLeave(wrapper);
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("offers project registration without starting or selecting a chat", async () => {
    const onAddProjectDirectory = vi.fn();
    const onCreateThread = vi.fn();
    render(
      <NewThreadButton
        onAddProjectDirectory={onAddProjectDirectory}
        onCreateThread={onCreateThread}
      />,
    );

    const button = screen.getByRole("button", { name: "New thread" });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);

    expect(
      await screen.findByRole("menuitem", {
        name: "New chat without a directory",
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Add a Project Directory…" }),
    );

    expect(onAddProjectDirectory).toHaveBeenCalledTimes(1);
    expect(onCreateThread).not.toHaveBeenCalled();
  });

  it("offers connected federation instances before composition starts", async () => {
    const onCreateThread = vi.fn();
    const onCreateThreadOnTarget = vi.fn();
    render(
      <NewThreadButton
        onCreateThread={onCreateThread}
        onCreateThreadOnTarget={onCreateThreadOnTarget}
        remoteTargets={[
          {
            availability: "available",
            instanceId: "studio-work",
            label: "Studio Mac / work",
          },
          {
            availability: "available",
            instanceId: "laptop-default",
            label: "Laptop",
          },
        ]}
      />,
    );

    const button = screen.getByRole("button", { name: "New thread" });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);

    expect(await screen.findByText("New chat on")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Studio Mac / work" }),
    );

    expect(onCreateThreadOnTarget).toHaveBeenCalledWith("studio-work");
    expect(onCreateThread).not.toHaveBeenCalled();
  });

  it("orders 'Add a Project Directory…' above the federation instances", async () => {
    render(
      <NewThreadButton
        directoryLabel="PwrAgnt"
        onAddProjectDirectory={vi.fn()}
        onCreateThread={vi.fn()}
        onCreateThreadOnTarget={vi.fn()}
        onCreateThreadWithoutDirectory={vi.fn()}
        remoteTargets={[
          {
            availability: "available",
            instanceId: "studio-work",
            label: "Studio Mac / work",
          },
          {
            availability: "available",
            instanceId: "laptop-default",
            label: "Laptop",
          },
        ]}
      />,
    );

    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "New thread" })
        .parentElement as HTMLElement,
    );

    // The federation group is the only unbounded part of this menu, so every
    // fixed action has to precede it — after it, an action sits at an offset
    // that grows with the machine count and drops below the scrolling card's
    // fold. Pinned here because nothing about the JSX order enforces it.
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "New chat in PwrAgnt",
      "New chat without a directory",
      "Add a Project Directory…",
      "Studio Mac / work",
      "Laptop",
    ]);
  });

  it("keeps the Add row focusable and inert while a registration runs", async () => {
    const onAddProjectDirectory = vi.fn();
    render(
      <NewThreadButton
        addingProjectDirectory
        onAddProjectDirectory={onAddProjectDirectory}
        onCreateThread={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "New thread" })
        .parentElement as HTMLElement,
    );

    // `registerDirectoryFromDisk` runs after the native picker closes, so the
    // window is interactive while this row reads "Adding Project Directory…".
    // A real `disabled` attribute would drop it from the tab order there and
    // hide the in-progress state from keyboard and screen-reader users — the
    // same reason the federation rows use `aria-disabled`.
    const row = await screen.findByRole("menuitem", {
      name: "Adding Project Directory…",
    });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).not.toBeDisabled();

    fireEvent.click(row);
    expect(onAddProjectDirectory).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("carries the verb in the group label instead of repeating it per row", async () => {
    render(
      <NewThreadButton
        onCreateThread={vi.fn()}
        onCreateThreadOnTarget={vi.fn()}
        remoteTargets={[
          {
            availability: "available",
            instanceId: "studio-work",
            label: "Studio Mac / work",
          },
        ]}
      />,
    );

    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "New thread" })
        .parentElement as HTMLElement,
    );

    // The machine label is the whole row: rows are nowrap/ellipsis inside a
    // 320px card, and a repeated "New chat on " prefix pushed the ` / profile`
    // suffix — the only thing telling two rows apart — toward the clip.
    const group = await screen.findByRole("group", { name: "New chat on" });
    expect(
      within(group).getByRole("menuitem", { name: "Studio Mac / work" }),
    ).toBeInTheDocument();
  });

  it("keeps unreachable instances visible and disabled rather than hiding them", async () => {
    const onCreateThreadOnTarget = vi.fn();
    render(
      <NewThreadButton
        onCreateThread={vi.fn()}
        onCreateThreadOnTarget={onCreateThreadOnTarget}
        remoteTargets={[
          {
            availability: "offline",
            instanceId: "studio-work",
            label: "Studio Mac",
          },
          {
            availability: "unsupported",
            instanceId: "old-build",
            label: "Attic Mini",
          },
        ]}
      />,
    );

    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "New thread" })
        .parentElement as HTMLElement,
    );

    // aria-disabled, not `disabled` — an unreachable machine has to stay
    // focusable or keyboard users never learn it exists, which is the whole
    // reason it is listed rather than filtered out.
    const offline = await screen.findByRole("menuitem", { name: /Studio Mac/ });
    expect(offline).toHaveAttribute("aria-disabled", "true");
    expect(offline).not.toBeDisabled();
    expect(offline).toHaveTextContent("Offline");
    const unsupported = screen.getByRole("menuitem", { name: /Attic Mini/ });
    expect(unsupported).toHaveAttribute("aria-disabled", "true");
    expect(unsupported).toHaveTextContent("Unsupported");

    fireEvent.click(offline);
    expect(onCreateThreadOnTarget).not.toHaveBeenCalled();
  });

  it("closes the flyout on Escape while a menu item is focused (regression)", async () => {
    render(
      <NewThreadButton
        directoryLabel="PwrAgnt"
        onCreateThread={vi.fn()}
        onCreateThreadWithoutDirectory={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: "New thread" });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    const item = await screen.findByRole("menuitem", {
      name: "New chat without a directory",
    });

    // Move keyboard focus into the menu, then dismiss with Escape. Refocusing
    // the trigger must NOT re-open the menu.
    item.focus();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("does not render the flyout while a thread is being created", async () => {
    render(
      <NewThreadButton
        creatingThread
        directoryLabel="PwrAgnt"
        onCreateThread={vi.fn()}
        onCreateThreadWithoutDirectory={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: "New thread" });
    expect(button).toBeDisabled();
    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
