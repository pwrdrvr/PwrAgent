import { afterEach, describe, expect, it, vi } from "vitest";
import { copyImage } from "../copy-image";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (navigator as { clipboard?: unknown }).clipboard; });

function clipboard() {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
  vi.stubGlobal("ClipboardItem", class { constructor(public data: Record<string, Blob>) {} });
  return write;
}

describe("copyImage", () => {
  it("writes the original PNG blob without decoding or resizing it", async () => {
    const png = new Blob(["original PNG bytes"], { type: "image/png" });
    const fetchImage = vi.fn().mockResolvedValue({ ok: true, blob: async () => png });
    vi.stubGlobal("fetch", fetchImage);
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    const write = clipboard();
    await copyImage("data:image/png;base64,original");
    expect(fetchImage).toHaveBeenCalledWith("data:image/png;base64,original");
    expect(decode).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0][0].data["image/png"]).toBe(png);
  });

  it("converts non-PNG images at their natural dimensions and releases the bitmap", async () => {
    const png = new Blob(["converted"], { type: "image/png" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob([], { type: "image/jpeg" }) }));
    const bitmap = { width: 2400, height: 1600, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    const draw = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback) {
      expect(this.width).toBe(2400);
      expect(this.height).toBe(1600);
      callback(png);
    });
    const write = clipboard();
    await copyImage("original.jpg");
    expect(draw).toHaveBeenCalledWith(bitmap, 0, 0, 2400, 1600);
    expect(encode).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0][0].data["image/png"]).toBe(png);
  });

  it("rasterizes SVG through an image element before copying PNG", async () => {
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"/>'], { type: "image/svg+xml" });
    const png = new Blob(["converted SVG"], { type: "image/png" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => svg }));
    const decode = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("Image", class {
      naturalWidth = 120;
      naturalHeight = 60;
      src = "";
      decode = decode;
    });
    const createObjectURL = vi.fn().mockReturnValue("blob:svg");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const createBitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", createBitmap);
    const draw = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(png);
    });
    const write = clipboard();

    await copyImage("pwragent-image://file/example.svg");

    expect(createObjectURL).toHaveBeenCalledWith(svg);
    expect(decode).toHaveBeenCalledOnce();
    expect(createBitmap).not.toHaveBeenCalled();
    expect(draw).toHaveBeenCalledWith(expect.anything(), 0, 0, 120, 60);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:svg");
    expect(write.mock.calls[0][0][0].data["image/png"]).toBe(png);
  });

  it("rejects failed loads and clipboard writes", async () => {
    const write = clipboard();
    const fetchImage = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchImage);
    await expect(copyImage("missing.png")).rejects.toThrow("loaded");
    expect(write).not.toHaveBeenCalled();
    fetchImage.mockResolvedValue({ ok: true, blob: async () => new Blob([], { type: "image/png" }) });
    write.mockRejectedValueOnce(new Error("Permission denied"));
    await expect(copyImage("original.png")).rejects.toThrow("Permission denied");
  });
});
