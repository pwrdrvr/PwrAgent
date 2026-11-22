import { useCallback, useEffect, useRef, useState } from "react";
import type { LineRichMenuSetupRequest, LineRichMenuSetupResponse } from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../lib/desktop-api";
import { SettingsField } from "./SettingsLayout";

type Action = LineRichMenuSetupRequest["action"];
type MenuStatus = Extract<LineRichMenuSetupResponse, { accountId: string }>;

export function LineRichMenuSettings({ configured, setup }: {
  configured: boolean;
  setup: DesktopApi["lineRichMenuSetup"];
}) {
  const [menu, setMenu] = useState<MenuStatus>();
  const [error, setError] = useState<Extract<LineRichMenuSetupResponse, { kind: "error" }>>();
  const [pending, setPending] = useState<Action>();
  const [failed, setFailed] = useState<LineRichMenuSetupRequest>();
  const [confirmation, setConfirmation] = useState(false);
  const requestSequence = useRef(0);
  const keepButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);

  const run = useCallback(async (request: LineRichMenuSetupRequest) => {
    if (!setup) return;
    const sequence = ++requestSequence.current;
    setPending(request.action);
    setError(undefined);
    setFailed(undefined);
    const result = await setup(request).catch((): LineRichMenuSetupResponse => ({ kind: "error", reason: "request-failed" }));
    if (sequence !== requestSequence.current) return;
    setPending(undefined);
    if (result.kind === "error") {
      setError(result);
      setFailed(request);
    } else {
      setMenu(result.kind === "unconfigured" ? undefined : result);
    }
  }, [setup]);

  useEffect(() => {
    if (configured) void run({ action: "check" });
    return () => { requestSequence.current += 1; };
  }, [configured, run]);

  useEffect(() => {
    if (confirmation) keepButton.current?.focus();
  }, [confirmation]);

  const check = () => { void run({ action: "check" }); };
  const available = menu?.kind === "available" && !menu.cleanupRequired;
  const updating = menu?.kind === "installed" && menu.updateAvailable;
  const installLabel = updating ? "Update rich menu" : "Install rich menu";
  const canRetrySetup = menu?.kind === "installed" && menu.cleanupRequired;
  const canRemove = menu?.kind === "installed" || menu?.cleanupRequired;
  const status = pending ? pendingText(pending, updating) : menu ? menuStatusText(menu) : undefined;

  if (!setup) return null;
  return (
    <SettingsField
      label="Rich menu"
      sub="Add an account-wide default menu with PwrAgent commands. Rich menus appear only in the LINE mobile app."
      control={configured ? (
        <div className="settings-line-rich-menu">
          {menu ? (
            <img
              className="settings-line-rich-menu__preview"
              src={menu.preview}
              alt="PwrAgent menu preview with Resume, New thread, Status, Detach and Help"
              width={2500}
              height={843}
            />
          ) : null}
          {error ? <p className="settings-row__description" role="alert">{errorText(error.reason, failed?.action)}</p>
            : <p className="settings-row__description" role="status">{status}</p>}
          {pending === "install" || pending === "remove" ? (
            <p className="settings-row__description">Wait for this action to finish before changing the default menu in LINE.</p>
          ) : null}
          {menu?.kind === "installed" && !pending && !error ? (
            <p className="settings-row__description">Existing per-user menus take precedence. Reopen the LINE mobile chat to see changes.</p>
          ) : null}
          {confirmation && menu ? (
            <div className="settings-action-confirmation" aria-live="polite">
              <div className="settings-action-confirmation__copy">
                <strong>Remove the PwrAgent rich menu?</strong>
                <span>This removes the menu created by this profile from the LINE Official Account.</span>
              </div>
              <div className="settings-inline-actions">
                <button className="button button--secondary" type="button" ref={keepButton} onClick={() => {
                  setConfirmation(false);
                  requestAnimationFrame(() => removeButton.current?.focus());
                }}>Keep menu</button>
                <button className="button button--secondary" type="button" onClick={() => {
                  setConfirmation(false);
                  void run({ action: "remove", accountId: menu.accountId });
                }}>Remove rich menu</button>
              </div>
            </div>
          ) : (
            <div className="settings-inline-actions" aria-busy={pending !== undefined}>
              {error && failed?.action === "install" && error.reason !== "changed" ? (
                <button className="button button--secondary" type="button" onClick={() => { void run(failed); }}>Retry</button>
              ) : null}
              {!error && menu && (available || updating || canRetrySetup) ? (
                <button className="button button--secondary" type="button" disabled={pending !== undefined}
                  onClick={() => { void run({ action: "install", accountId: menu.accountId }); }}>
                  {canRetrySetup && !updating ? "Finish setup" : installLabel}
                </button>
              ) : null}
              {canRemove && (!error || (failed?.action === "remove" && error.reason !== "changed")) ? (
                <button className="button button--ghost" type="button" disabled={pending !== undefined}
                  ref={removeButton} onClick={() => setConfirmation(true)}>
                  {menu.kind === "installed" ? "Remove rich menu" : "Delete unused menu"}
                </button>
              ) : null}
              <button className="button button--ghost" type="button" disabled={pending !== undefined} onClick={check}>Check again</button>
            </div>
          )}
        </div>
      ) : <p className="settings-row__description">Save a channel access token to check rich menu availability.</p>}
    />
  );
}

function pendingText(action: Action, updating: boolean): string {
  if (action === "check") return "Checking the LINE account’s default menu…";
  if (action === "remove") return "Removing the PwrAgent rich menu…";
  return updating ? "Updating the PwrAgent rich menu…" : "Installing the PwrAgent rich menu…";
}

function menuStatusText(menu: MenuStatus): string {
  if (menu.kind === "blocked") {
    return menu.reason === "administrator"
      ? "LINE Official Account Manager controls the default menu."
      : "The account’s default menu was set outside this PwrAgent profile.";
  }
  if (menu.kind === "available") {
    return menu.cleanupRequired ? "A previous setup needs cleanup. Use Delete unused menu to finish it."
      : "LINE has no default rich menu. Ready to install.";
  }
  if (menu.updateAvailable) return `Update available from ${menu.revision} to ${menu.version}.`;
  return menu.cleanupRequired ? "Rich menu installed. Finish setup to clean up the previous menu."
    : `Rich menu installed (${menu.revision}).`;
}

function errorText(reason: Extract<LineRichMenuSetupResponse, { kind: "error" }>["reason"], action?: Action): string {
  if (reason === "busy") return "Another PwrAgent window is managing this account’s rich menu. Check again when it finishes.";
  if (reason === "changed") return "The LINE account or its default menu changed. Check again before continuing.";
  if (reason === "rolled-back") return "LINE couldn’t finish setup. PwrAgent rolled back the new menu.";
  if (action === "check") return "PwrAgent couldn’t verify LINE’s default rich menu. Check again before making changes.";
  const operation = action === "remove" ? "removal" : "rich menu setup";
  return `LINE didn’t confirm ${operation}. PwrAgent will check which menu is active before retrying.`;
}
