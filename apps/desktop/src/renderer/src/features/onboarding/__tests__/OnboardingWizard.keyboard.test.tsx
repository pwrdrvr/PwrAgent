import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { DesktopBootInfo, DesktopSettingsSnapshot } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppearanceController } from "../../../lib/useAppearance";
import type { DesktopSettingsState } from "../../settings/useDesktopSettings";
import { OnboardingWizard } from "../OnboardingWizard";
import { pressEscape, pressTab, tabEscapes } from "../../../test/tab-walk";

afterEach(() => {
  cleanup();
});

const appearanceController = {
  appearance: {},
  setTheme: vi.fn(),
  setDensity: vi.fn(),
  setSidebarTextSize: vi.fn(),
  setTranscriptTextSize: vi.fn(),
  setAppearance: vi.fn(),
} as unknown as AppearanceController;

const settings = {
  snapshot: {
    models: { codex: { discovery: { candidates: [] }, profiles: { profiles: [] } } },
  } as unknown as DesktopSettingsSnapshot,
} as unknown as DesktopSettingsState;

/** Help → Replay onboarding, or the first-run bootstrap window. */
function Host(props: {
  bootInfo: DesktopBootInfo | null;
  onDismiss: (persistCompleted: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Replay onboarding
      </button>
      {open ? (
        <OnboardingWizard
          appearanceController={appearanceController}
          bootInfo={props.bootInfo}
          initialCodexProfileModel="shared"
          initialDensity="mission-control"
          initialTheme="dark"
          isReplay={props.bootInfo === null}
          settings={settings}
          onComplete={() => undefined}
          onDismiss={(persistCompleted) => {
            props.onDismiss(persistCompleted);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function open(bootInfo: DesktopBootInfo | null = null) {
  const onDismiss = vi.fn();
  render(<Host bootInfo={bootInfo} onDismiss={onDismiss} />);
  const opener = screen.getByRole("button", { name: "Replay onboarding" });
  opener.focus();
  act(() => opener.click());
  return {
    wizard: screen.getByRole("dialog", { name: "First-run setup" }),
    onDismiss,
    opener,
  };
}

const bootstrap: DesktopBootInfo = {
  mode: "bootstrap",
  decisionKind: "no-profile-configured",
};

describe("Onboarding wizard, keyboard", () => {
  it("takes focus when it opens", () => {
    const { wizard } = open();
    expect(wizard.contains(document.activeElement)).toBe(true);
  });

  it("keeps Tab inside the wizard", () => {
    const { wizard } = open();
    expect(tabEscapes(wizard)).toEqual({ forward: [], backward: [] });
  });

  it("closes a replay on Escape and returns focus to what opened it", () => {
    const { onDismiss, opener } = open();
    pressEscape();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog", { name: "First-run setup" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("Onboarding wizard's Skip setup? prompt, keyboard", () => {
  function openPrompt() {
    const opened = open(bootstrap);
    // Somewhere in the wizard, as the operator would be.
    pressTab();
    const behind = document.activeElement;
    pressEscape();
    const prompt = screen.getByRole("dialog", { name: "Skip setup?" });
    return { ...opened, prompt, behind };
  }

  it("opens on Escape with focus on the choice that changes nothing", () => {
    const { onDismiss } = openPrompt();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel — back to setup" }),
    );
  });

  it("keeps Tab inside the prompt, not the wizard behind it", () => {
    const { prompt } = openPrompt();
    expect(tabEscapes(prompt)).toEqual({ forward: [], backward: [] });
  });

  it("closes only itself on a second Escape, and hands focus back to the wizard", () => {
    const { onDismiss, behind } = openPrompt();
    pressEscape();
    expect(screen.queryByRole("dialog", { name: "Skip setup?" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "First-run setup" })).toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(behind);
  });
});
