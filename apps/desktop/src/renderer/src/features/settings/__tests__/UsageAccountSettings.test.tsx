import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsageAccountSettings } from "../UsageAccountSettings";

describe("UsageAccountSettings", () => {
  it("saves explicitly, preserves other providers, and clears to automatic", async () => {
    const groups = { codex: "team", "acp:grok": "personal" };
    const onSave = vi.fn(async () => true);
    const { rerender } = render(<UsageAccountSettings backend="codex" groups={groups} saving={false} onSave={onSave} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Account group" }), { target: { value: " new-team " } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save account group" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ codex: "new-team", "acp:grok": "personal" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    rerender(<UsageAccountSettings backend="codex" groups={{ ...groups, codex: "new-team" }} saving={false} onSave={onSave} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save account group" }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ "acp:grok": "personal" }));
  });

  it("retains the draft and reports a rejected save", async () => {
    const onSave = vi.fn(async () => false);
    render(<UsageAccountSettings backend="acp:grok" groups={{}} saving={false} onSave={onSave} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "team" } });
    fireEvent.click(screen.getByRole("button", { name: "Save account group" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
    expect(screen.getByRole("textbox")).toHaveValue("team");
  });
});
