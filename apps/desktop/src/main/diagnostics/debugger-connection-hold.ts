type Connection = { isAttached: () => boolean; detach: () => void };
const holds = new WeakMap<Connection, { count: number; detachRequested: boolean }>();

/** Defer a profiler's own detach while native tracing drains its stream.
 * No attachment, timer, Profiler command or polling is performed here. */
export function holdDebuggerConnection(connection: Connection): () => void {
  let state = holds.get(connection);
  if (!state) holds.set(connection, state = { count: 0, detachRequested: false });
  state.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--state.count > 0) return;
    holds.delete(connection);
    if (state.detachRequested && connection.isAttached()) connection.detach();
  };
}
export function requestDebuggerDetach(connection: Connection): void {
  const state = holds.get(connection);
  if (state) state.detachRequested = true;
  else if (connection.isAttached()) connection.detach();
}
