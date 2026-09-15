import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiagramImage } from "../diagram-image";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mockImage(width: number, height: number) {
  vi.stubGlobal("Image", class {
    naturalWidth = width;
    naturalHeight = height;
    decode = async () => undefined;
  });
  const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png,test");
  return { context, encode };
}

describe("diagram clipboard pixels", () => {
  it("renders two pixels per layout pixel and fills the theme background", async () => {
    const { context, encode } = mockImage(700, 300);
    expect(await createDiagramImage("data:image/svg+xml,test", "black")).toEqual({
      src: "data:image/png,test", width: 700, height: 300,
    });
    expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1400, 600);
    expect(context.fillStyle).toBe("black");
    expect(encode).toHaveBeenCalledWith("image/png");
    // Release the backing store even after a successful export.
    expect((encode.mock.instances[0] as HTMLCanvasElement).width).toBe(0);
  });

  it("bounds exceptionally wide diagrams without changing their display dimensions", async () => {
    const { context } = mockImage(10000, 100);
    const result = await createDiagramImage("data:image/svg+xml,test", "black");
    expect(result.width).toBe(10000);
    expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 8192, 81);
  });

  it("caps total raster pixels", async () => {
    const { context } = mockImage(5000, 5000);
    await createDiagramImage("data:image/svg+xml,test", "black");
    expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 4000, 4000);
  });
});
