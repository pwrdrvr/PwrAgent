import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewThreadButton } from "../NewThreadButton";

afterEach(cleanup);

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

    fireEvent.mouseLeave(button.parentElement as HTMLElement);
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

    const offline = await screen.findByRole("menuitem", { name: /Studio Mac/ });
    expect(offline).toBeDisabled();
    expect(offline).toHaveTextContent("Offline");
    const unsupported = screen.getByRole("menuitem", { name: /Attic Mini/ });
    expect(unsupported).toBeDisabled();
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
