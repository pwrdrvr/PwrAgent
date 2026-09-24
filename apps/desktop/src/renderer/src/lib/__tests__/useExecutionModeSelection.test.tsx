import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ThreadExecutionMode } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useExecutionModeSelection } from "../useExecutionModeSelection";
import { pressEscape, tabEscapes } from "../../test/tab-walk";

afterEach(() => {
  cleanup();
});

function Host(props: {
  applyExecutionMode: (mode: ThreadExecutionMode) => void;
  onLayerKeyDown?: (key: string) => void;
}) {
  const { fullAccessRiskDialog, requestExecutionModeSelection } =
    useExecutionModeSelection({
      applyExecutionMode: props.applyExecutionMode,
      currentExecutionMode: "default",
      dismissed: false,
      onDismiss: async () => undefined,
    });
  return (
    // The Star Map hosts this gate, and its layer reads keys through the
    // React tree the dialog portals out of.
    <div onKeyDown={(event) => props.onLayerKeyDown?.(event.key)}>
      <button
        type="button"
        onClick={() => requestExecutionModeSelection("full-access")}
      >
        Full access
      </button>
      {fullAccessRiskDialog}
    </div>
  );
}

function open(props: Partial<Parameters<typeof Host>[0]> = {}): HTMLElement {
  render(<Host applyExecutionMode={vi.fn()} {...props} />);
  const opener = screen.getByRole("button", { name: "Full access" });
  opener.focus();
  act(() => opener.click());
  return screen.getByRole("dialog", { name: "Enable Full Access?" });
}

describe("Enable Full Access? dialog, keyboard", () => {
  it("moves focus into the dialog on open", () => {
    const dialog = open();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("keeps Tab inside the dialog", () => {
    const dialog = open();
    expect(tabEscapes(dialog)).toEqual({ forward: [], backward: [] });
  });

  it("cancels on Escape, applies nothing, and returns focus to the opener", () => {
    const applyExecutionMode = vi.fn();
    const onLayerKeyDown = vi.fn();
    open({ applyExecutionMode, onLayerKeyDown });
    pressEscape();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(applyExecutionMode).not.toHaveBeenCalled();
    expect(onLayerKeyDown).not.toHaveBeenCalledWith("Escape");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Full access" }),
    );
  });
});
