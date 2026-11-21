import { useEffect, useState } from "react";
import {
  type BoatThreadSandbox,
  type BoatThreadSandboxAction,
} from "@pwragent/shared/contracts/mcp-connections";
import type { DesktopApi } from "../../lib/desktop-api";

/** States in which Boat is no longer billing for a running machine. */
const AT_REST = new Set(["archiving", "archived", "cancelled", "error", "stopped"]);

/**
 * The last list read per thread. Reopening the panel shows it at once and
 * reads again underneath, so the section does not arrive after the rest.
 */
const lastRead = new Map<string, BoatThreadSandbox[]>();

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
  const [busyId, setBusyId] = useState<string>();
  const [confirmingId, setConfirmingId] = useState<string>();
  const [error, setError] = useState<string>();
  // Another thread's sandboxes are never shown under this one.
  const sandboxes = read?.key === key ? read.sandboxes : lastRead.get(key);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    setConfirmingId(undefined);
    if (!list) return;
    void (async () => {
      try {
        const response = await list({ backend, threadId });
        if (cancelled) return;
        lastRead.set(key, response.sandboxes);
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

  const act = (sandboxId: string, action: BoatThreadSandboxAction): void => {
    if (!change || busyId) return;
    setBusyId(sandboxId);
    setError(undefined);
    setConfirmingId(undefined);
    void change({ backend, threadId, sandboxId, action })
      .then((response) => {
        lastRead.set(key, response.sandboxes);
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
          const busy = busyId !== undefined;
          return (
            <li key={sandbox.id}>
              <div className="mcp-access-panel__row-body">
                <span className="mcp-access-panel__verify-name">{name}</span>
                <span className="mcp-access-panel__detail">
                  {[sandbox.state ?? "unknown", sandbox.type, cost ? `${cost} so far` : undefined]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              {change ? (
                <div className="mcp-access-panel__row-actions">
                  {confirmingId === sandbox.id ? (
                    <>
                      <button
                        className="button button--ghost"
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmingId(undefined)}
                      >
                        Keep
                      </button>
                      <button
                        aria-label={`Delete ${name} and its disk`}
                        className="button button--secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => act(sandbox.id, "delete")}
                      >
                        Delete it
                      </button>
                    </>
                  ) : (
                    <>
                      {sandbox.state && AT_REST.has(sandbox.state) ? null : (
                        <button
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
