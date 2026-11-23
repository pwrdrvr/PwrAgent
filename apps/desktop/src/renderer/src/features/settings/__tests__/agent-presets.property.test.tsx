import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentPreset } from "@pwragent/shared/contracts/agent-presets";
import type { NavigationLaunchpadDraft } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../../../lib/desktop-api";
import { AgentPresetDialog } from "../../composer/AgentPresetDialog";
import { AgentPresetsSettings } from "../AgentPresetsSettings";

const preset: AgentPreset = { id: "preset", name: "Fixture reviewer", instructions: "Check the change log", mcpConnectionIds: ["fixture-mcp"] };
const launchpad: NavigationLaunchpadDraft = { directoryKey: "directory:fixture", directoryKind: "directory", directoryLabel: "Fixture",
  workMode: "local", executionMode: "auto", backend: "codex", prompt: "", createdAt: 1, updatedAt: 1,
  agent: { name: preset.name, instructions: preset.instructions }, agentPresetId: preset.id, mcpConnectionIds: preset.mcpConnectionIds };

function desktopApi(outage: boolean, presets = [preset]) {
  const manageAgentPresets = vi.fn(async () => presets);
  const listMcpConnections = vi.fn(async () => {
    if (outage) throw new Error("Fixture inventory outage");
    return { connections: [] };
  });
  return { manageAgentPresets, listMcpConnections } satisfies Partial<DesktopApi>;
}

afterEach(cleanup);

describe("Agent preset surfaces", () => {
  it.each([true, false])("can load and edit saved presets independently of the inventory (outage %s)", async (outage) => {
    const api = desktopApi(outage);
    await act(async () => { render(<AgentPresetsSettings desktopApi={api as DesktopApi} />); });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Changed instructions" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save preset" })); });
    expect(api.manageAgentPresets).toHaveBeenCalledWith(expect.objectContaining({
      action: "save", preset: expect.objectContaining({ instructions: "Changed instructions", mcpConnectionIds: preset.mcpConnectionIds }),
    }));
  });

  it.each([true, false])("applies an instructions-only preset independently of the inventory (outage %s)", async (outage) => {
    const withoutConnections = { ...preset, mcpConnectionIds: [] };
    const onApply = vi.fn(async () => {});
    await act(async () => { render(<AgentPresetDialog desktopApi={desktopApi(outage, [withoutConnections]) as DesktopApi}
      launchpad={{ ...launchpad, mcpConnectionIds: [] }} onClose={() => {}} onApply={onApply} />); });
    const done = screen.getByRole("button", { name: "Done" });
    await waitFor(() => expect(done).not.toBeDisabled());
    await act(async () => { fireEvent.click(done); });
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ instructions: preset.instructions, mcpConnectionIds: [] }), preset.id);
  });

  it.each([true, false])("preserves the distinction between a disappeared preset and choosing Custom (present %s)", async (present) => {
    const onApply = vi.fn(async () => {});
    await act(async () => { render(<AgentPresetDialog desktopApi={desktopApi(false, present ? [preset] : []) as DesktopApi}
      launchpad={launchpad} onClose={() => {}} onApply={onApply} />); });
    const done = screen.getByRole("button", { name: "Done" });
    await waitFor(() => expect(done).not.toBeDisabled());
    if (present) {
      fireEvent.click(screen.getByRole("combobox", { name: "Start from" }));
      fireEvent.click(screen.getByRole("option", { name: "Custom" }));
    }
    await act(async () => { fireEvent.click(done); });
    expect(onApply).toHaveBeenCalledWith(expect.anything(), present ? undefined : preset.id);
  });

  it("can focus the composer dialog itself when its controls are disabled", async () => {
    await act(async () => { render(<AgentPresetDialog desktopApi={desktopApi(false) as DesktopApi}
      launchpad={launchpad} onClose={() => {}} onApply={async () => {}} />); });
    const dialog = screen.getByRole("dialog", { name: "Agent for this thread" });
    dialog.focus();
    expect(dialog).toHaveFocus();
  });
});
