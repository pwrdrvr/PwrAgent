import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  hasVisibleStarMapContentInView,
  resolveRestoredStarMapView,
  serializeStarMapWorkspaceView,
  type StarMapContentBox,
  type StarMapView,
  type StarMapViewAnchorPoint,
} from "../star-map-view-geometry";

function bodyBox(x: number, y: number, half = 74): StarMapContentBox {
  return { left: x - half, top: y - half, right: x + half, bottom: y + half };
}

describe("star map view persistence properties", () => {
  it("preserves the framed anchor offset across arbitrary canvas rebasing and viewport resizes", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 800, max: 2400 }),
        fc.integer({ min: 560, max: 1600 }),
        fc.integer({ min: 800, max: 2400 }),
        fc.integer({ min: 560, max: 1600 }),
        fc.double({ min: MIN_ZOOM, max: MAX_ZOOM, noNaN: true }),
        fc.integer({ min: 1000, max: 4000 }),
        fc.integer({ min: 1000, max: 4000 }),
        fc.integer({ min: -200, max: 200 }),
        fc.integer({ min: -200, max: 200 }),
        fc.integer({ min: 1500, max: 8000 }),
        fc.integer({ min: 1500, max: 8000 }),
        (
          saveVw,
          saveVh,
          restoreVw,
          restoreVh,
          scale,
          oldAnchorX,
          oldAnchorY,
          offsetX,
          offsetY,
          newAnchorX,
          newAnchorY,
        ) => {
          const saveViewport = { width: saveVw, height: saveVh };
          const restoreViewport = { width: restoreVw, height: restoreVh };
          const savedWorldCenterX = oldAnchorX + offsetX;
          const savedWorldCenterY = oldAnchorY + offsetY;
          const savedView: StarMapView = {
            scale,
            x: saveViewport.width / 2 - savedWorldCenterX * scale,
            y: saveViewport.height / 2 - savedWorldCenterY * scale,
          };
          const oldAnchors: StarMapViewAnchorPoint[] = [
            {
              anchor: { kind: "instance", instanceId: "pwr_m5" },
              x: oldAnchorX,
              y: oldAnchorY,
            },
            {
              anchor: { kind: "instance", instanceId: "pwr_m2" },
              x: oldAnchorX + 3000,
              y: oldAnchorY + 2500,
            },
          ];

          const serialized = serializeStarMapWorkspaceView({
            view: savedView,
            viewport: saveViewport,
            anchors: oldAnchors,
          });
          expect(serialized.anchor).toEqual({
            kind: "instance",
            instanceId: "pwr_m5",
          });

          // Rebase the canvas so the anchor sits anywhere in a roomy new canvas.
          const newCanvas = {
            width: newAnchorX + 4000,
            height: newAnchorY + 4000,
          };
          const newAnchors: StarMapViewAnchorPoint[] = [
            {
              anchor: { kind: "instance", instanceId: "pwr_m5" },
              x: newAnchorX,
              y: newAnchorY,
            },
          ];
          const restored = resolveRestoredStarMapView({
            saved: serialized,
            anchors: newAnchors,
            contentBoxes: [bodyBox(newAnchorX, newAnchorY)],
            canvas: newCanvas,
            viewport: restoreViewport,
          });

          expect(restored).toBeDefined();
          // The framed world point (newAnchor + offset) must land back at the
          // restored viewport's centre.
          const screenX = (newAnchorX + offsetX) * restored!.scale + restored!.x;
          const screenY = (newAnchorY + offsetY) * restored!.scale + restored!.y;
          expect(screenX).toBeCloseTo(restoreViewport.width / 2, 4);
          expect(screenY).toBeCloseTo(restoreViewport.height / 2, 4);
          expect(
            hasVisibleStarMapContentInView({
              view: restored!,
              viewport: restoreViewport,
              contentBoxes: [bodyBox(newAnchorX, newAnchorY)],
            }),
          ).toBe(true);
        },
      ),
    );
  });

  it("never restores a view that leaves all drawn content off-screen", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 800, max: 1800 }),
        fc.integer({ min: 560, max: 1200 }),
        fc.integer({ min: -20_000, max: 20_000 }),
        fc.integer({ min: -20_000, max: 20_000 }),
        fc.double({ min: MIN_ZOOM, max: MAX_ZOOM, noNaN: true }),
        fc.integer({ min: 300, max: 3000 }),
        fc.integer({ min: 300, max: 3000 }),
        (vw, vh, rawX, rawY, scale, bodyX, bodyY) => {
          const viewport = { width: vw, height: vh };
          const canvas = { width: 8000, height: 8000 };
          const contentBoxes = [bodyBox(bodyX, bodyY)];
          const resolved = resolveRestoredStarMapView({
            saved: { x: rawX, y: rawY, scale },
            anchors: [
              {
                anchor: { kind: "instance", instanceId: "pwr_local" },
                x: bodyX,
                y: bodyY,
              },
            ],
            contentBoxes,
            canvas,
            viewport,
          });
          if (resolved !== undefined) {
            expect(
              hasVisibleStarMapContentInView({
                view: resolved,
                viewport,
                contentBoxes,
              }),
            ).toBe(true);
          }
        },
      ),
    );
  });

  it("rejects an anchored view whose target instance was hidden or removed", () => {
    const serialized = serializeStarMapWorkspaceView({
      view: { x: 100, y: 100, scale: 1 },
      viewport: { width: 1280, height: 800 },
      anchors: [
        {
          anchor: { kind: "instance", instanceId: "pwr_offline" },
          x: 540,
          y: 300,
        },
      ],
    });
    const resolved = resolveRestoredStarMapView({
      saved: serialized,
      anchors: [
        {
          anchor: { kind: "instance", instanceId: "pwr_local" },
          x: 540,
          y: 300,
        },
      ],
      contentBoxes: [bodyBox(540, 300)],
      canvas: { width: 2000, height: 2000 },
      viewport: { width: 1280, height: 800 },
    });
    expect(resolved).toBeUndefined();
  });

  it("remaps a placeholder local anchor to the durable local instance id on restore", () => {
    const serialized = serializeStarMapWorkspaceView({
      view: { x: 140, y: -100, scale: 0.8 },
      viewport: { width: 1280, height: 800 },
      anchors: [
        {
          anchor: { kind: "instance", instanceId: "local" },
          x: 625,
          y: 625,
        },
      ],
    });
    const resolved = resolveRestoredStarMapView({
      saved: serialized,
      anchors: [
        {
          anchor: { kind: "instance", instanceId: "pwr_m5" },
          x: 2400,
          y: 1900,
        },
      ],
      contentBoxes: [bodyBox(2400, 1900)],
      canvas: { width: 5000, height: 5000 },
      viewport: { width: 1280, height: 800 },
      localInstanceId: "pwr_m5",
      localPlaceholderId: "local",
    });
    expect(resolved).toBeDefined();
    expect(resolved!.scale).toBeCloseTo(0.8);
    expect(2400 * resolved!.scale + resolved!.x).toBeCloseTo(640, 4);
    expect(1900 * resolved!.scale + resolved!.y).toBeCloseTo(400, 4);
  });
});
