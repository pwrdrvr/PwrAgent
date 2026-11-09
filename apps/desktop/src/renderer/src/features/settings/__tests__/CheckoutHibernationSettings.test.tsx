import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHECKOUT_HIBERNATION_POLICY } from "@pwragent/shared";
import { CheckoutHibernationSettings } from "../CheckoutHibernationSettings";
import { archiveSweepSummaryLines } from "../ArchivePolicySettings";
import { chooseSelectOption, selectOptionLabels } from "../../../test/select";

afterEach(cleanup);

describe("CheckoutHibernationSettings", () => {
  it("is on by default with a 7-day idle period, a 100 MB limit, and restore on send", () => {
    render(<CheckoutHibernationSettings onWriteConfig={vi.fn(async () => true)} />);
    expect(screen.getByRole("switch", { name: "Hibernate idle checkouts" })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Days idle" })).toHaveValue(7);
    const limit = screen.getByRole("combobox", { name: "Largest snapshot" });
    expect(limit).toHaveAttribute("data-value", "100");
    expect(selectOptionLabels(limit)).toEqual(["5 MB", "10 MB", "25 MB", "50 MB", "100 MB"]);
    // Ignored files never keep a checkout, so there is nothing to switch.
    expect(screen.queryByRole("switch", { name: /rebuildable|ignored/i })).toBeNull();
    expect(screen.getByText(/Tracked and non-ignored changes are saved; a checkout with more than this is kept\. Ignored files are deleted and not restored\./))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/any ignored file keeps/i);
    expect(screen.getByRole("radio", { name: /On send/ })).toHaveAttribute("aria-checked", "true");
  });

  it("writes each change to [worktrees.hibernate] as it is made", async () => {
    const save = vi.fn(async () => true);
    render(<CheckoutHibernationSettings onWriteConfig={save} />);
    fireEvent.click(screen.getByRole("switch", { name: "Hibernate idle checkouts" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ worktrees: { hibernate: { ...DEFAULT_CHECKOUT_HIBERNATION_POLICY, enabled: false } } }));
    fireEvent.click(screen.getByRole("switch", { name: "Hibernate idle checkouts" }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ worktrees: { hibernate: { ...DEFAULT_CHECKOUT_HIBERNATION_POLICY, enabled: true } } }));
    const limit = screen.getByRole("combobox", { name: "Largest snapshot" });
    await waitFor(() => expect(limit).toBeEnabled());
    chooseSelectOption(limit, "25 MB");
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ worktrees: { hibernate: expect.objectContaining({ enabled: true, maxSnapshotMb: 25 }) } }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /On open/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("radio", { name: /On open/ }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ worktrees: { hibernate: expect.objectContaining({ restoreOn: "open" }) } }));
  });

  it("accepts any idle period, since nothing archives threads on a timer", async () => {
    const save = vi.fn(async () => true);
    render(<CheckoutHibernationSettings onWriteConfig={save}
      value={{ ...DEFAULT_CHECKOUT_HIBERNATION_POLICY, idleDays: 9 }} />);
    const days = screen.getByRole("spinbutton", { name: "Days idle" });
    expect(days).toHaveValue(9);
    fireEvent.change(days, { target: { value: "30" } });
    fireEvent.blur(days);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ worktrees: { hibernate: expect.objectContaining({ enabled: true, idleDays: 30 }) } }));
  });

  it("restores the saved value when a write fails", async () => {
    render(<CheckoutHibernationSettings onWriteConfig={vi.fn(async () => false)} />);
    fireEvent.click(screen.getByRole("switch", { name: "Hibernate idle checkouts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Hibernation settings could not be saved.");
    expect(screen.getByRole("switch", { name: "Hibernate idle checkouts" })).toBeChecked();
  });
});

describe("archiveSweepSummaryLines", () => {
  it("reports the hibernation pass only when it ran", () => {
    const base = { running: false, deleted: 0, failed: 0 };
    expect(archiveSweepSummaryLines({ ...base, hibernation: { checked: 3, hibernated: 1, kept: { "Recently active": 2 } } }))
      .toEqual(["Hibernated 1 idle checkout. Kept 2: Recently active (2)."]);
    expect(archiveSweepSummaryLines({ ...base, hibernation: { checked: 0, hibernated: 0, kept: {}, skipped: "Hibernation is off" } }))
      .toEqual([]);
  });
});
