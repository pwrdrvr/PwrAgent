import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProjectCheckoutsDialog } from "../ProjectCheckoutsDialog";

it("adds a suggested clone and saves only the checkouts the operator chose", async () => {
  const onSave = vi.fn(async () => undefined);
  const onClose = vi.fn();
  render(<ProjectCheckoutsDialog
    projectPath="/fixture/Old"
    suggestions={["/fixture/Preferred", "/fixture/Separate"]}
    returnFocus={createRef<HTMLElement>()}
    pickCheckout={async () => undefined}
    copyPath={vi.fn()}
    onSave={onSave}
    onClose={onClose}
  />);
  fireEvent.click(screen.getByRole("button", { name: "Add checkout /fixture/Preferred" }));
  fireEvent.click(screen.getByRole("radio", { name: "/fixture/Preferred" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onSave).toHaveBeenCalledWith({
    projectPath: "/fixture/Old",
    previousPaths: [],
    group: { preferredPath: "/fixture/Preferred", paths: ["/fixture/Old", "/fixture/Preferred"] },
  });
});
