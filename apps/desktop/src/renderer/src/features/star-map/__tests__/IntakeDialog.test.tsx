import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { IntakeDialog } from "../IntakeDialog";

const normalizeImageFileMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/image-normalization", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/image-normalization")>(),
  normalizeImageFile: normalizeImageFileMock,
}));

const target = {
  instanceId: "pwr_local",
  label: "Mac-Mini-M4",
  icon: "sun" as const,
};

function setup(
  dispatchResult: unknown,
  intakeTarget: Parameters<typeof IntakeDialog>[0]["target"] = target,
  pastedImageMaxPatches?: number,
) {
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
      pastedImageMaxPatches={pastedImageMaxPatches}
      target={intakeTarget}
      onClose={onClose}
      onCreated={onCreated}
    />,
  );
  return { dispatchStarMapIntake, onClose, onCreated };
}

function pastePng(bytes = new Uint8Array([137, 80, 78, 71])) {
  const file = new File([bytes], "screenshot.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: vi.fn(async () => bytes.buffer.slice(0)),
  });
  fireEvent.paste(screen.getByPlaceholderText(/Give me a task/), {
    clipboardData: {
      files: [file],
      items: [
        {
          getAsFile: () => file,
          kind: "file",
          type: "image/png",
        },
      ],
    },
  });
  return { bytes, file };
}

function pasteImage(file: File, type: string): void {
  fireEvent.paste(screen.getByPlaceholderText(/Give me a task/), {
    clipboardData: {
      files: [file],
      items: [
        {
          getAsFile: () => file,
          kind: "file",
          type,
        },
      ],
    },
  });
}

function submitText(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/Give me a task/), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
}

describe("IntakeDialog", () => {
  beforeEach(() => {
    normalizeImageFileMock.mockReset();
    normalizeImageFileMock.mockImplementation(async (file: File) => ({
      conversionPath: "renderer",
      dataUrl: "data:image/png;base64,iVBORw==",
      height: 1,
      mimeType: "image/png",
      original: {
        height: 1,
        mimeType: file.type || "image/png",
        name: file.name,
        size: file.size,
        width: 1,
      },
      size: 4,
      width: 1,
    }));
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:intake-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

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

  it("pastes an image and dispatches typed bytes instead of a data URL", async () => {
    const { dispatchStarMapIntake } = setup(undefined);
    dispatchStarMapIntake.mockImplementation(
      async (request: { requestId: string }) =>
        ({
          status: "created",
          requestId: request.requestId,
          backend: "codex",
          threadId: "thread-image",
        }) as never,
    );
    const { bytes } = pastePng();

    await waitFor(() => {
      expect(screen.getByLabelText("Task images")).toBeTruthy();
    });
    submitText("Fix the screenshot issue in PwrAgent");

    await waitFor(() => {
      expect(dispatchStarMapIntake).toHaveBeenCalled();
    });
    const request = dispatchStarMapIntake.mock.calls[0]?.[0] as {
      imageUploads?: Array<{
        bytes: Uint8Array;
        mimeType: string;
        name: string;
      }>;
    };
    expect(request.imageUploads).toHaveLength(1);
    expect(request.imageUploads?.[0]).toMatchObject({
      mimeType: "image/png",
      name: "screenshot.png",
    });
    expect(request.imageUploads?.[0]?.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(request.imageUploads?.[0]?.bytes ?? [])).toEqual(
      Array.from(bytes),
    );
    expect(request.imageUploads?.[0]?.bytes).not.toEqual(
      expect.any(String),
    );
  });

  it("keeps the federation target beside binary image uploads", async () => {
    const federationTarget = {
      instanceId: "peer-1",
      scope: "remote" as const,
    };
    const { dispatchStarMapIntake } = setup(undefined, {
      federationTarget,
      instanceId: "peer-1",
      label: "Studio Mac",
    });
    dispatchStarMapIntake.mockImplementation(
      async (request: { requestId: string }) =>
        ({
          status: "created",
          requestId: request.requestId,
          backend: "codex",
          threadId: "remote-thread-image",
        }) as never,
    );
    pastePng(new Uint8Array([1, 2, 3]));
    await waitFor(() => {
      expect(screen.getByLabelText("Task images")).toBeTruthy();
    });
    submitText("Fix this in PwrAgent");

    await waitFor(() => {
      expect(dispatchStarMapIntake).toHaveBeenCalledWith(
        expect.objectContaining({
          federationTarget,
          imageUploads: [
            expect.objectContaining({
              bytes: expect.any(Uint8Array),
              mimeType: "image/png",
            }),
          ],
        }),
      );
    });
  });

  it("normalizes non-GIF images before dispatching renderer bytes", async () => {
    const { dispatchStarMapIntake } = setup(undefined, target, 321);
    dispatchStarMapIntake.mockImplementation(
      async (request: { requestId: string }) => ({
        status: "created",
        requestId: request.requestId,
        backend: "codex",
        threadId: "thread-normalized-image",
      }) as never,
    );
    normalizeImageFileMock.mockResolvedValueOnce({
      conversionPath: "heic-fallback",
      dataUrl: "data:image/jpeg;base64,/9j/",
      height: 480,
      mimeType: "image/jpeg",
      original: {
        height: 3_000,
        mimeType: "image/heic",
        name: "camera.heic",
        size: 12,
        width: 4_000,
      },
      size: 3,
      width: 640,
    });
    const file = new File([Uint8Array.from([1, 2, 3])], "camera.heic", {
      type: "image/heic",
    });
    pasteImage(file, "image/heic");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Remove camera.jpg" }))
        .toBeTruthy();
    });
    submitText("Inspect this camera image");

    await waitFor(() => expect(dispatchStarMapIntake).toHaveBeenCalled());
    expect(normalizeImageFileMock).toHaveBeenCalledWith(
      file,
      expect.objectContaining({
        maxPatchCount: 321,
        sourceMimeType: "image/heic",
      }),
    );
    expect(dispatchStarMapIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUploads: [{
          bytes: expect.any(Uint8Array),
          mimeType: "image/jpeg",
          name: "camera.jpg",
        }],
      }),
    );
  });

  it("removes a pasted image before dispatch", async () => {
    const { dispatchStarMapIntake } = setup(undefined);
    dispatchStarMapIntake.mockImplementation(
      async (request: { requestId: string }) =>
        ({
          status: "created",
          requestId: request.requestId,
          backend: "codex",
          threadId: "thread-without-image",
        }) as never,
    );
    pastePng();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Remove screenshot.png" }))
        .toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove screenshot.png" }),
    );
    submitText("Fix this in PwrAgent");

    await waitFor(() => {
      expect(dispatchStarMapIntake).toHaveBeenCalled();
    });
    expect(dispatchStarMapIntake.mock.calls[0]?.[0]).not.toHaveProperty(
      "imageUploads",
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:intake-image");
  });
});
