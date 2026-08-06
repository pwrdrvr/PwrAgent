import { describe, expect, it } from "vitest";
import type { FederationPeerSummary } from "@pwragent/shared";
import {
  cardRingExtent,
  cardRings,
  cardRingSlots,
  computeOrbitPlacement,
  shouldStartCanvasPan,
} from "../star-map-orbit";
import { buildFederationTopology, topologyEdges } from "../star-map-topology";

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
    // Close in: a handful of cards should not be flung to the far orbit.
    expect(rings[0].rx).toBeLessThan(200);
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
