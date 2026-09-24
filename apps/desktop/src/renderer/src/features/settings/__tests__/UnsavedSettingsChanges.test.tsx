import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useUnsavedSettingsChanges,
  useUnsavedSettingsGuard,
} from "../UnsavedSettingsChanges";
import { pressEscape, tabEscapes } from "../../../test/tab-walk";

afterEach(() => {
  cleanup();
});

function Pane(props: { save: () => Promise<boolean> }) {
  useUnsavedSettingsChanges({
    label: "Federation",
    save: props.save,
    discard: () => undefined,
  });
  return <input aria-label="Listen port" defaultValue="4410" />;
}

function Screen(props: { save: () => Promise<boolean>; leave: () => void }) {
  const guard = useUnsavedSettingsGuard();
  return (
    <>
      <button type="button" onClick={() => guard.confirmLeave(props.leave)}>
        Exit Settings
      </button>
      {guard.provide(<Pane save={props.save} />)}
      {guard.dialog}
    </>
  );
}

function open(save: () => Promise<boolean> = async () => true): HTMLElement {
  render(<Screen save={save} leave={vi.fn()} />);
  const exit = screen.getByRole("button", { name: "Exit Settings" });
  exit.focus();
  act(() => exit.click());
  return screen.getByRole("alertdialog", { name: "Save changes to Federation?" });
}

describe("Unsaved settings prompt, keyboard", () => {
  it("opens with focus on the prompt itself", () => {
    const dialog = open();
    expect(document.activeElement).toBe(dialog);
  });

  it("keeps Tab inside the prompt", () => {
    const dialog = open();
    expect(tabEscapes(dialog)).toEqual({ forward: [], backward: [] });
  });

  it("keeps editing on Escape and returns focus to what asked to leave", () => {
    open();
    pressEscape();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Exit Settings" }),
    );
  });

  it("ignores Escape while a save is running, without letting it through", async () => {
    let finish: (saved: boolean) => void = () => undefined;
    open(() => new Promise<boolean>((resolve) => {
      finish = resolve;
    }));
    act(() => screen.getByRole("button", { name: "Save changes" }).click());
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    pressEscape();
    window.removeEventListener("keydown", behind);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(behind).not.toHaveBeenCalled();
    await act(async () => finish(false));
  });
});
