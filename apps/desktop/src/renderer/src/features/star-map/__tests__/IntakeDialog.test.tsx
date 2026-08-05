import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { IntakeDialog } from "../IntakeDialog";

const target = {
  instanceId: "pwr_local",
  label: "Mac-Mini-M4",
  icon: "sun" as const,
};

function setup(dispatchResult: unknown) {
  const dispatchStarMapIntake = vi.fn(
    async (_request: { requestId: string; directoryKey?: string }) =>
      dispatchResult as never,
  );
  const desktopApi: DesktopApi = {
    dispatchStarMapIntake,
    onAgentEvent: vi.fn(() => () => undefined),
  };
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <IntakeDialog
      desktopApi={desktopApi}
      target={target}
      onClose={onClose}
      onCreated={onCreated}
    />,
  );
  return { dispatchStarMapIntake, onClose, onCreated };
}

function submitText(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/Give me a task/), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
}

describe("IntakeDialog", () => {
  it("dispatches the request and reports the created thread", async () => {
    const { dispatchStarMapIntake, onClose, onCreated } = setup({
      status: "created",
      requestId: expect.anything(),
      backend: "codex",
      threadId: "thread-1",
    });
    // The stubbed response echoes whatever requestId the dialog generated.
    dispatchStarMapIntake.mockImplementation(
      async (request: { requestId: string }) =>
        ({
          status: "created",
          requestId: request.requestId,
          backend: "codex",
          threadId: "thread-1",
        }) as never,
    );

    submitText("Make a PwrAgent thread for the screenshot issue");

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith({
        instanceId: "pwr_local",
        backend: "codex",
        threadId: "thread-1",
      });
    });
    expect(onClose).toHaveBeenCalled();
    expect(dispatchStarMapIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        request: "Make a PwrAgent thread for the screenshot issue",
      }),
    );
  });

  it("shows disambiguation candidates and resubmits with the pick", async () => {
    const { dispatchStarMapIntake } = setup(undefined);
    dispatchStarMapIntake.mockImplementation(
      async (request: { requestId: string; directoryKey?: string }) =>
        (request.directoryKey
          ? {
              status: "created",
              requestId: request.requestId,
              backend: "codex",
              threadId: "thread-2",
            }
          : {
              status: "needs_disambiguation",
              requestId: request.requestId,
              candidates: [
                { directoryKey: "dir-a", label: "PwrSnap", path: "/r/PwrSnap" },
                { directoryKey: "dir-b", label: "PwrAgent" },
              ],
            }) as never,
    );

    submitText("Do a thing");
    await waitFor(() => {
      expect(screen.getByText("Which project?")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /PwrSnap/ }));
    await waitFor(() => {
      expect(dispatchStarMapIntake).toHaveBeenCalledWith(
        expect.objectContaining({ directoryKey: "dir-a" }),
      );
    });
  });

  it("surfaces failures in the status line", async () => {
    const { dispatchStarMapIntake } = setup(undefined);
    dispatchStarMapIntake.mockImplementation(
      async (request: { requestId: string }) =>
        ({
          status: "failed",
          requestId: request.requestId,
          error: "No backends available",
        }) as never,
    );

    submitText("Anything");
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "No backends available",
      );
    });
  });

  it("keeps the submit disabled while empty", () => {
    setup(undefined);
    const submit = screen.getByRole("button", { name: "Start thread" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });
});
