import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FederationHealthStatus } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export const CLOUDFLARE_SIGN_IN_NOTICE_ID = "cloudflare-sign-in-required";

export function CloudflareSignInNotice(props: {
  desktopApi?: Pick<DesktopApi, "configureFederationCloudflare">;
  health?: FederationHealthStatus;
  onNoticeChanged: (notice: AppNoticeToastNotice | undefined) => void;
  onRefreshHealth: () => void;
}) {
  const endpoint = props.health?.enabled
    ? props.health.cloudflareSignInRequired?.endpoint
    : undefined;
  const configure = props.desktopApi?.configureFederationCloudflare;
  const { onNoticeChanged, onRefreshHealth } = props;
  const [dismissed, setDismissed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const signingIn = useRef(false);
  const controlling = useRef(false);

  // One notice per incident: fresh health objects must not resurrect a
  // dismissal. A cleared requirement arms the next sign-in prompt.
  useEffect(() => {
    generation.current += 1;
    signingIn.current = false;
    controlling.current = false;
    setDismissed(false);
    setPending(false);
    setError(undefined);
    return () => { generation.current += 1; };
  }, [endpoint, configure]);

  const signIn = useCallback(async () => {
    if (!endpoint || !configure || signingIn.current) return;
    const current = generation.current;
    signingIn.current = true;
    setPending(true);
    setError(undefined);
    try {
      const result = await configure({ action: "sign-in" });
      if (generation.current !== current) return;
      if (result.signIn?.state === "signed-in") {
        setDismissed(true);
      }
      onRefreshHealth();
    } catch (failure) {
      if (generation.current !== current) return;
      setError(failure instanceof Error ? failure.message : "Could not sign in to Cloudflare Access. Try again.");
    } finally {
      if (generation.current === current) {
        signingIn.current = false;
        setPending(false);
      }
    }
  }, [endpoint, configure, onRefreshHealth]);

  const controlSignIn = useCallback(async (action: "reopen-sign-in" | "cancel-sign-in") => {
    if (!configure || !signingIn.current || controlling.current) return;
    const current = generation.current;
    controlling.current = true;
    try {
      await configure({ action });
    } catch (failure) {
      if (generation.current === current) {
        setError(failure instanceof Error ? failure.message : "Could not update the browser sign-in. Try again.");
      }
    } finally {
      if (generation.current === current) controlling.current = false;
    }
  }, [configure]);

  const notice = useMemo<AppNoticeToastNotice | undefined>(() => {
    if (!endpoint || !configure || dismissed) return undefined;
    return {
      id: CLOUDFLARE_SIGN_IN_NOTICE_ID,
      title: "Cloudflare Access needs sign-in",
      message: pending
        ? "Finish signing in in your browser. Federation reconnects when sign-in completes."
        : "Federation is disconnected. Sign in again to reconnect to your other machines.",
      detail: error,
      facts: [{ label: "Endpoint", value: endpoint }],
      autoDismiss: false,
      tone: error ? "error" : "warning",
      status: pending ? { label: "Waiting for browser sign-in", state: "progress" } : undefined,
      actions: pending ? [
        { label: "Open browser again", onClick: () => { void controlSignIn("reopen-sign-in"); } },
        { label: "Cancel sign-in", onClick: () => { void controlSignIn("cancel-sign-in"); } },
      ] : [
        { label: error ? "Retry sign-in" : "Sign in", tone: "primary", onClick: () => { void signIn(); } },
      ],
      onDismiss: () => setDismissed(true),
    };
  }, [endpoint, configure, dismissed, pending, error, signIn, controlSignIn]);

  useEffect(() => {
    onNoticeChanged(notice);
  }, [notice, onNoticeChanged]);

  return null;
}
