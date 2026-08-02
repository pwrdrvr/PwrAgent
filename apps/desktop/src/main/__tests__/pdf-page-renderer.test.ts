import { describe, expect, it } from "vitest";
import { calculatePdfRenderDimensions } from "../messaging/pdf-page-renderer";

describe("PDF page renderer", () => {
  it("uses the full high-profile bounds to rasterize a landscape vector page", () => {
    expect(
      calculatePdfRenderDimensions({
        height: 792,
        profile: "high",
        width: 1224,
      }),
    ).toEqual({ height: 1988, width: 3072 });
  });

  it("preserves the aspect ratio inside every profile's bounds", () => {
    expect(
      calculatePdfRenderDimensions({
        height: 792,
        profile: "medium",
        width: 1224,
      }),
    ).toEqual({ height: 1024, width: 1583 });
    expect(
      calculatePdfRenderDimensions({
        height: 1224,
        profile: "high",
        width: 792,
      }),
    ).toEqual({ height: 3072, width: 1988 });
  });
});
