import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopAutoCompactionRule } from "@pwragent/shared/auto-compaction";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import { AutoCompactionSettings, autoCompactionRulesForProvider } from "../AutoCompactionSettings";

const antigravity = {
  kind: "acp:antigravity",
  label: "Antigravity",
  available: true,
  launchpadOptions: { models: [{ id: "gemini-4-neon", label: "Gemini 4 Neon" }] },
} as unknown as BackendSummary;

function renderSection(saved: DesktopAutoCompactionRule[], backendId = "acp:antigravity") {
  const onSave = vi.fn(async (_rules: DesktopAutoCompactionRule[]) => true);
  render(
    <AutoCompactionSettings
      backendId={backendId}
      providerLabel={backendId === "codex" ? "Codex" : "Antigravity"}
      backends={[antigravity]}
      saved={saved}
      saving={false}
      onSave={onSave}
    />,
  );
  return onSave;
}

describe("AutoCompactionSettings", () => {
  it("lists the Gemini default with its 512k budget and 410k trigger", () => {
    renderSection([]);
    expect(screen.getByText("Gemini models")).toBeInTheDocument();
    expect(screen.getByText("gemini-* · all providers · Default")).toBeInTheDocument();
    expect(screen.getByText("512k budget · 80% · 410k")).toBeInTheDocument();
  });

  it("saves an edit of the default as an override for this provider alone", async () => {
    const onSave = renderSection([{ provider: "codex", model: "gpt-5", enabled: true }]);
    fireEvent.click(screen.getByRole("button", { name: "Edit Gemini models auto-compaction" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Context budget (tokens)" }), {
      target: { value: "300,000" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Compact at (%)" }), { target: { value: "70" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toEqual([
      { provider: "codex", model: "gpt-5", enabled: true },
      {
        provider: "acp:antigravity",
        model: "gemini-*",
        enabled: true,
        contextWindowTokens: 300_000,
        compactAtPercent: 70,
      },
    ]);
  });

  it("refuses a budget outside the accepted range and says why", () => {
    const onSave = renderSection([]);
    fireEvent.click(screen.getByRole("button", { name: "Edit Gemini models auto-compaction" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Context budget (tokens)" }), {
      target: { value: "5000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Budget must be a whole number from 16,384 to 2,000,000 tokens");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("offers Reset to default on a provider override, which removes only that override", async () => {
    const onSave = renderSection([
      { provider: "acp:antigravity", model: "gemini-*", enabled: false },
      { provider: "codex", model: "gpt-5", enabled: true },
    ]);
    expect(screen.getByText("Off")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit Gemini models auto-compaction" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    });
    expect(onSave).toHaveBeenCalledWith([
      { provider: "codex", model: "gpt-5", enabled: true },
    ]);
    expect(screen.queryByRole("button", { name: "Reset to default" })).not.toBeInTheDocument();
  });

  it("explains that Codex waits for the turn to end and offers no steering choice", () => {
    renderSection([], "codex");
    expect(screen.getByText(/Codex compacts between turns/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit Gemini models auto-compaction" }));
    expect(screen.queryByText("During a turn")).not.toBeInTheDocument();
  });

  it("keeps one editor open at a time so a draft is never dropped by switching rows", () => {
    renderSection([{ provider: "acp:antigravity", model: "gemini-4-neon", enabled: true, contextWindowTokens: 300_000 }]);
    const neon = screen.getByRole("button", { name: "Edit Gemini 4 Neon auto-compaction" });
    const family = screen.getByRole("button", { name: "Edit Gemini models auto-compaction" });
    fireEvent.click(neon);
    expect(neon).toHaveAttribute("aria-expanded", "true");
    expect(neon).toBeEnabled();
    expect(family).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add a rule" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(family).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add a rule" })).toBeInTheDocument();
  });

  it("hides the every-provider rule a provider rule replaces", () => {
    const rules = autoCompactionRulesForProvider([
      { provider: "acp:antigravity", model: "gemini-*", enabled: true, contextWindowTokens: 300_000 },
    ], "acp:antigravity");
    expect(rules.map((rule) => rule.provider)).toEqual(["acp:antigravity"]);
    expect(autoCompactionRulesForProvider([], "acp:gemini").map((rule) => rule.model)).toEqual(["gemini-*"]);
  });
});
