import { useEffect, useRef, useState } from "react";
import type { ServiceUiRequest, ServiceUiResponse } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import "./thread-services.css";

type Props = {
  api: NonNullable<DesktopApi["threadServices"]>;
  backend: ServiceUiRequest["backend"];
  threadId: string;
  instanceId?: string;
  ownerLabel?: string;
};

/** Key the mounted component by owner/backend/thread, so stale async results
 * never populate the next thread and unmount releases only its own forwards. */
export function ThreadServices({ api, backend, threadId, instanceId, ownerLabel }: Props) {
  const [state, setState] = useState<ServiceUiResponse>({ services: [], forwards: [] });
  const viewId = useRef("");
  const [actionError, setActionError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const currentViewId = crypto.randomUUID();
    viewId.current = currentViewId;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async (): Promise<void> => {
      try {
        // Registration is idempotent. Re-establish it after runtime restarts,
        // which clear watches and forwards without remounting this component.
        const result = await api({ action: "watch", viewId: currentViewId, backend, threadId, instanceId });
        if (alive) { setState(result); setError(undefined); }
      } catch (cause) {
        if (alive) { setState({ services: [], forwards: [] }); setError(cause instanceof Error ? cause.message : "Services unavailable."); }
      } finally { if (alive) timer = setTimeout(() => { void refresh(); }, 3000); }
    };
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
      void api({ action: "leave", viewId: currentViewId, backend, threadId, instanceId }).catch(() => undefined);
    };
  }, [api, backend, threadId, instanceId]);

  const act = async (action: ServiceUiRequest["action"], serviceId?: string, forwardId?: string): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try { setState(await api({ action, viewId: viewId.current, backend, threadId, instanceId, serviceId, forwardId })); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "Service action failed."); }
    finally { setBusy(false); }
  };
  if (!instanceId && state.services.length === 0) return null;
  return (
    <section className="thread-services" aria-label="Thread services">
      <button className="button button--ghost thread-services__toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        Services · {state.services.length}{state.forwards.length ? ` · ${state.forwards.length} connected` : ""}
      </button>
      {expanded ? <div className="thread-services__body">
        {actionError ? <p role="alert">{actionError}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {!state.services.length && !error ? <p>No services advertised for this thread.</p> : null}
        {state.services.map((service) => {
          const forward = state.forwards.find((entry) => entry.service.serviceId === service.serviceId);
          return <div className="thread-services__row" key={service.serviceId}>
            <div className="thread-services__identity">
              <strong>{service.name}</strong>
              <span>{ownerLabel ?? service.ownerInstanceId} · {service.protocol.toUpperCase()} · {service.address}:{service.port}</span>
              {service.description ? <span>{service.description}</span> : null}
              <span>Expires {new Date(service.expiresAt).toLocaleTimeString()}</span>
              {forward ? <span>127.0.0.1:{forward.localPort} → {service.address}:{service.port} · {forward.sentBytes.toLocaleString()} B sent · {forward.receivedBytes.toLocaleString()} B received</span> : null}
              {forward?.error ? <span role="alert">{forward.error}</span> : null}
            </div>
            <div className="thread-services__actions">
              {instanceId ? <button className="button button--secondary" disabled={busy} onClick={() => { void act(forward ? "disconnect" : "connect", service.serviceId, forward?.forwardId); }}>
                {forward ? "Disconnect" : "Connect"}
              </button> : null}
              {forward?.url ? <button className="button button--secondary" disabled={busy} onClick={() => { void act("open", service.serviceId, forward.forwardId); }}>Open</button> : null}
              <button className="button button--ghost" disabled={busy} onClick={() => { void act("remove", service.serviceId); }}>Remove</button>
            </div>
          </div>;
        })}
        {state.services.length ? <p className="thread-services__note">Connect forwards only to this machine’s loopback. Apps must accept the assigned local origin. HTTPS uses the app’s certificate.</p> : null}
      </div> : null}
    </section>
  );
}
