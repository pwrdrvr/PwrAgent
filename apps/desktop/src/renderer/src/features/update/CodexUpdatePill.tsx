import { useCallback, useEffect, useMemo, useState } from "react";
import type { CodexUserUpdateState } from "../../../../shared/codex-user-update";
import { PendingSpinner } from "../../components/PendingSpinner";
import { CloseIcon } from "../../icons";
import { OPENAI_CODEX_RELEASES_URL } from "../../lib/codex-release-channel";
import { copyText } from "../../lib/copy-text";
import type { DesktopApi } from "../../lib/desktop-api";
import { buildCodexUpdatePillView, type CodexUpdatePillAction } from "./codex-update-pill";

type CodexUpdateApi = Pick<
  DesktopApi,
  "copyText" | "readCodexUserUpdate" | "startCodexUserUpdate" | "onCodexUserUpdate"
>;

/**
 * The sidebar's Codex update status: a newer stock Codex, the update PwrAgent
 * is running, or how it ended. Small and at the bottom of the rail, never a
 * dialog. Dismissals last for this window's session; a release still not
 * installed asks again at the next launch.
 */
export function CodexUpdatePill(props: {
  desktopApi?: CodexUpdateApi;
  /**
   * Changes when the Codex PwrAgent launches changes (another executable, a
   * new version), so the offer is read again.
   */
  codexIdentity?: string;
}) {
  const { desktopApi, codexIdentity } = props;
  const [state, setState] = useState<CodexUserUpdateState>();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [startError, setStartError] = useState<string>();
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    return desktopApi?.onCodexUserUpdate?.((next) => setState(next));
  }, [desktopApi]);

  // A start failure describes the state it was pressed in; a newer one from
  // main replaces it.
  useEffect(() => {
    setStartError(undefined);
  }, [state]);

  useEffect(() => {
    let current = true;
    void desktopApi?.readCodexUserUpdate?.()
      .then((next) => {
        if (current) setState(next);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [desktopApi, codexIdentity]);

  const baseView = useMemo(() => buildCodexUpdatePillView(state, dismissed), [state, dismissed]);
  const view = useMemo(() => (
    baseView && startError && baseView.tone === "available"
      ? { ...baseView, tone: "error" as const, description: startError }
      : baseView
  ), [baseView, startError]);

  const dismiss = useCallback(() => {
    if (!view) return;
    setStartError(undefined);
    setDismissed((previous) => new Set([...previous, ...view.dismissKeys]));
  }, [view]);

  useEffect(() => {
    if (!view?.autoDismissMs) return undefined;
    const timer = setTimeout(dismiss, view.autoDismissMs);
    return () => clearTimeout(timer);
  }, [view?.key, view?.autoDismissMs, dismiss]);

  const runAction = useCallback(async (action: CodexUpdatePillAction) => {
    if (action.kind === "copy") {
      await copyText(action.command, desktopApi);
      return;
    }
    if (action.kind === "releases") {
      window.open(OPENAI_CODEX_RELEASES_URL, "_blank", "noopener,noreferrer");
      return;
    }
    if (!desktopApi?.startCodexUserUpdate || starting) return;
    setStarting(true);
    setStartError(undefined);
    try {
      setState(await desktopApi.startCodexUserUpdate());
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }, [desktopApi, starting]);

  if (!view) return null;
  const busy = view.tone === "loading";
  return (
    <div
      className={`codex-update-pill codex-update-pill--${view.tone}`}
      role="status"
      aria-live="polite"
      aria-busy={busy || undefined}
      data-testid="codex-update-pill"
    >
      <span className="codex-update-pill__mark" aria-hidden="true">
        {busy ? <PendingSpinner pairing="paired" size="sm" /> : <span className="codex-update-pill__dot" />}
      </span>
      <div className="codex-update-pill__text">
        <span className="codex-update-pill__title">{view.title}</span>
        <span className="codex-update-pill__description">{view.description}</span>
      </div>
      {view.action ? (
        <button
          className="codex-update-pill__action"
          type="button"
          disabled={starting}
          onClick={() => { void runAction(view.action!); }}
        >
          {view.action.label}
        </button>
      ) : null}
      {view.dismissKeys.length ? (
        <button
          className="codex-update-pill__dismiss"
          type="button"
          aria-label="Dismiss Codex update"
          onClick={dismiss}
        >
          <CloseIcon size={12} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
