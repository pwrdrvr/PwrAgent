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
    // Close in: a handful of cards should not be flung to the far orbit.
    // Clearing the instance's name pill is handled per-slot rather than by
    // inflating the ring, so the ring itself stays tight.
    expect(rings[0].rx).toBeLessThan(200);
  });

  it("adds a ring instead of inflating the first one", () => {
    const single = cardRingExtent(4, 200);
    const many = cardRingExtent(16, 200);
    expect(cardRings(16, 200).length).toBeGreaterThan(1);
    // `cardRingExtent` reports the drawn cloud, cards included, so these
    // bounds carry a card half-width over the ring radius. Sixteen cards
    // on a single circle would need ~418px of ring (~518 drawn); stacking
    // rings keeps it under that, and the real win is vertical (below).
    expect(many.rx).toBeLessThan(518);
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
    // Slots sit ON their ring unless the keep-out pushed them straight
    // out; none may sit inside it.
    const inner = cardRings(16, 200)[0];
    const ringRadius = (slot: { dx: number; dy: number }) =>
      Math.hypot(slot.dx / inner.rx, slot.dy / inner.ry);
    const firstRing = slots.slice(0, inner.capacity);
    for (const slot of firstRing) {
      expect(ringRadius(slot)).toBeGreaterThanOrEqual(1 - 1e-6);
    }
    // Relief is per-slot, so a card clear of the chrome keeps its tight
    // radius. Cards well above the body have nothing to clear; cards level
    // with it must out-reach the name pill, which is unavoidable geometry
    // for a card wider than the pill.
    const highest = firstRing.reduce((top, slot) =>
      slot.dy < top.dy ? slot : top,
    );
    expect(ringRadius(highest)).toBeCloseTo(1, 2);
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
    // Instance bodies are buttons and drag/open themselves.
    const body = element(
      '<button class="star-map-instance__body"><span>x</span></button>',
    );
    expect(shouldStartCanvasPan(body)).toBe(false);
    expect(shouldStartCanvasPan(body.firstElementChild)).toBe(false);

    // A thread card is a shell holding sibling controls, so its container
    // elements match no element selector — the shell has to be named.
    const shell = element(
      '<div class="star-map-card-shell">'
      + '<div class="star-map-card">'
      + '<button class="star-map-card__open">x</button>'
      + '<span class="star-map-card__chips"><span class="thread-row__chip">y</span></span>'
      + "</div>"
      + "</div>",
    );
    expect(shouldStartCanvasPan(shell)).toBe(false);
    expect(shouldStartCanvasPan(shell.querySelector(".star-map-card"))).toBe(
      false,
    );
    expect(shouldStartCanvasPan(shell.querySelector(".star-map-card__chips"))).toBe(
      false,
    );
    expect(shouldStartCanvasPan(shell.querySelector(".thread-row__chip"))).toBe(
      false,
    );

    // Chat cards live inside the canvas, so a press on one bubbles to the
    // viewport. Without this the card dragged AND the galaxy panned.
    const chat = element(
      '<section class="star-map-chat-card">'
      + '<header class="star-map-chat-card__bar"><span>Title</span></header>'
      + '<div class="star-map-chat-card__body">transcript</div>'
      + "</section>",
    );
    expect(shouldStartCanvasPan(chat)).toBe(false);
    expect(
      shouldStartCanvasPan(chat.querySelector(".star-map-chat-card__bar")),
    ).toBe(false);
    expect(
      shouldStartCanvasPan(chat.querySelector(".star-map-chat-card__body")),
    ).toBe(false);

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
  const KEEPOUT_ABOVE = 58;
  const KEEPOUT_BELOW = 100;
  const CARD_HALF_HEIGHT = 56;

  function covers(
    slot: { dx: number; dy: number },
    cardWidth: number,
  ): boolean {
    const overlapsX = Math.abs(slot.dx) < KEEPOUT_HALF_WIDTH + cardWidth / 2;
    const overlapsY =
      slot.dy + CARD_HALF_HEIGHT > -KEEPOUT_ABOVE
      && slot.dy - CARD_HALF_HEIGHT < KEEPOUT_BELOW;
    return overlapsX && overlapsY;
  }

  it("never seats a card over its instance's chrome", () => {
    for (const cardWidth of [160, 200, 260]) {
      for (const count of [1, 2, 4, 9, 16]) {
        for (const slot of cardRingSlots(count, cardWidth)) {
          expect(covers(slot, cardWidth)).toBe(false);
        }
      }
    }
  });

  it("leaves slots clear of the chrome at their tight radius", () => {
    // Relief is per-slot rather than a ring-wide inflation, so a card with
    // nothing to clear never drifts outward to protect a box it does not
    // touch. Outer rings are already clear, so none of them move.
    const slots = cardRingSlots(16, 200);
    const rings = cardRings(16, 200);
    const outer = rings[rings.length - 1];
    const outerSlots = slots.slice(-3);
    for (const slot of outerSlots) {
      expect(
        Math.hypot(slot.dx / outer.rx, slot.dy / outer.ry),
      ).toBeCloseTo(1, 2);
    }
  });

  it("keeps the inner ring tight rather than inflating it", () => {
    expect(cardRings(4, 200)[0].rx).toBeLessThan(200);
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

describe("empty instances do not reserve a phantom ring", () => {
  it("claims only its body when it has no cards", () => {
    const empty = cardRingExtent(0, 200);
    const oneCard = cardRingExtent(1, 200);
    expect(empty.rx).toBeLessThan(oneCard.rx);
    expect(empty.ry).toBeLessThan(oneCard.ry);
  });

  it("pulls the constellation in when the hub is empty", () => {
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
    const nodes = [node("hub", 0), node("a", 1, "hub"), node("b", 1, "hub")];
    const spread = (hubCards: number) => {
      const placement = computeOrbitPlacement({
        nodes,
        cardCounts: new Map([
          ["hub", hubCards],
          ["a", 6],
          ["b", 6],
        ]),
        cardWidth: 200,
      });
      const hub = placement.instances.find((i) => i.instanceId === "hub")!;
      const a = placement.instances.find((i) => i.instanceId === "a")!;
      return Math.hypot(a.x - hub.x, a.y - hub.y);
    };
    expect(spread(0)).toBeLessThan(spread(6));
  });
});
