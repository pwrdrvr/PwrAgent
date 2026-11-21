/**
 * A Settings → Plugins route that names one connection's row, for a control
 * elsewhere in the app that sets that connection up. Kept apart from the
 * pane so the app shell can build one without loading Settings.
 */
const CONNECTION_ROUTE_PREFIX = "connection:";

export function pluginsConnectionRoute(connectionId: string): string {
  return `${CONNECTION_ROUTE_PREFIX}${connectionId}`;
}

/** The connection a Plugins sub-route names, if it names one. */
export function pluginsRouteConnectionId(sub: string | undefined): string | undefined {
  return sub?.startsWith(CONNECTION_ROUTE_PREFIX)
    ? sub.slice(CONNECTION_ROUTE_PREFIX.length) || undefined
    : undefined;
}
