import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { ThreadExecutionMode } from "@pwragent/shared/contracts/normalized-app-server";
import { resolveProviderAccessControl } from "@pwragent/shared/provider-access-mode";
import { AccessPicker } from "../AccessPicker";
import { accessTrigger, chooseAccessStop, openAccessPicker } from "../../../test/access-picker";

afterEach(() => {
  cleanup();
});

function codexBackend(fullAccessAvailable = true): BackendSummary {
  return {
    kind: "codex",
    label: "Codex",
    available: true,
    executionModes: [
      { mode: "default", label: "Default Access", available: true, isDefault: true },
      { mode: "auto", label: "Auto", available: true },
      { mode: "full-access", label: "Full Access", available: fullAccessAvailable },
    ],
  } as unknown as BackendSummary;
}

function renderPicker(executionMode: ThreadExecutionMode, backend = codexBackend()) {
  const onCommit = vi.fn();
  const control = resolveProviderAccessControl({
    backend,
    state: { executionMode },
    includeUnavailableAuto: true,
  })!;
  render(
    <>
      <AccessPicker
        backend="codex"
        control={control}
        needsConfirmation={(option) => option.requiresFullAccessConfirmation}
        scope="this thread"
        onCommit={onCommit}
      />
      <button type="button">Elsewhere</button>
    </>,
  );
  return { onCommit };
}

describe("AccessPicker", () => {
  it("backs out of a stop waiting for Allow when the current level is chosen again", () => {
    const { onCommit } = renderPicker("default");
    chooseAccessStop("full-access");
    const panel = openAccessPicker();
    expect(within(panel).getByRole("button", { name: "Allow Full Access" })).toBeInTheDocument();

    chooseAccessStop("default");
    expect(within(panel).queryByRole("button", { name: "Allow Full Access" })).not.toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("steps the keyboard from the stop waiting for Allow, not from the committed level", () => {
    const { onCommit } = renderPicker("default");
    chooseAccessStop("full-access");
    const slider = within(openAccessPicker()).getByRole("slider", { name: "Access level" });

    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toMatchObject({ value: "auto" });
    expect(onCommit.mock.calls[0]![1]).toBe(false);
  });

  it("stays open, keeping the stop waiting for Allow, when code moves focus elsewhere", () => {
    renderPicker("default");
    chooseAccessStop("full-access");
    const panel = openAccessPicker();
    const slider = within(panel).getByRole("slider", { name: "Access level" });

    fireEvent.focusOut(slider, { relatedTarget: screen.getByRole("button", { name: "Elsewhere" }) });
    expect(panel).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Allow Full Access" })).toBeInTheDocument();
  });

  it("closes when Tab moves focus out of the panel", () => {
    renderPicker("default");
    const panel = openAccessPicker();
    const slider = within(panel).getByRole("slider", { name: "Access level" });

    fireEvent.keyDown(slider, { key: "Tab" });
    fireEvent.focusOut(slider, { relatedTarget: screen.getByRole("button", { name: "Elsewhere" }) });
    expect(panel).not.toBeInTheDocument();
  });

  it("keeps the Full Access warning for a thread at Full Access the backend does not list", () => {
    // Full Access listed unavailable is filtered out of the options, but the
    // thread still runs at it.
    renderPicker("full-access", codexBackend(false));
    expect(accessTrigger()).toHaveAccessibleName("Access: Full Access");
    expect(accessTrigger()).toHaveClass("access-picker__trigger--danger", "access-picker__trigger--full");
  });
});
