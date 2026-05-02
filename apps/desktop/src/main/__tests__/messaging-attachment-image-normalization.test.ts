import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: vi.fn(),
  },
}));

import {
  calculateBoundedDimensions,
  normalizeMessagingImageAttachment,
} from "../messaging/attachment-image-normalization";

describe("messaging attachment image normalization", () => {
  it("keeps the medium profile aligned with current paste bounds", async () => {
    const resize = vi.fn(() => fakeNativeImage(1536, 1024, 10));
    const image = fakeNativeImage(3000, 2000, 12, { resize });

    const result = await normalizeMessagingImageAttachment({
      data: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg",
      profile: "medium",
      dependencies: {
        createImageFromBuffer: () => image,
      },
    });

    expect(resize).toHaveBeenCalledWith({
      height: 1024,
      quality: "best",
      width: 1536,
    });
    expect(result).toMatchObject({
      height: 1024,
      mimeType: "image/jpeg",
      width: 1536,
    });
  });

  it("preserves actual dimensions when the actual profile is selected", () => {
    expect(
      calculateBoundedDimensions({
        height: 2000,
        maxLongEdge: 8192,
        maxShortEdge: 8192,
        preserveActual: true,
        width: 3000,
      }),
    ).toEqual({ height: 2000, width: 3000 });
  });

  it("normalizes GIF input to PNG", async () => {
    const result = await normalizeMessagingImageAttachment({
      data: new Uint8Array([1, 2, 3]),
      mimeType: "image/gif",
      profile: "medium",
      dependencies: {
        createImageFromBuffer: () => fakeNativeImage(320, 240, 5),
      },
    });

    expect(result.mimeType).toBe("image/png");
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
  });
});

function fakeNativeImage(
  width: number,
  height: number,
  outputBytes: number,
  overrides: Partial<Electron.NativeImage> = {},
): Electron.NativeImage {
  return {
    getSize: () => ({ height, width }),
    isEmpty: () => false,
    resize: () => fakeNativeImage(width, height, outputBytes),
    toJPEG: () => Buffer.alloc(outputBytes),
    toPNG: () => Buffer.alloc(outputBytes),
    ...overrides,
  } as Electron.NativeImage;
}
