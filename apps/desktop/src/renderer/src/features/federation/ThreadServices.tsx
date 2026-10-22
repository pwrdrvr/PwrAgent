import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ServiceForward, ServiceUiRequest, ServiceUiResponse, ThreadService } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatByteCount } from "../../lib/format-bytes";
import { ChevronRightIcon } from "../../icons/ChevronRightIcon";
import { PlugIcon } from "../../icons/PlugIcon";
import { PopoutIcon } from "../../icons/PopoutIcon";
import "./thread-services.css";

type Props = {
  api: NonNullable<DesktopApi["threadServices"]>;
  backend: ServiceUiRequest["backend"];
  threadId: string;
  instanceId?: string;
  ownerLabel?: string;
  onOpenFederationSettings?: () => void;
};

const LIFETIME_NOTE = "Forwarding stops when you leave this thread or close the window.";
const REMOVE_NOTE = "Withdraw this port for every viewer. Ends their forwards.";

/** Key the mounted component by owner/backend/thread, so stale async results
 * never populate the next thread and unmount releases only its own forwards. */
export function ThreadServices({ api, backend, threadId, instanceId, ownerLabel, onOpenFederationSettings }: Props) {
  const [state, setState] = useState<ServiceUiResponse>({ services: [], forwards: [] });
  const viewId = useRef("");
  const [actionError, setActionError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hadServices, setHadServices] = useState(false);
  const bodyId = useId();
  const statusId = useId();
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
        if (alive) {
          setState(result);
          setError(undefined);
          if (result.services.length) setHadServices(true);
        }
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

  // Most threads advertise nothing. Show the bar only for a thread that has
  // ports, or had them before an error, so ordinary threads stay quiet.
  if (!state.services.length && !state.forwards.length && !(error && hadServices)) return null;

  const remote = instanceId !== undefined;
  const owner = ownerLabel ?? state.services[0]?.ownerInstanceId ?? "the owning machine";
  const blocked = state.forwarding === "blocked";
  const inbound = state.inbound ?? [];
  const inboundPeers = [...new Set(inbound.flatMap((entry) => entry.peerLabels))];
  const live = remote ? state.forwards.length > 0 : inboundPeers.length > 0;
  const soleForward = state.forwards.length === 1 ? state.forwards[0] : undefined;

  let status: ReactNode;
  if (error) {
    status = "Ports unavailable";
  } else if (remote && soleForward) {
    status = <>
      <b>Forwarding</b>
      <span className="thread-services__address">127.0.0.1:{soleForward.localPort}</span>
    </>;
  } else if (remote && state.forwards.length) {
    status = <b>Forwarding {state.forwards.length} ports</b>;
  } else if (live) {
    status = <><b>Forwarded to</b> {inboundPeers.join(", ")}</>;
  } else if (blocked) {
    status = remote ? `Forwarding is off on ${owner}` : "Forwarding is off on this machine";
  } else {
    status = remote ? "Not forwarded" : "Peers can forward";
  }

  return (
    <section
      className={`thread-services${live ? " is-live" : ""}`}
      aria-label="Thread ports"
    >
      <div className="thread-services__bar">
        <button
          type="button"
          className={`thread-services__toggle${remote && live ? " tooltip-target" : ""}`}
          aria-label={`Ports (${state.services.length})`}
          aria-describedby={statusId}
          aria-expanded={expanded}
          aria-controls={bodyId}
          data-tooltip={remote && live ? LIFETIME_NOTE : undefined}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRightIcon
            className={`thread-services__chevron${expanded ? " is-open" : ""}`}
            size={12}
          />
          <PlugIcon className="thread-services__icon" size={14} />
          <span className="thread-services__label">Ports</span>
          <span className="thread-services__count">{state.services.length}</span>
          <span
            id={statusId}
            className={`thread-services__status${live ? "" : " is-muted"}`}
          >
            <span className={live ? "thread-services__live" : "thread-services__idle"} aria-hidden="true" />
            {status}
          </span>
        </button>
        {soleForward?.url ? (
          <button
            type="button"
            className="thread-services__open"
            aria-label={`Open 127.0.0.1:${soleForward.localPort} in Browser`}
            disabled={busy}
            onClick={() => { void act("open", soleForward.service.serviceId, soleForward.forwardId); }}
          >
            Open
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div className="thread-services__body" id={bodyId}>
          {actionError ? <p className="thread-services__alert" role="alert">{actionError}</p> : null}
          {error ? <p className="thread-services__alert" role="alert">{error}</p> : null}
          {!remote && blocked && state.services.length ? (
            <p className="thread-services__reason">
              Peers can see these ports but cannot forward them.
              {onOpenFederationSettings ? (
                <button
                  type="button"
                  className="thread-services__link"
                  onClick={onOpenFederationSettings}
                >
                  Federation Settings
                </button>
              ) : null}
            </p>
          ) : null}
          {state.services.map((service) => (
            <ServiceRow
              key={service.serviceId}
              service={service}
              forward={state.forwards.find((entry) => entry.service.serviceId === service.serviceId)}
              inUseBy={inbound.find((entry) => entry.serviceId === service.serviceId)?.peerLabels ?? []}
              remote={remote}
              owner={owner}
              blocked={blocked}
              busy={busy}
              onAction={(action, forwardId) => { void act(action, service.serviceId, forwardId); }}
            />
          ))}
          {state.services.length ? (
            <p className="thread-services__note">
              {remote
                ? `Forwards use this machine’s loopback address. ${LIFETIME_NOTE} Apps must accept the local origin. HTTPS uses the app’s own certificate.`
                : "Peers forward these ports only after they click Forward Port. Remove ends every forward to the port."}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ServiceRow(props: {
  service: ThreadService;
  forward?: ServiceForward;
  inUseBy: string[];
  remote: boolean;
  owner: string;
  blocked: boolean;
  busy: boolean;
  onAction: (action: ServiceUiRequest["action"], forwardId?: string) => void;
}) {
  const { service, forward, remote, owner } = props;
  const endpoint = `${service.address}:${service.port}`;
  const expires = new Date(service.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const forwardBlockedReason = remote && props.blocked && !forward
    ? `Turn on Allow port forwarding in ${owner}’s Federation settings.`
    : undefined;
  return (
    <div className="thread-services__row">
      <div className="thread-services__head">
        <div className="thread-services__name">
          <strong>{service.name}</strong>
          <span className="thread-services__protocol">{service.protocol.toUpperCase()}</span>
        </div>
        <div className="thread-services__actions">
          {forward?.url ? (
            <button
              type="button"
              className="button button--primary"
              disabled={props.busy}
              onClick={() => props.onAction("open", forward.forwardId)}
            >
              <PopoutIcon size={13} />
              Open in Browser
            </button>
          ) : null}
          {remote ? (
            <button
              type="button"
              className={`button button--secondary${forwardBlockedReason ? " tooltip-target" : ""}`}
              aria-disabled={forwardBlockedReason ? true : undefined}
              data-tooltip={forwardBlockedReason}
              disabled={props.busy}
              onClick={() => {
                if (forwardBlockedReason) return;
                props.onAction(forward ? "disconnect" : "connect", forward?.forwardId);
              }}
            >
              {forward ? "Stop Forwarding" : "Forward Port"}
            </button>
          ) : null}
          <button
            type="button"
            className="button button--ghost tooltip-target"
            aria-label="Remove Advertisement"
            data-tooltip={REMOVE_NOTE}
            disabled={props.busy}
            onClick={() => props.onAction("remove")}
          >
            Remove
          </button>
        </div>
      </div>
      <div className="thread-services__identity">
        {service.description ? <p className="thread-services__description">{service.description}</p> : null}
        <div className="thread-services__mapping">
          {forward ? (
            <>
              <span className="thread-services__live" aria-hidden="true" />
              <span className="thread-services__local">127.0.0.1:{forward.localPort}</span>
              <span className="thread-services__arrow">→</span>
              <span>{endpoint} on {owner}</span>
            </>
          ) : remote ? (
            <span>{endpoint} on {owner}</span>
          ) : (
            <>
              <span>{endpoint}</span>
              {props.inUseBy.length ? (
                <span className="thread-services__local">In use by {props.inUseBy.join(", ")}</span>
              ) : null}
            </>
          )}
        </div>
        <div className="thread-services__meta">
          {forward
            ? `${formatByteCount(forward.sentBytes)} sent · ${formatByteCount(forward.receivedBytes)} received · `
            : ""}
          Advertised until {expires}
        </div>
        {forward?.error ? <p className="thread-services__alert" role="alert">{forward.error}</p> : null}
      </div>
      {forwardBlockedReason ? <p className="thread-services__reason">{forwardBlockedReason}</p> : null}
    </div>
  );
}
