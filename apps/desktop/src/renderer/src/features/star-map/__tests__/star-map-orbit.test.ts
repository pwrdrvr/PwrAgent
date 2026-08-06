import { describe, expect, it } from "vitest";
import type { FederationPeerSummary } from "@pwragent/shared";
import {
  cardRingExtent,
  cardRings,
  cardRingSlots,
  computeOrbitPlacement,
  galaxyArmPath,
  shouldStartCanvasPan,
} from "../star-map-orbit";
import {
  buildFederationTopology,
  topologyEdges,
  type StarMapTopologyNode,
} from "../star-map-topology";

function peer(
  id: string,
  role: FederationPeerSummary["role"] = "client",
): FederationPeerSummary {
  return {
    id,
    label: id,
    role,
    status: "connected",
    capabilities: [],
  } as FederationPeerSummary;
}

describe("buildFederationTopology", () => {
  it("roots at the local instance when it is the gateway", () => {
    const nodes = buildFederationTopology({
      localInstanceId: "pwr_local",
      localRole: "gateway",
      peers: [peer("pwr_a"), peer("pwr_b")],
    });
    const root = nodes.find((node) => node.depth === 0);
    expect(root?.instanceId).toBe("pwr_local");
    expect(topologyEdges(nodes)).toEqual([
      { fromInstanceId: "pwr_local", toInstanceId: "pwr_a" },
      { fromInstanceId: "pwr_local", toInstanceId: "pwr_b" },
    ]);
  });

  it("roots at the enrolled gateway when this instance is a client", () => {
    const nodes = buildFederationTopology({
      localInstanceId: "pwr_local",
      localRole: "client",
      peers: [peer("pwr_gw", "gateway"), peer("pwr_sibling")],
      gatewayInstanceId: "pwr_gw",
    });
    expect(nodes.find((node) => node.depth === 0)?.instanceId).toBe("pwr_gw");
    // The local body becomes one of the gateway's children, beside its peers.
    const local = nodes.find((node) => node.isLocal);
    expect(local?.parentId).toBe("pwr_gw");
    expect(nodes.filter((node) => node.parentId === "pwr_gw")).toHaveLength(2);
  });
});

describe("card rings", () => {
  it("seats a small cloud on one tight ring near the body", () => {
    const rings = cardRings(4, 200);
    expect(rings).toHaveLength(1);
    // Close in: a handful of cards should not be flung to the far orbit,
    // but the first ring must still clear the instance's own name pill and
    // [+] button — a card may never cover the controls for its instance.
    expect(rings[0].rx).toBeLessThan(260);
    expect(rings[0].rx).toBeGreaterThanOrEqual(200);
  });

  it("adds a ring instead of inflating the first one", () => {
    const single = cardRingExtent(4, 200);
    const many = cardRingExtent(16, 200);
    expect(cardRings(16, 200).length).toBeGreaterThan(1);
    // Sixteen cards on one circle would need a radius over 500; rings keep
    // the outermost far tighter than that.
    expect(many.rx).toBeLessThan(500);
    expect(many.rx).toBeGreaterThan(single.rx);
  });

  it("is squashed to the card's aspect so rings hug the body vertically", () => {
    const extent = cardRingExtent(8, 200);
    expect(extent.ry).toBeLessThan(extent.rx);
  });

  it("gives every card a distinct slot and fills inner rings first", () => {
    const slots = cardRingSlots(16, 200);
    expect(slots).toHaveLength(16);
    const unique = new Set(
      slots.map((slot) => `${Math.round(slot.dx)}:${Math.round(slot.dy)}`),
    );
    expect(unique.size).toBe(16);
    const inner = cardRings(16, 200)[0];
    const firstRingRadius = Math.hypot(
      slots[0].dx / inner.rx,
      slots[0].dy / inner.ry,
    );
    expect(firstRingRadius).toBeCloseTo(1, 5);
  });
});

describe("computeOrbitPlacement", () => {
  const nodes = buildFederationTopology({
    localInstanceId: "pwr_local",
    localRole: "gateway",
    peers: [peer("pwr_a"), peer("pwr_b"), peer("pwr_c")],
  });

  it("keeps every body inside a positive canvas", () => {
    const placement = computeOrbitPlacement({
      nodes,
      cardCounts: new Map([
        ["pwr_local", 6],
        ["pwr_a", 3],
        ["pwr_b", 0],
        ["pwr_c", 8],
      ]),
      cardWidth: 220,
    });
    expect(placement.instances).toHaveLength(4);
    for (const instance of placement.instances) {
      expect(instance.x).toBeGreaterThan(0);
      expect(instance.y).toBeGreaterThan(0);
      expect(instance.x).toBeLessThan(placement.canvasWidth);
      expect(instance.y).toBeLessThan(placement.canvasHeight);
    }
  });

  it("spaces bodies so neighbouring card rings cannot touch", () => {
    const counts = new Map([
      ["pwr_local", 6],
      ["pwr_a", 6],
      ["pwr_b", 6],
      ["pwr_c", 6],
    ]);
    const placement = computeOrbitPlacement({
      nodes,
      cardCounts: counts,
      cardWidth: 220,
    });
    const ring = cardRingExtent(6, 220).rx;
    const spokes = placement.instances.filter((instance) => !instance.isHub);
    for (let i = 0; i < spokes.length; i += 1) {
      for (let j = i + 1; j < spokes.length; j += 1) {
        const distance = Math.hypot(
          spokes[i].x - spokes[j].x,
          spokes[i].y - spokes[j].y,
        );
        expect(distance).toBeGreaterThan(ring);
      }
    }
  });

  it("gives each instance one card slot per visible card", () => {
    const placement = computeOrbitPlacement({
      nodes,
      cardCounts: new Map([["pwr_local", 4]]),
      cardWidth: 220,
    });
    const hub = placement.instances.find((instance) => instance.isHub);
    expect(hub?.cardSlots).toHaveLength(4);
    // Slots sit on a ring, so no two share a position.
    const unique = new Set(
      hub?.cardSlots.map((slot) => `${Math.round(slot.dx)}:${Math.round(slot.dy)}`),
    );
    expect(unique.size).toBe(4);
  });
});

describe("shouldStartCanvasPan", () => {
  function element(html: string): Element {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild!;
  }

  it("pans from bare sky", () => {
    expect(shouldStartCanvasPan(element('<div class="star-map__sky" />'))).toBe(
      true,
    );
  });

  it("never steals a gesture from a card, body, or chrome", () => {
    // Cards and instance bodies are buttons and drag/open themselves.
    const card = element('<button class="star-map-card"><span>x</span></button>');
    expect(shouldStartCanvasPan(card)).toBe(false);
    expect(shouldStartCanvasPan(card.firstElementChild)).toBe(false);

    const chrome = element(
      '<div class="star-map__chrome"><p>PwrAgent</p></div>',
    );
    expect(shouldStartCanvasPan(chrome.firstElementChild)).toBe(false);

    const filters = element(
      '<div class="star-map__filters"><span>Unread</span></div>',
    );
    expect(shouldStartCanvasPan(filters.firstElementChild)).toBe(false);
  });

  it("ignores a non-element target", () => {
    expect(shouldStartCanvasPan(null)).toBe(false);
  });
});

describe("instance keep-out", () => {
  // A card may cover the link lines without a care, but never the body,
  // name pill, or [+] button of the instance it belongs to.
  const KEEPOUT_HALF_WIDTH = 92;
  const KEEPOUT_BELOW = 100;
  const CARD_HALF_HEIGHT = 56;

  it("clears the name pill and intake button horizontally", () => {
    for (const cardWidth of [160, 200, 240]) {
      const [inner] = cardRings(3, cardWidth);
      // A card centred on the ring's flank reaches inward by half its width.
      expect(inner.rx - cardWidth / 2).toBeGreaterThan(KEEPOUT_HALF_WIDTH);
    }
  });

  it("clears the stacked label rows below the body", () => {
    const [inner] = cardRings(3, 200);
    expect(inner.ry - CARD_HALF_HEIGHT).toBeGreaterThan(KEEPOUT_BELOW);
  });

  it("widens the first ring as cards get wider", () => {
    expect(cardRings(3, 260)[0].rx).toBeGreaterThan(cardRings(3, 200)[0].rx);
  });
});

describe("galaxyArmPath", () => {
  const hub = { x: 0, y: 0 };

  function points(d: string): Array<{ x: number; y: number }> {
    return d
      .trim()
      .split(/\s*[ML]\s*/)
      .filter(Boolean)
      .map((pair) => {
        const [x, y] = pair.trim().split(/\s+/).map(Number);
        return { x, y };
      });
  }

  it("starts at the body and lands on the hub", () => {
    const from = { x: 300, y: 300 };
    const list = points(galaxyArmPath(from, hub));
    expect(list[0].x).toBeCloseTo(from.x, 0);
    expect(list[0].y).toBeCloseTo(from.y, 0);
    const last = list[list.length - 1];
    expect(Math.hypot(last.x - hub.x, last.y - hub.y)).toBeLessThan(1);
  });

  it("leaves a lower-right body toward the N/NW, rising more than it tracks left", () => {
    // The operator'sdescription: out of the N/NW corner, "almost up a bit".
    const list = points(galaxyArmPath({ x: 300, y: 300 }, hub));
    const dx = list[1].x - list[0].x;
    const dy = list[1].y - list[0].y;
    expect(dx).toBeLessThan(0); // heading left
    expect(dy).toBeLessThan(0); // heading up
    expect(Math.abs(dy)).toBeGreaterThan(Math.abs(dx)); // more up than left
  });

  it("curves harder as it approaches the hub", () => {
    const list = points(galaxyArmPath({ x: 400, y: 0 }, hub));
    const heading = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.atan2(b.y - a.y, b.x - a.x);
    const turn = (index: number) =>
      Math.abs(
        heading(list[index + 1], list[index + 2])
          - heading(list[index], list[index + 1]),
      );
    expect(turn(list.length - 4)).toBeGreaterThan(turn(0));
  });

  it("is not symmetric: swapping body and hub reverses the sweep", () => {
    // Guards the call-site direction. Orbit links are emitted parent ->
    // child, so the renderer must pass the CHILD as the body; passing them
    // in link order spirals into the client instead of the gateway.
    const body = { x: 300, y: 300 };
    const outward = galaxyArmPath(body, hub);
    const inward = galaxyArmPath(hub, body);
    expect(outward).not.toBe(inward);
    const first = points(outward)[0];
    expect(first.x).toBeCloseTo(body.x, 0);
    expect(first.y).toBeCloseTo(body.y, 0);
  });

  it("degenerates to a straight segment when the body sits on the hub", () => {
    expect(galaxyArmPath({ x: 0, y: 0 }, hub)).toBe("M 0 0 L 0 0");
  });
});

describe("computeOrbitPlacement galaxy scatter", () => {
  const node = (
    instanceId: string,
    depth: number,
    parentId?: string,
  ): StarMapTopologyNode => ({
    instanceId,
    depth,
    parentId,
    isLocal: depth === 0,
    role: depth === 0 ? "gateway" : "client",
  });
  const nodes: StarMapTopologyNode[] = [
    node("hub", 0),
    node("a", 1, "hub"),
    node("b", 1, "hub"),
    node("c", 1, "hub"),
    node("d", 1, "hub"),
  ];
  const placement = () =>
    computeOrbitPlacement({
      nodes,
      cardCounts: new Map(),
      cardWidth: 200,
    });

  it("never lands four peers on exact compass points", () => {
    const hub = placement().instances.find((i) => i.instanceId === "hub")!;
    for (const instance of placement().instances) {
      if (instance.instanceId === "hub") continue;
      const angle = Math.atan2(instance.y - hub.y, instance.x - hub.x);
      for (const cardinal of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        expect(Math.abs(angle - cardinal)).toBeGreaterThan(0.02);
      }
    }
  });

  it("does not space peers at exactly 90 degrees", () => {
    const result = placement();
    const hub = result.instances.find((i) => i.instanceId === "hub")!;
    const angles = result.instances
      .filter((i) => i.instanceId !== "hub")
      .map((i) => Math.atan2(i.y - hub.y, i.x - hub.x))
      .sort((left, right) => left - right);
    const gaps = angles
      .slice(1)
      .map((angle, index) => angle - angles[index]);
    expect(gaps.some((gap) => Math.abs(gap - Math.PI / 2) > 0.02)).toBe(true);
  });

  it("is deterministic across renders", () => {
    expect(placement().instances).toEqual(placement().instances);
  });
});
