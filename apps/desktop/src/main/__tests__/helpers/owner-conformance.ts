import type { AgentEvent } from "@pwragent/shared";

/**
 * One step of an owner conformance scenario, as one host answered it. The
 * suite records the same steps on desktop and on the Outpost and compares the
 * two records. Only shapes are compared by default, because ids, clocks and
 * ordering keys differ between any two owners; `values` holds the few facts
 * both owners must agree on exactly, such as a thread's title.
 */
export type OwnerStepRecord = {
  step: string;
  method: string;
  response: unknown;
  values: Record<string, unknown>;
  events: AgentEvent[];
};

export type OwnerHostName = "desktop" | "outpost";

/** A JSON-like description of a value's structure, with no data in it. */
export type Shape = string | Shape[] | { [key: string]: Shape };

function primitiveShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function mergeShapes(a: Shape, b: Shape): Shape {
  if (typeof a === "string" && typeof b === "string") {
    return a === b ? a : [...new Set([...a.split("|"), ...b.split("|")])].sort().join("|");
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (!a.length) return b;
    if (!b.length) return a;
    return [mergeShapes(a[0]!, b[0]!)];
  }
  if (typeof a === "object" && !Array.isArray(a) && typeof b === "object" && !Array.isArray(b)) {
    const merged: { [key: string]: Shape } = { ...a };
    for (const [key, shape] of Object.entries(b)) merged[key] = key in merged ? mergeShapes(merged[key]!, shape) : shape;
    return merged;
  }
  return "mixed";
}

/** Arrays merge their elements into one element shape; undefined keys are absent. */
export function shapeOf(value: unknown): Shape {
  if (Array.isArray(value)) {
    return value.length ? [value.map(shapeOf).reduce(mergeShapes)] : [];
  }
  if (value !== null && typeof value === "object") {
    const shape: { [key: string]: Shape } = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) shape[key] = shapeOf(entry);
    }
    return shape;
  }
  return primitiveShape(value);
}

function describeShape(shape: Shape): string {
  if (typeof shape === "string") return shape;
  return Array.isArray(shape) ? "array" : "object";
}

/** Each difference between two shapes, as `<path>: desktop <x>, outpost <y>`. */
export function diffShapes(desktop: Shape, outpost: Shape, path = "$"): string[] {
  if (Array.isArray(desktop) && Array.isArray(outpost)) {
    // An empty array says nothing about its elements.
    if (!desktop.length || !outpost.length) return [];
    return diffShapes(desktop[0]!, outpost[0]!, `${path}[]`);
  }
  const isObject = (shape: Shape) => typeof shape === "object" && !Array.isArray(shape);
  if (isObject(desktop) && isObject(outpost)) {
    const left = desktop as { [key: string]: Shape };
    const right = outpost as { [key: string]: Shape };
    const differences: string[] = [];
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const child = `${path}.${key}`;
      if (!(key in right)) differences.push(`${child}: desktop ${describeShape(left[key]!)}, outpost missing`);
      else if (!(key in left)) differences.push(`${child}: desktop missing, outpost ${describeShape(right[key]!)}`);
      else differences.push(...diffShapes(left[key]!, right[key]!, child));
    }
    return differences;
  }
  const a = describeShape(desktop);
  const b = describeShape(outpost);
  return a === b ? [] : [`${path}: desktop ${a}, outpost ${b}`];
}

const formatValue = (value: unknown) => value === undefined ? "missing" : JSON.stringify(value);

function eventShapes(events: AgentEvent[]): Map<string, Shape> {
  const shapes = new Map<string, Shape>();
  for (const event of events) {
    const method = event.notification.method;
    const shape = shapeOf(event.notification.params);
    shapes.set(method, shapes.has(method) ? mergeShapes(shapes.get(method)!, shape) : shape);
  }
  return shapes;
}

/**
 * Every difference between the two hosts' answers to one step. Each line
 * starts with the step and the owner method, so a failure names the method.
 */
export function compareStep(desktop: OwnerStepRecord, outpost: OwnerStepRecord): string[] {
  if (desktop.step !== outpost.step || desktop.method !== outpost.method) {
    throw new Error(`Step mismatch: desktop ran ${desktop.step} (${desktop.method}), outpost ran ${outpost.step} (${outpost.method})`);
  }
  const prefix = `${desktop.method} [${desktop.step}]`;
  const differences: string[] = [];
  for (const line of diffShapes(shapeOf(desktop.response), shapeOf(outpost.response))) {
    differences.push(`${prefix} response ${line}`);
  }
  for (const key of [...new Set([...Object.keys(desktop.values), ...Object.keys(outpost.values)])].sort()) {
    const a = formatValue(desktop.values[key]);
    const b = formatValue(outpost.values[key]);
    if (a !== b) differences.push(`${prefix} value ${key}: desktop ${a}, outpost ${b}`);
  }
  const left = eventShapes(desktop.events);
  const right = eventShapes(outpost.events);
  for (const method of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    if (!right.has(method)) differences.push(`${prefix} event ${method}: desktop sends it, outpost does not`);
    else if (!left.has(method)) differences.push(`${prefix} event ${method}: outpost sends it, desktop does not`);
    else {
      for (const line of diffShapes(left.get(method)!, right.get(method)!)) {
        differences.push(`${prefix} event ${method} params ${line}`);
      }
    }
  }
  return differences;
}

export type OwnerConformanceBaseline = {
  /** Owner methods both hosts implement. A change here is a contract change. */
  sharedMethods: string[];
  /** Known differences, each one a line to fix. The list should only shrink. */
  differences: string[];
};

/** What changed against the checked-in baseline, as a readable failure. */
export function describeBaselineChange(baseline: OwnerConformanceBaseline, measured: OwnerConformanceBaseline): string | undefined {
  const lines: string[] = [];
  const diffList = (label: string, before: string[], after: string[]) => {
    const added = after.filter((line) => !before.includes(line));
    const removed = before.filter((line) => !after.includes(line));
    for (const line of added) lines.push(`  new ${label}: ${line}`);
    for (const line of removed) lines.push(`  no longer ${label}: ${line}`);
  };
  diffList("shared method", baseline.sharedMethods, measured.sharedMethods);
  diffList("difference", baseline.differences, measured.differences);
  if (!lines.length) return undefined;
  return [
    "Desktop and the Outpost no longer answer owner requests the way the baseline records.",
    ...lines,
    "A new difference is a drift to fix. A difference that is gone was fixed: record it with",
    "UPDATE_OWNER_CONFORMANCE=1 pnpm test apps/desktop/src/main/__tests__/owner-conformance.test.ts",
  ].join("\n");
}
