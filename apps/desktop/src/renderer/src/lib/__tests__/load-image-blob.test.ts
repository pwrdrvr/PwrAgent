import { afterEach, describe, expect, it, vi } from "vitest";
import { loadImageBlob } from "../load-image-blob";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as Window & { pwragent?: unknown }).pwragent;
});

describe("loadImageBlob", () => {
  it("uses the scoped main-process read for a local transcript image", async () => {
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const dataBase64 = btoa(String.fromCharCode(...bytes));
    const readTranscriptImage = vi.fn().mockResolvedValue({
      dataBase64,
      mimeType: "image/svg+xml",
    });
    (window as Window & { pwragent?: unknown }).pwragent = { readTranscriptImage };
    const fetchImage = vi.fn();
    vi.stubGlobal("fetch", fetchImage);

    const blob = await loadImageBlob("pwragent-image://file/graph.svg");

    expect(readTranscriptImage).toHaveBeenCalledWith("pwragent-image://file/graph.svg");
    expect(fetchImage).not.toHaveBeenCalled();
    expect(blob.type).toBe("image/svg+xml");
    expect(await blob.text()).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
  });
});
