import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProviderCatalogRefreshProviderState,
  ProviderCatalogRefreshState,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../lib/useBackendSummaries";

export type ProviderCatalogRefreshController = {
  available: boolean;
  running: boolean;
  state?: ProviderCatalogRefreshState;
  /** Starting or cancelling the run failed before main answered. */
  error?: string;
  start: () => void;
  cancel: () => void;
};

/**
 * Mirrors main's "Refresh all providers" run. Main owns the run, so this reads
 * it on mount — Settings reopened mid-run shows the run, not an idle button —
 * and follows its broadcasts after that.
 */
export function useProviderCatalogRefresh(
  desktopApi?: DesktopApi,
): ProviderCatalogRefreshController {
  const [state, setState] = useState<ProviderCatalogRefreshState>();
  const [error, setError] = useState<string>();
  const stateRef = useRef<ProviderCatalogRefreshState | undefined>(undefined);

  const accept = useCallback((next: ProviderCatalogRefreshState) => {
    const current = stateRef.current;
    // A snapshot can arrive after a newer one: the mount read races the
    // broadcasts, and a stale "running" would otherwise outlive its run.
    if (current && next.revision <= current.revision) {
      return;
    }
    stateRef.current = next;
    setState(next);
    if (
      current?.runId === next.runId
      && current.status === "running"
      && next.status !== "running"
    ) {
      // Every catalog consumer re-reads; the catalog has no push channel.
      window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
    }
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = desktopApi?.onProviderCatalogRefresh?.((next) => {
      if (active) {
        accept(next);
      }
    });
    void desktopApi?.readProviderCatalogRefresh?.().then(
      (response) => {
        if (active && response.state) {
          accept(response.state);
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [accept, desktopApi]);

  const start = useCallback(() => {
    const startRefresh = desktopApi?.startProviderCatalogRefresh;
    if (!startRefresh) {
      return;
    }
    setError(undefined);
    void startRefresh().then(accept, (startError: unknown) => {
      setError(errorMessage(startError));
    });
  }, [accept, desktopApi]);

  const cancel = useCallback(() => {
    const runId = stateRef.current?.runId;
    const cancelRefresh = desktopApi?.cancelProviderCatalogRefresh;
    if (runId === undefined || !cancelRefresh) {
      return;
    }
    void cancelRefresh({ runId }).then(
      (response) => {
        if (response.state) {
          accept(response.state);
        }
      },
      (cancelError: unknown) => setError(errorMessage(cancelError)),
    );
  }, [accept, desktopApi]);

  return {
    available: Boolean(desktopApi?.startProviderCatalogRefresh),
    running: state?.status === "running",
    ...(state ? { state } : {}),
    ...(error ? { error } : {}),
    start,
    cancel,
  };
}

/**
 * The Refresh / Cancel control plus, while a run is out or after one that
 * left a provider without an answer, one row per provider.
 */
export function ProviderCatalogRefreshControl(props: {
  controller: ProviderCatalogRefreshController;
  disabled: boolean;
}) {
  const { controller } = props;
  const state = controller.state;
  const running = controller.running;
  const now = useNow(running);
  const answered = state?.providers.filter((provider) =>
    isFinished(provider.status),
  ).length ?? 0;
  const total = state?.providers.length ?? 0;
  const showProviders = Boolean(
    state
    && (running
      || state.providers.some(
        (provider) =>
          provider.status === "failed" || provider.status === "cancelled",
      )),
  );

  return (
    <>
      <div className="settings-inline-actions">
        {running ? (
          <>
            <span className="settings-pending" role="status">
              <span
                aria-hidden="true"
                className="pending-spinner pending-spinner--sm"
              />
              {`Refreshing… ${answered} of ${total} done`}
            </span>
            <button
              className="button button--secondary"
              type="button"
              onClick={controller.cancel}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            className="button button--secondary"
            disabled={props.disabled || !controller.available}
            type="button"
            onClick={controller.start}
          >
            Refresh all providers
          </button>
        )}
      </div>
      {state && showProviders ? (
        <ul className="provider-refresh" aria-label="Provider refresh">
          {running && state.phase ? (
            <li className="provider-refresh__phase">{state.phase}</li>
          ) : null}
          {state.providers.map((provider) => (
            <ProviderRefreshRow
              key={provider.id}
              now={now}
              provider={provider}
            />
          ))}
        </ul>
      ) : null}
      {state && !running && !showProviders ? (
        <p className="settings-field__help">{summarize(state)}</p>
      ) : null}
      {controller.error ? (
        <p className="settings-field__help settings-field__value--warn">
          {controller.error}
        </p>
      ) : null}
    </>
  );
}

function ProviderRefreshRow(props: {
  now: number;
  provider: ProviderCatalogRefreshProviderState;
}) {
  const { provider } = props;
  const description = describe(provider);
  const elapsed = provider.startedAt === undefined
    ? undefined
    : (provider.finishedAt ?? props.now) - provider.startedAt;
  return (
    <li className="provider-refresh__row" data-status={provider.status}>
      <span className="provider-refresh__mark" aria-hidden="true">
        {provider.status === "running" ? (
          <span className="pending-spinner pending-spinner--sm" />
        ) : (
          <span className={`status-dot ${STATUS_DOT_CLASS[provider.status]}`} />
        )}
      </span>
      <span className="provider-refresh__name">{provider.label}</span>
      <span className="provider-refresh__detail" title={description}>
        {description}
      </span>
      <span className="provider-refresh__time">
        {elapsed === undefined ? "" : formatElapsed(elapsed)}
      </span>
    </li>
  );
}

const STATUS_DOT_CLASS: Record<
  ProviderCatalogRefreshProviderState["status"],
  string
> = {
  pending: "provider-refresh__dot--pending",
  running: "status-dot--active",
  succeeded: "status-dot--ok",
  failed: "status-dot--error",
  cancelled: "status-dot--suspended",
  skipped: "status-dot--suspended",
};

function describe(provider: ProviderCatalogRefreshProviderState): string {
  switch (provider.status) {
    case "pending":
      return "Waiting";
    case "running":
      return provider.detail ?? "Refreshing";
    case "succeeded":
      if (provider.modelCount !== undefined) {
        return `${provider.modelCount} model${provider.modelCount === 1 ? "" : "s"}`;
      }
      return provider.detail ?? "Refreshed";
    case "failed":
      return provider.error ?? "Failed";
    case "cancelled":
      return "Cancelled";
    case "skipped":
      return provider.detail ?? "Skipped";
  }
}

function summarize(state: ProviderCatalogRefreshState): string {
  const refreshed = state.providers.filter(
    (provider) => provider.status === "succeeded",
  ).length;
  const skipped = state.providers.filter(
    (provider) => provider.status === "skipped",
  );
  const duration = state.finishedAt === undefined
    ? ""
    : ` in ${formatElapsed(state.finishedAt - state.startedAt)}`;
  const summary =
    `Last refresh updated ${refreshed} provider${refreshed === 1 ? "" : "s"}${duration}.`;
  return skipped.length === 0
    ? summary
    : `${summary} Skipped ${skipped
        .map(
          (provider) =>
            `${provider.label} (${(provider.detail ?? "skipped").toLowerCase()})`,
        )
        .join(", ")}.`;
}

function isFinished(
  status: ProviderCatalogRefreshProviderState["status"],
): boolean {
  return status !== "pending" && status !== "running";
}

/** m:ss, so a provider stuck on one step reads as stuck. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** The current time, ticking once a second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
