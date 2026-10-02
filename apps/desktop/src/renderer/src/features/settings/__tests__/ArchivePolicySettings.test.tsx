import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THREAD_ARCHIVE_POLICY } from "@pwragent/shared";
import { ArchivePolicySettings } from "../ArchivePolicySettings";

afterEach(cleanup);

describe("ArchivePolicySettings", () => {
  it("defaults to 20 eligible threads per project and explains protected threads are additional", () => {
    render(<ArchivePolicySettings onWriteConfig={vi.fn(async () => true)} />);
    expect(screen.getByRole("spinbutton", { name: "Eligible threads per project" })).toHaveValue(20);
    expect(screen.getByText(/Keep 20 eligible threads in every project, plus all/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Permanently delete expired archives" })).not.toBeChecked();
  });

  it("switches to seven-day inactivity and persists number edits on blur", async () => {
    const save = vi.fn(async () => true);
    render(<ArchivePolicySettings onWriteConfig={save} />);
    fireEvent.click(screen.getByRole("radio", { name: /Archive after inactivity/ }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ worktrees: { archive: { ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age" } } }));
    const days = screen.getByRole("spinbutton", { name: "Days untouched" });
    expect(days).toHaveValue(7);
    await waitFor(() => expect(days).toBeEnabled());
    fireEvent.change(days, { target: { value: "14" } });
    fireEvent.blur(days);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ worktrees: { archive: { ...DEFAULT_THREAD_ARCHIVE_POLICY, mode: "age", inactivityDays: 14 } } }));
  });

  it("enables a deletion period explicitly and keeps the input editable while empty", async () => {
    const save = vi.fn(async () => true);
    render(<ArchivePolicySettings onWriteConfig={save} />);
    fireEvent.click(screen.getByRole("switch", { name: "Permanently delete expired archives" }));
    const days = await screen.findByRole("spinbutton", { name: "Keep archives for days" });
    expect(days).toHaveValue(30);
    await waitFor(() => expect(days).toBeEnabled());
    fireEvent.change(days, { target: { value: "" } });
    expect(screen.getByRole("spinbutton", { name: "Keep archives for days" })).toBeInTheDocument();
    fireEvent.change(days, { target: { value: "90" } });
    fireEvent.blur(days);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ worktrees: { archive: { ...DEFAULT_THREAD_ARCHIVE_POLICY, retentionDays: 90 } } }));
  });

  it("shows an error and restores the saved policy when persistence fails", async () => {
    render(<ArchivePolicySettings onWriteConfig={vi.fn(async () => false)} />);
    fireEvent.click(screen.getByRole("radio", { name: /Archive after inactivity/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(screen.getByRole("spinbutton", { name: "Eligible threads per project" })).toHaveValue(20);
  });
});
