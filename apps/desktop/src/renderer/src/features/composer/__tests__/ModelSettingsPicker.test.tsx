import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ModelSettingsPicker } from "../ModelSettingsPicker";

afterEach(cleanup);

function renderPicker() {
  render(
    <>
      <ModelSettingsPicker
        model={{
          value: "opus", label: "Opus 5.5", kind: "claude",
          models: [{ id: "opus", label: "Opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }],
          onChange: () => undefined,
        }}
        effort={{ stops: ["low", "high"], value: "high", onChange: () => undefined }}
      />
      <textarea aria-label="Prompt" />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Model settings/ }));
  return screen.getByRole("dialog", { name: "Model settings" });
}

/**
 * The panel stays while the operator chooses in it. A composer once sent
 * focus to its prompt after every change, and the panel closed under the
 * cursor after one click.
 */
describe("ModelSettingsPicker focus", () => {
  it("stays open when code moves focus out of it, and closes when Tab leaves it", async () => {
    const panel = renderPicker();
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    const option = screen.getByRole("option", { name: "Sonnet 5.5" });
    await act(async () => { fireEvent.blur(option, { relatedTarget: prompt }); });
    expect(screen.queryByRole("dialog")).toBe(panel);

    await act(async () => {
      fireEvent.keyDown(option, { key: "Tab" });
      fireEvent.blur(option, { relatedTarget: prompt });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on a pointer press outside it", async () => {
    renderPicker();
    await act(async () => { fireEvent.pointerDown(screen.getByRole("textbox", { name: "Prompt" })); });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
