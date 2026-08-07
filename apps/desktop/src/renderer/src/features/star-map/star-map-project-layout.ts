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
/** Where the heaviest project sits, measured from the core. */
const CORE_RADIUS = 260;
/**
 * How far past the core the lightest project is thrown.
 *
 * Mass sets a target radius on this span; collisions only ever push a
 * project further out from there. Ordering alone was not enough — it made
 * the 4th-heaviest project land as far out as the 12th whenever the arms
 * fell that way, which is a queue, not gravity.
 */
const RIM_SPREAD = 900;
/** How far outward to probe when a candidate seat collides. */
const RADIUS_STEP = 36;
const MAX_PROBES = 400;

/** Angle of a point on arm `index` at radius `r`. */
function armAngle(index: number, radius: number): number {
  return (
    (index * 2 * Math.PI) / ARM_COUNT
    + Math.log(Math.max(radius, 1) / CORE_RADIUS) / ARM_PITCH
  );
}

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
 * Each project walks outward along its arm until it clears everything
 * already placed, so a dense project pushes its neighbours further out
 * rather than overlapping them. Placement is deterministic: same input,
 * same galaxy, so the map does not reshuffle between renders.
 */
export function computeProjectLayout(params: {
  cardWidth: number;
  /** Visible card count per project key, in the order to place them. */
  projects: readonly { key: string; cardCount: number; mass?: number }[];
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

  // Mass sets where a project WANTS to sit. Normalised against the
  // heaviest so the galaxy looks the same whether the fleet has three
  // threads or three hundred.
  const masses = params.projects.map(
    (project) => project.mass ?? project.cardCount,
  );
  const heaviest = Math.max(...masses, 1);
  const lightest = Math.min(...masses, heaviest);
  const span = heaviest - lightest;
  /**
   * With no spread in mass there is nothing to rank, so everything is
   * equally heavy and belongs at the core — the common shape for a small
   * or new fleet, where every project has one thread of similar age.
   * Deriving `pull` from a zero span instead gave every project the
   * *lightest* treatment and flung the whole galaxy to the rim around an
   * empty centre.
   */
  const ranked = span > 1e-6;

  const seated: (ProjectPlacement & { radius: number })[] = [];
  params.projects.forEach((project, index) => {
    const extent = cardRingExtent(project.cardCount, params.cardWidth);
    const arm = index % ARM_COUNT;
    const pull = ranked ? (masses[index] - lightest) / span : 1;
    // Square-root so the middle of the pack spreads out rather than
    // bunching against the rim; heavy projects still dominate the core.
    let radius = CORE_RADIUS + RIM_SPREAD * Math.sqrt(1 - pull);

    for (let probe = 0; probe < MAX_PROBES; probe += 1) {
      const angle = armAngle(arm, radius);
      const candidate = {
        key: project.key,
        rx: extent.rx,
        ry: extent.ry,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      };
      if (!seated.some((other) => overlaps(candidate, other))) {
        seated.push({ ...candidate, radius });
        return;
      }
      radius += RADIUS_STEP;
    }
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
    CORE_RADIUS,
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
  const end = params.outermost * 1.18;
  for (let index = 0; index < ARM_COUNT; index += 1) {
    const points: string[] = [];
    for (let step = 0; step <= 48; step += 1) {
      const radius = CORE_RADIUS * 0.35 + (end - CORE_RADIUS * 0.35) * (step / 48);
      const angle = armAngle(index, radius);
      const x = Math.cos(angle) * radius + params.offsetX;
      const y = Math.sin(angle) * radius + params.offsetY;
      points.push(`${step === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    arms.push(points.join(" "));
  }
  return arms;
}
