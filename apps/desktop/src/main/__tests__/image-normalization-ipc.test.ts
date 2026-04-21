import { access, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  nativeImage: {
    createFromBuffer: vi.fn(),
  },
}));

function fakeNativeImage(params: {
  empty?: boolean;
  height?: number;
  output?: Buffer;
  width?: number;
}) {
  return {
    isEmpty: () => Boolean(params.empty),
    getSize: () => ({
      width: params.width ?? 32,
      height: params.height ?? 32,
    }),
    toPNG: () => params.output ?? Buffer.from([1, 2, 3]),
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("image normalization ipc", () => {
  it("converts HEIC with Electron when native decode succeeds", async () => {
    const { convertImageUploadFallback } = await import("../ipc/image-normalization");

    await expect(
      convertImageUploadFallback(
        {
          data: new Uint8Array([9, 8, 7]).buffer,
          fileName: "photo.heic",
          mimeType: "image/heic",
        },
        {
          createImageFromBuffer: () =>
            fakeNativeImage({ output: Buffer.from([4, 5, 6]) }) as Electron.NativeImage,
          execFile: vi.fn(),
          platform: "darwin",
        },
      ),
    ).resolves.toEqual({
      dataUrl: "data:image/png;base64,BAUG",
      mimeType: "image/png",
      size: 3,
    });
  });

  it("falls back to sips on macOS when Electron cannot decode HEIC", async () => {
    const { convertImageUploadFallback } = await import("../ipc/image-normalization");
    let outputPath = "";
    const execFile = vi.fn(async (_command: string, args: readonly string[]) => {
      outputPath = args.at(-1) ?? "";
      await writeFile(outputPath, Buffer.from([7, 8, 9]));
      return { stdout: "", stderr: "" };
    });

    await expect(
      convertImageUploadFallback(
        {
          data: new Uint8Array([1, 2, 3]).buffer,
          fileName: "photo.heif",
          mimeType: "image/heif",
        },
        {
          createImageFromBuffer: () =>
            fakeNativeImage({ empty: true }) as Electron.NativeImage,
          execFile,
          platform: "darwin",
        },
      ),
    ).resolves.toEqual({
      dataUrl: "data:image/png;base64,BwgJ",
      mimeType: "image/png",
      size: 3,
    });
    expect(execFile).toHaveBeenCalledWith("/usr/bin/sips", [
      "-s",
      "format",
      "png",
      expect.stringMatching(/input\.heif$/),
      "--out",
      expect.stringMatching(/output\.png$/),
    ]);
    await expect(pathExists(outputPath)).resolves.toBe(false);
  });

  it("falls back to sips on macOS when Electron probing throws", async () => {
    const { convertImageUploadFallback } = await import("../ipc/image-normalization");
    const execFile = vi.fn(async (_command: string, args: readonly string[]) => {
      await writeFile(args.at(-1) ?? "", Buffer.from([7, 8, 9]));
      return { stdout: "", stderr: "" };
    });

    await expect(
      convertImageUploadFallback(
        {
          data: new Uint8Array([1, 2, 3]).buffer,
          fileName: "photo.heic",
          mimeType: "image/heic",
        },
        {
          createImageFromBuffer: () => {
            throw new Error("unsupported");
          },
          execFile,
          platform: "darwin",
        },
      ),
    ).resolves.toMatchObject({
      dataUrl: "data:image/png;base64,BwgJ",
      mimeType: "image/png",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("rejects HEIC conversion without macOS fallback support", async () => {
    const { convertImageUploadFallback } = await import("../ipc/image-normalization");

    await expect(
      convertImageUploadFallback(
        {
          data: new Uint8Array([1]).buffer,
          fileName: "photo.heic",
          mimeType: "image/heic",
        },
        {
          createImageFromBuffer: () =>
            fakeNativeImage({ empty: true }) as Electron.NativeImage,
          execFile: vi.fn(),
          platform: "linux",
        },
      ),
    ).rejects.toThrow("HEIC/HEIF conversion is only available on macOS");
  });

  it("rejects non-HEIC fallback requests", async () => {
    const { convertImageUploadFallback } = await import("../ipc/image-normalization");

    await expect(
      convertImageUploadFallback(
        {
          data: new Uint8Array([1]).buffer,
          fileName: "photo.webp",
          mimeType: "image/webp",
        },
        {
          createImageFromBuffer: () =>
            fakeNativeImage({ empty: true }) as Electron.NativeImage,
          execFile: vi.fn(),
          platform: "darwin",
        },
      ),
    ).rejects.toThrow("only supports HEIC/HEIF");
  });

  it("cleans up temporary files when sips fails", async () => {
    const { convertImageUploadFallback } = await import("../ipc/image-normalization");
    let outputPath = "";
    const execFile = vi.fn(async (_command: string, args: readonly string[]) => {
      outputPath = args.at(-1) ?? "";
      throw new Error("sips exploded");
    });

    await expect(
      convertImageUploadFallback(
        {
          data: new Uint8Array([1]).buffer,
          fileName: "photo.heic",
          mimeType: "image/heic",
        },
        {
          createImageFromBuffer: () =>
            fakeNativeImage({ empty: true }) as Electron.NativeImage,
          execFile,
          platform: "darwin",
        },
      ),
    ).rejects.toThrow("HEIC/HEIF conversion failed: sips exploded");
    await expect(pathExists(outputPath)).resolves.toBe(false);
  });
});
