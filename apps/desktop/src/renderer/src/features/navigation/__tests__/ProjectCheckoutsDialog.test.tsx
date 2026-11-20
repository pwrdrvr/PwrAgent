import { createRef } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SetProjectCheckoutGroupRequest } from "@pwragent/shared/contracts/navigation";
import { ProjectCheckoutsDialog } from "../ProjectCheckoutsDialog";

function renderDialog(overrides: Partial<Parameters<typeof ProjectCheckoutsDialog>[0]> = {}) {
  const onSave = vi.fn(async (_request: SetProjectCheckoutGroupRequest) => undefined);
  const onClose = vi.fn();
  render(<ProjectCheckoutsDialog
    projectPath="/fixture/Old"
    suggestions={[]}
    returnFocus={createRef<HTMLElement>()}
    pickCheckout={async () => undefined}
    copyPath={vi.fn()}
    onSave={onSave}
    onClose={onClose}
    {...overrides}
  />);
  return { onSave, onClose };
}

function checkoutRow(name: string): HTMLElement {
  const list = screen.getByRole("list", { name: "Checkouts" });
  const row = within(list).getAllByRole("listitem").find((item) => item.textContent?.includes(name));
  if (!row) throw new Error(`no checkout row for ${name}`);
  return row;
}

it("adds a suggested clone and saves only the checkouts the operator chose", async () => {
  const { onSave, onClose } = renderDialog({ suggestions: ["/fixture/Preferred", "/fixture/Separate"] });
  fireEvent.click(screen.getByRole("button", { name: "Add checkout /fixture/Preferred" }));
  fireEvent.click(within(checkoutRow("Preferred")).getByRole("button", { name: /^Make Default/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onSave).toHaveBeenCalledWith({
    projectPath: "/fixture/Old",
    previousPaths: [],
    group: { preferredPath: "/fixture/Preferred", paths: ["/fixture/Old", "/fixture/Preferred"] },
  });
});

it("marks only the default checkout and offers Make Default on the others", () => {
  renderDialog({ checkoutPaths: ["/fixture/Old", "/fixture/New"], repositoryKey: "github.com/acme/widget" });
  expect(screen.getByText("github.com/acme/widget")).toBeTruthy();
  expect(within(checkoutRow("Old")).getByText("Default")).toBeTruthy();
  expect(within(checkoutRow("Old")).queryByRole("button", { name: /^Make Default/ })).toBeNull();
  expect(within(checkoutRow("New")).queryByText("Default")).toBeNull();
  fireEvent.click(within(checkoutRow("New")).getByRole("button", { name: /^Make Default/ }));
  expect(within(checkoutRow("New")).getByText("Default")).toBeTruthy();
  expect(within(checkoutRow("Old")).getByRole("button", { name: /^Make Default/ })).toBeTruthy();
});

it("keeps Save disabled until the group changes", () => {
  renderDialog({ checkoutPaths: ["/fixture/Old", "/fixture/New"] });
  const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.click(within(checkoutRow("New")).getByRole("button", { name: /^Make Default/ }));
  expect(save.disabled).toBe(false);
  fireEvent.click(within(checkoutRow("Old")).getByRole("button", { name: /^Make Default/ }));
  expect(save.disabled).toBe(true);
});

it("never offers to remove the only checkout or an ungrouped project's own checkout", () => {
  renderDialog({ suggestions: ["/fixture/Clone"] });
  expect(screen.queryByRole("button", { name: /^Remove checkout/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add checkout /fixture/Clone" }));
  expect(within(checkoutRow("Old")).queryByRole("button", { name: /^Remove checkout/ })).toBeNull();
  expect(within(checkoutRow("Clone")).getByRole("button", { name: "Remove checkout /fixture/Clone" })).toBeTruthy();
});

it("moves the default to the first remaining checkout when the default is removed", async () => {
  const { onSave } = renderDialog({ checkoutPaths: ["/fixture/Old", "/fixture/New"] });
  fireEvent.click(within(checkoutRow("Old")).getByRole("button", { name: "Remove checkout /fixture/Old" }));
  expect(within(checkoutRow("New")).getByText("Default")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(onSave.mock.calls[0]![0].group).toEqual({ preferredPath: "/fixture/New", paths: ["/fixture/New"] });
});

it("names the reveal action for the platform and passes the full path", () => {
  const revealPath = vi.fn();
  renderDialog({ revealLabel: "Show in Finder", revealPath });
  fireEvent.click(screen.getByRole("button", { name: "Show in Finder: /fixture/Old" }));
  expect(revealPath).toHaveBeenCalledWith("/fixture/Old");
});
