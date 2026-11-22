import { useEffect, useState } from "react";
import {
  type BoatThreadSandbox,
  type BoatThreadSandboxAction,
} from "@pwragent/shared/contracts/mcp-connections";
import type { DesktopApi } from "../../lib/desktop-api";

/** States in which Boat is no longer billing for a running machine. */
const AT_REST = new Set(["archiving", "archived", "cancelled", "error", "stopped"]);

/** Whether Boat's auto-stop deadline still applies: not stopped, nor on its way. */
function counting(sandbox: BoatThreadSandbox): boolean {
  return sandbox.stopsAt !== undefined
    && sandbox.state !== "stopping"
    && !(sandbox.state !== undefined && AT_REST.has(sandbox.state));
}

/**
 * The last list read per thread. Reopening the panel shows it at once and
 * reads again underneath, so the section does not arrive after the rest.
 */
const lastRead = new Map<string, BoatThreadSandbox[]>();
const LAST_READ_LIMIT = 50;

function remember(key: string, sandboxes: BoatThreadSandbox[]): void {
  // Re-inserted so the oldest key is the least recently read.
  lastRead.delete(key);
  lastRead.set(key, sandboxes);
  for (const stale of lastRead.keys()) {
    if (lastRead.size <= LAST_READ_LIMIT) break;
    lastRead.delete(stale);
  }
}

/**
 * Time left before Boat stops a sandbox by itself, from the deadline Boat
 * reported. A deadline already passed says nothing: Boat moves it while an
 * agent prompt runs, so no figure is shown rather than a wrong one.
 */
export function formatBoatSandboxStopsIn(stopsAt: number | undefined, now: number): string | undefined {
  if (stopsAt === undefined) return undefined;
  const left = stopsAt - now;
  if (!Number.isFinite(left) || left <= 0) return undefined;
  const minutes = Math.floor(left / 60_000);
  if (minutes < 1) return "stops in under a minute";
  if (minutes < 60) return `stops in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest ? `stops in ${hours} h ${rest} min` : `stops in ${hours} h`;
  }
  return `stops in ${Math.floor(hours / 24)} days`;
}

/** How often the time left is redrawn while one is shown. */
const STOPS_IN_TICK_MS = 30_000;

export function formatBoatSandboxCost(dollars: number | undefined): string | undefined {
  if (dollars === undefined) return undefined;
  if (dollars > 0 && dollars < 0.01) return "under $0.01";
  return `$${dollars.toFixed(2)}`;
}

/**
 * The Boat sandboxes this thread created, with what each has cost and the
 * two things an operator does about a bill: stop it, or delete it.
 *
 * Shown only for a thread on this machine, whose key and bill these are.
 * A thread with none shows nothing.
 */
export function ThreadBoatSandboxes(props: {
  backend: string;
  desktopApi?: DesktopApi;
  threadId: string;
  /** Bumped by the caller when the thread's selection changes. */
  token: number;
}) {
  const { backend, desktopApi, threadId, token } = props;
  const list = desktopApi?.listThreadBoatSandboxes;
  const change = desktopApi?.changeThreadBoatSandbox;
  const key = JSON.stringify([backend, threadId]);
  const [read, setRead] = useState<{ key: string; sandboxes: BoatThreadSandbox[] }>();
  /** The sandbox id, or `<id>:<port>` for a tunnel, being changed. */
  const [busyId, setBusyId] = useState<string>();
  const [confirmingId, setConfirmingId] = useState<string>();
  const [error, setError] = useState<string>();
  // Another thread's sandboxes are never shown under this one.
  const sandboxes = read?.key === key ? read.sandboxes : lastRead.get(key);
  // Read on every render, so a fresh list is never measured against an old
  // clock; the tick only asks for a render while a deadline is shown.
  const [, setTick] = useState(0);
  const now = Date.now();
  const anyCounting = sandboxes?.some(counting) ?? false;

  useEffect(() => {
    if (!anyCounting) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), STOPS_IN_TICK_MS);
    return () => clearInterval(timer);
  }, [anyCounting]);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    setConfirmingId(undefined);
    if (!list) return;
    void (async () => {
      try {
        const response = await list({ backend, threadId });
        if (cancelled) return;
        remember(key, response.sandboxes);
        setRead({ key, sandboxes: response.sandboxes });
      } catch {
        // A failed read says nothing about now; the earlier list is dropped
        // rather than shown as current.
        if (cancelled) return;
        lastRead.delete(key);
        setRead({ key, sandboxes: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backend, key, list, threadId, token]);

  if (!list || !sandboxes?.length) return null;

  const act = (sandboxId: string, action: BoatThreadSandboxAction, port?: number): void => {
    if (!change || busyId) return;
    setBusyId(port === undefined ? sandboxId : `${sandboxId}:${port}`);
    setError(undefined);
    setConfirmingId(undefined);
    void change({ backend, threadId, sandboxId, action, ...(port === undefined ? {} : { port }) })
      .then((response) => {
        remember(key, response.sandboxes);
        setRead({ key, sandboxes: response.sandboxes });
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusyId(undefined));
  };

  return (
    <section className="mcp-access-panel__verify" aria-label="Boat sandboxes">
      <h3 className="mcp-access-panel__verify-head">Boat sandboxes</h3>
      <ul className="mcp-access-panel__sandboxes">
        {sandboxes.map((sandbox) => {
          const name = sandbox.name ?? sandbox.id;
          const cost = formatBoatSandboxCost(sandbox.dollars);
          const atRest = sandbox.state !== undefined && AT_REST.has(sandbox.state);
          const stopsIn = counting(sandbox) ? formatBoatSandboxStopsIn(sandbox.stopsAt, now) : undefined;
          const busy = busyId !== undefined;
          return (
            <li key={sandbox.id}>
              <div className="mcp-access-panel__sandbox">
                <div className="mcp-access-panel__row-body">
                  <span className="mcp-access-panel__verify-name">{name}</span>
                  <span className="mcp-access-panel__detail">
                    {[sandbox.state ?? "unknown", sandbox.type, cost ? `${cost} so far` : undefined, stopsIn]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                {change ? (
                  <div className="mcp-access-panel__row-actions">
                    {confirmingId === sandbox.id ? (
                      // Keep takes Delete's place and the focus, so a second
                      // click or a second Enter in the same spot deletes nothing.
                      <>
                        <button
                          key="confirm"
                          aria-label={`Delete ${name} and its disk`}
                          className="button button--secondary"
                          type="button"
                          disabled={busy}
                          onClick={() => act(sandbox.id, "delete")}
                        >
                          Delete it
                        </button>
                        <button
                          key="keep"
                          autoFocus
                          className="button button--ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmingId(undefined)}
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <>
                        {atRest ? null : (
                          <button
                            key="stop"
                            aria-label={`Stop ${name}`}
                            className="button button--ghost"
                            type="button"
                            disabled={busy}
                            onClick={() => act(sandbox.id, "stop")}
                          >
                            {busyId === sandbox.id ? "Working…" : "Stop"}
                          </button>
                        )}
                        <button
                          key="delete"
                          aria-label={`Delete ${name}`}
                          className="button button--ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmingId(sandbox.id)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
              {sandbox.forwards?.length ? (
                <ul className="mcp-access-panel__forwards" aria-label={`Port forwards into ${name}`}>
                  {sandbox.forwards.map((forward) => (
                    <li key={forward.port}>
                      <div className="mcp-access-panel__row-body">
                        <span className="mcp-access-panel__forward-url">{forward.url}</span>
                        <span className="mcp-access-panel__detail">{`sandbox port ${forward.port}`}</span>
                      </div>
                      {change ? (
                        <button
                          aria-label={`Close the tunnel to port ${forward.port} of ${name}`}
                          className="button button--ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => act(sandbox.id, "close_forward", forward.port)}
                        >
                          {busyId === `${sandbox.id}:${forward.port}` ? "Working…" : "Close"}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {confirmingId ? (
        <p className="mcp-access-panel__detail" role="status">
          Deleting removes the machine and its disk. Named snapshots are kept.
        </p>
      ) : null}
      {error ? (
        <p className="mcp-access-panel__state mcp-access-panel__state--error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
