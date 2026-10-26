/**
 * Settings → Environments routes. Kept apart from the pane so App can link to
 * it without loading the lazily imported Settings screen.
 */

/** Where the pane is: a project's list, one file, or a new file. */
export type EnvironmentsRoute = {
  project?: string;
  file?: string;
  /** The environment's name, for the breadcrumb before the file loads. */
  name?: string;
  create?: boolean;
};

/** The Settings route `sub` for an Environments page. */
export function encodeEnvironmentsRoute(route: EnvironmentsRoute): string | undefined {
  if (!route.project) return undefined;
  return JSON.stringify({
    p: route.project,
    ...(route.file ? { f: route.file } : {}),
    ...(route.name ? { n: route.name } : {}),
    ...(route.create ? { c: 1 } : {}),
  });
}

export function decodeEnvironmentsRoute(sub: string | undefined): EnvironmentsRoute {
  if (!sub) return {};
  try {
    const value = JSON.parse(sub) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || typeof value.p !== "string") {
      return {};
    }
    return {
      project: value.p,
      ...(typeof value.f === "string" ? { file: value.f } : {}),
      ...(typeof value.n === "string" ? { name: value.n } : {}),
      ...(value.c ? { create: true } : {}),
    };
  } catch {
    return {};
  }
}

/** Breadcrumb for an editor page; a project's list has none. */
export function environmentsRouteLabel(sub: string | undefined): string | undefined {
  const route = decodeEnvironmentsRoute(sub);
  if (route.create) return "New environment";
  if (route.file) return route.name || route.file;
  return undefined;
}

/** Each editor is its own page; every project's list is one page. */
export function environmentsPageKey(sub: string | undefined): string {
  const route = decodeEnvironmentsRoute(sub);
  if (route.create) return `environments:new:${route.project ?? ""}`;
  if (route.file) return `environments:edit:${route.project ?? ""}:${route.file}`;
  return "environments";
}
