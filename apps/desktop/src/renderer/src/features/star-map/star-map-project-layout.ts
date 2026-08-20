import { cardRingExtent } from "./star-map-orbit";

export type ProjectPlacement = {
  key: string;
  x: number;
  y: number;
  /** Half-extent of the drawn cloud, cards included. */
  rx: number;
  ry: number;
};

export type ProjectLayout = {
  canvasHeight: number;
  canvasWidth: number;
  /** Background spiral arms, as SVG path data in canvas coordinates. */
  arms: string[];
  /** Where the arms converge; projects spiral outward from here. */
  core: { x: number; y: number };
  projects: ProjectPlacement[];
};

/** Clearance between two projects' outermost cards. */
const PROJECT_GAP = 72;
const CANVAS_PADDING = 160;

/**
 * A galaxy, not a grid.
 *
 * Projects seat along logarithmic spiral arms sweeping out of a common
 * core — the same shape the instance lens uses for its connector arms, so
 * the two lenses read as the same universe. A row-packed grid put every
 * project on a rectangular lattice, which is legible but says nothing
 * about the map being a galaxy and looks like a table of contents.
 */
const ARM_COUNT = 3;
/** Tightness of the spiral: bigger unwinds faster. */
const ARM_PITCH = 0.42;
/**
 * Radius the arm bearings are measured from. Purely the spiral's own
 * reference length — it does NOT reserve an empty hole of this size at
 * the core, which is what the constant it replaced used to do.
 */
const ARM_REFERENCE_RADIUS = 260;

/**
 * Share of the disc that unequal elliptical clouds actually fill once
 * they are seated on arms, measured over a few hundred synthetic fleets.
 *
 * This turns "how much cloud is already placed" into "how far out the
 * next one has to start looking", which is the whole point: the radius a
 * project gets is now a consequence of the space its neighbours occupy,
 * not a number assigned to it up front. Too high and every project starts
 * its search inside its neighbours and probes outward one step at a time;
 * too low and the galaxy re-acquires the empty middle this replaced.
 */
const PACKING_EFFICIENCY = 0.55;

/** How far outward to probe when every bearing at a radius collides. */
const RADIUS_STEP = 20;
/**
 * Bearings tried at each radius, alternating either side of the arm.
 *
 * A single bearing per radius makes a small project queue behind whatever
 * is on its arm, however much room there is on the next one along — the
 * single largest source of empty canvas in the old layout. Fanning out
 * lets a light cloud tuck into a gap between two heavy ones instead of
 * being pushed to the rim, and the first bearing tried is still the arm's
 * own, so the galaxy keeps its shape.
 */
const BEARING_PROBES = 7;
const MAX_PROBES = 400;

/** Angle of a point on arm `index` at radius `r`. */
function armAngle(index: number, radius: number): number {
  return (
    (index * 2 * Math.PI) / ARM_COUNT
    + Math.log(Math.max(radius, 1) / ARM_REFERENCE_RADIUS) / ARM_PITCH
  );
}

/**
 * Bearing offset for probe `index`: 0, then alternating either side of
 * the arm in equal steps, out to half the angular pitch between arms.
 */
function bearingOffset(index: number): number {
  if (index <= 0) return 0;
  const side = index % 2 === 1 ? 1 : -1;
  const step = Math.ceil(index / 2);
  return (side * step * (2 * Math.PI)) / (ARM_COUNT * BEARING_PROBES);
}

/**
 * Rectangular separation, deliberately.
 *
 * `cardRingExtent` reports the half-extents of the box that CONTAINS every
 * card in the cloud, so two non-overlapping boxes provably cannot have two
 * overlapping cards. Testing the clouds as ellipses instead packs a few
 * percent tighter and lets real cards from different projects overlap by
 * up to ~60px, because the Minkowski sum of two ellipses of different
 * aspect is not the ellipse of their summed radii.
 */
function overlaps(
  a: { x: number; y: number; rx: number; ry: number },
  b: { x: number; y: number; rx: number; ry: number },
): boolean {
  return (
    Math.abs(a.x - b.x) < a.rx + b.rx + PROJECT_GAP
    && Math.abs(a.y - b.y) < a.ry + b.ry + PROJECT_GAP
  );
}

/**
 * Seat projects along the arms, busiest nearest the core.
 *
 * Each project starts its search at the radius the already-seated clouds
 * force it to — the radius of a disc big enough to hold them — and then
 * probes bearings, and only then steps outward. Distance is therefore a
 * consequence of how much cloud is in the way, which is what "as far apart
 * as they need to be" means.
 *
 * The layout this replaced mapped mass onto an ABSOLUTE radius across a
 * fixed 900px span, so a project's distance from the core was decided
 * before anything was placed: on a real nine-project fleet, five of the
 * nine seated without a single collision probe — nothing had crowded them,
 * they were simply thrown that far. It read worst on small fleets, where
 * three one-thread projects have almost no spread in mass and every one of
 * them but the heaviest landed at the rim, 1160px out, around an empty
 * middle.
 *
 * Placement is deterministic: same input, same galaxy, so the map does not
 * reshuffle between renders.
 */
export function computeProjectLayout(params: {
  cardWidth: number;
  projects: readonly {
    key: string;
    /** Visible card count, for the ring-shaped fallback extent. */
    cardCount: number;
    /**
     * Half-extent of what this project actually draws. Supplied by the
     * caller from its seated clouds — the same arrangement
     * `computeOrbitPlacement` uses — so project spacing tracks the real
     * drawing rather than a ring formula that the clouds no longer follow.
     */
    extent?: { rx: number; ry: number };
    mass?: number;
  }[];
}): ProjectLayout {
  if (params.projects.length === 0) {
    return {
      arms: [],
      canvasHeight: 0,
      canvasWidth: 0,
      core: { x: 0, y: 0 },
      projects: [],
    };
  }

  // Seat order IS radial order now, so the ordering is enforced here
  // rather than trusted from the caller: with mass no longer naming a
  // radius, a caller that passed its projects in some other order would
  // silently seat a dormant one-thread project at the galactic core.
  const ordered = [...params.projects].sort(
    (left, right) =>
      (right.mass ?? right.cardCount) - (left.mass ?? left.cardCount)
      || left.key.localeCompare(right.key),
  );

  const seated: (ProjectPlacement & { radius: number })[] = [];
  /** Cloud area already claimed, each cloud's share of the gap included. */
  let claimed = 0;
  ordered.forEach((project, index) => {
    const extent =
      project.extent ?? cardRingExtent(project.cardCount, params.cardWidth);
    const arm = index % ARM_COUNT;
    let radius = Math.sqrt(claimed / (Math.PI * PACKING_EFFICIENCY));
    let placed = false;

    for (let probe = 0; probe < MAX_PROBES && !placed; probe += 1) {
      for (let bearing = 0; bearing < BEARING_PROBES; bearing += 1) {
        // Below the reference radius the spiral winds arbitrarily fast, so
        // bearings are read from a floor rather than from the true radius.
        const angle =
          armAngle(arm, Math.max(radius, ARM_REFERENCE_RADIUS / 4))
          + bearingOffset(bearing);
        const candidate = {
          key: project.key,
          rx: extent.rx,
          ry: extent.ry,
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        };
        if (!seated.some((other) => overlaps(candidate, other))) {
          seated.push({ ...candidate, radius });
          placed = true;
          break;
        }
      }
      if (!placed) radius += RADIUS_STEP;
    }
    if (!placed) {
      // Exhausted the probe budget: seat it at the outermost radius tried
      // rather than dropping the project off the map entirely.
      const angle = armAngle(arm, radius);
      seated.push({
        key: project.key,
        radius,
        rx: extent.rx,
        ry: extent.ry,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    }
    claimed +=
      Math.PI
      * (extent.rx + PROJECT_GAP / 2)
      * (extent.ry + PROJECT_GAP / 2);
  });

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const project of seated) {
    minX = Math.min(minX, project.x - project.rx);
    minY = Math.min(minY, project.y - project.ry);
    maxX = Math.max(maxX, project.x + project.rx);
    maxY = Math.max(maxY, project.y + project.ry);
  }
  const offsetX = CANVAS_PADDING - minX;
  const offsetY = CANVAS_PADDING - minY;
  const outermost = seated.reduce(
    (furthest, project) => Math.max(furthest, project.radius),
    ARM_REFERENCE_RADIUS,
  );

  return {
    arms: buildArms({ offsetX, offsetY, outermost }),
    canvasHeight: maxY - minY + CANVAS_PADDING * 2,
    canvasWidth: maxX - minX + CANVAS_PADDING * 2,
    core: { x: offsetX, y: offsetY },
    projects: seated.map((project) => ({
      key: project.key,
      rx: project.rx,
      ry: project.ry,
      x: project.x + offsetX,
      y: project.y + offsetY,
    })),
  };
}

/**
 * The faint arms drawn behind the projects. Sampled from the same spiral
 * the seats use, so a project always sits on the arm it appears to.
 */
function buildArms(params: {
  offsetX: number;
  offsetY: number;
  outermost: number;
}): string[] {
  const arms: string[] = [];
  const start = ARM_REFERENCE_RADIUS * 0.35;
  const end = params.outermost * 1.18;
  for (let index = 0; index < ARM_COUNT; index += 1) {
    const points: string[] = [];
    for (let step = 0; step <= 48; step += 1) {
      const radius = start + (end - start) * (step / 48);
      const angle = armAngle(index, radius);
      const x = Math.cos(angle) * radius + params.offsetX;
      const y = Math.sin(angle) * radius + params.offsetY;
      points.push(`${step === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    arms.push(points.join(" "));
  }
  return arms;
}
