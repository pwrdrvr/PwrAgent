import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMousePress } from "../useMousePress";

function PressTarget(props: { onPress: (mousePress: boolean) => void }) {
  const isMousePress = useMousePress();
  return (
    <button type="button" onClick={(event) => props.onPress(isMousePress(event))}>
      Row
      <span onClick={(event) => event.stopPropagation()}>Suppressed child</span>
    </button>
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useMousePress", () => {
  it("recognizes the primary mouse click that immediately follows pointerup", () => {
    const onPress = vi.fn();
    render(<PressTarget onPress={onPress} />);
    const row = screen.getByRole("button");
    fireEvent.pointerDown(row, { pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(row, { pointerType: "mouse", button: 0 });
    fireEvent.click(row, { detail: 1 });
    expect(onPress).toHaveBeenLastCalledWith(true);
    fireEvent.click(row, { detail: 1 });
    expect(onPress).toHaveBeenLastCalledWith(false);
  });

  it.each([1, 2])("does not retain mouse button %s for a later assistive-technology click", (button) => {
    const onPress = vi.fn();
    render(<PressTarget onPress={onPress} />);
    const row = screen.getByRole("button");
    fireEvent.pointerDown(row, { pointerType: "mouse", button });
    fireEvent.click(row, { detail: 1 });
    expect(onPress).toHaveBeenLastCalledWith(false);
  });

  it("expires a primary press that released without a click", () => {
    const onPress = vi.fn();
    render(<PressTarget onPress={onPress} />);
    const row = screen.getByRole("button");
    fireEvent.pointerDown(row, { pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(document.body, { pointerType: "mouse", button: 0 });
    vi.runAllTimers();
    fireEvent.click(row, { detail: 1 });
    expect(onPress).toHaveBeenLastCalledWith(false);
  });

  it("expires a click that never reaches the selection handler", () => {
    const onPress = vi.fn();
    render(<PressTarget onPress={onPress} />);
    const child = screen.getByText("Suppressed child");
    fireEvent.pointerDown(child, { pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(child, { pointerType: "mouse", button: 0 });
    fireEvent.click(child, { detail: 1 });
    expect(onPress).not.toHaveBeenCalled();
    vi.runAllTimers();
    fireEvent.click(screen.getByRole("button"), { detail: 1 });
    expect(onPress).toHaveBeenLastCalledWith(false);
  });

  it.each(["pointercancel", "contextmenu", "keydown", "dragstart", "blur"])("invalidates a press after %s", (eventType) => {
    const onPress = vi.fn();
    render(<PressTarget onPress={onPress} />);
    const row = screen.getByRole("button");
    fireEvent.pointerDown(row, { pointerType: "mouse", button: 0 });
    fireEvent(eventType === "blur" ? window : row, new Event(eventType, { bubbles: true }));
    fireEvent.click(row, { detail: 1 });
    expect(onPress).toHaveBeenLastCalledWith(false);
  });
});
