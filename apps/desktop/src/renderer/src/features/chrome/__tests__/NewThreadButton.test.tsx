import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
