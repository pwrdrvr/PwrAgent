import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopOnboardingCodexProfileModel,
  DesktopOnboardingThreadPresentation,
} from "@pwragent/shared";
import { OnboardingWizard } from "../OnboardingWizard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWizard() {
  const onComplete = vi.fn(async () => undefined);
  const onSkip = vi.fn(async () => undefined);
  const onThreadPresentationChange = vi.fn(
    async (_value: DesktopOnboardingThreadPresentation) => undefined,
  );
  const onCodexProfileModelChange = vi.fn(
    async (_value: DesktopOnboardingCodexProfileModel) => undefined,
  );

  function Harness() {
    const [threadPresentation, setThreadPresentation] =
      useState<DesktopOnboardingThreadPresentation>("mission_control");
    const [codexProfileModel, setCodexProfileModel] =
      useState<DesktopOnboardingCodexProfileModel>("shared");

    return (
      <OnboardingWizard
        codexProfileModel={codexProfileModel}
        mode="auto"
        threadPresentation={threadPresentation}
        onCodexProfileModelChange={async (value) => {
          await onCodexProfileModelChange(value);
          setCodexProfileModel(value);
        }}
        onComplete={onComplete}
        onSkip={onSkip}
        onThreadPresentationChange={async (value) => {
          await onThreadPresentationChange(value);
          setThreadPresentation(value);
        }}
      />
    );
  }

  render(<Harness />);

  return {
    onCodexProfileModelChange,
    onComplete,
    onSkip,
    onThreadPresentationChange,
  };
}

describe("OnboardingWizard", () => {
  it("persists the selected thread presentation", async () => {
    const callbacks = renderWizard();

    fireEvent.click(screen.getByRole("radio", { name: /Compact/ }));

    await waitFor(() => {
      expect(callbacks.onThreadPresentationChange).toHaveBeenCalledWith(
        "compact",
      );
    });
    expect(screen.getByRole("radio", { name: /Compact/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("persists the selected Codex profile model", async () => {
    const callbacks = renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Codex Profile Model" });

    fireEvent.click(screen.getByRole("radio", { name: /Isolated/ }));

    await waitFor(() => {
      expect(callbacks.onCodexProfileModelChange).toHaveBeenCalledWith(
        "isolated",
      );
    });
    expect(screen.getByRole("radio", { name: /Isolated/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
