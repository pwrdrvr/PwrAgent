import { useEffect, useMemo, useState } from "react";
import { readResourceCheckoutsWindowFocus } from "@pwragent/shared/contracts/resource-checkouts";
import { useDesktopApi } from "../../lib/desktop-api";
import { BrandLockup } from "../chrome/BrandLockup";
import { createDesktopResourceCheckoutsSource } from "./resource-checkouts-source";
import { ResourcesScreen, type ResourceFocusRequest } from "./ResourcesScreen";

/** `#resources/<resource id>` opens the window on that resource. */
export function readResourcesHashFocus(hash: string): ResourceFocusRequest | undefined {
  const match = /^#?resources\/(.+)$/.exec(hash);
  if (!match) return undefined;
  let resourceId: string;
  try {
    resourceId = decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
  const focus = readResourceCheckoutsWindowFocus({ resourceId });
  return focus ? { ...focus, nonce: 0 } : undefined;
}

export function ResourcesWindow() {
  const api = useDesktopApi();
  const source = useMemo(() => createDesktopResourceCheckoutsSource(api), [api]);
  const [focus, setFocus] = useState(() => readResourcesHashFocus(window.location.hash));
  const subscribeFocus = api?.onResourceCheckoutsFocus;
  useEffect(() => subscribeFocus?.((request) => {
    const next = readResourceCheckoutsWindowFocus(request);
    if (next) setFocus((current) => ({ ...next, nonce: (current?.nonce ?? 0) + 1 }));
  }), [subscribeFocus]);

  return (
    <main className="document-window">
      <header className="activity-titlebar">
        <BrandLockup variant="activity-titlebar" />
        <div className="activity-titlebar__breadcrumb">
          <span className="activity-titlebar__eyebrow">Resources</span>
        </div>
      </header>
      {source ? (
        <ResourcesScreen
          focus={focus}
          hasWindowTitleBar
          source={source}
          onOpenThread={(thread) => { void api?.openResourceCheckoutThread?.(thread); }}
        />
      ) : <p role="status">Resources are unavailable.</p>}
    </main>
  );
}
