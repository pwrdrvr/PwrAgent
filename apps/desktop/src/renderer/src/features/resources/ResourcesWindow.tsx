import { useMemo } from "react";
import { useDesktopApi } from "../../lib/desktop-api";
import { BrandLockup } from "../chrome/BrandLockup";
import { createDesktopResourceCheckoutsSource } from "./resource-checkouts-source";
import { ResourcesScreen } from "./ResourcesScreen";

export function ResourcesWindow() {
  const api = useDesktopApi();
  const source = useMemo(() => createDesktopResourceCheckoutsSource(api), [api]);

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
          hasWindowTitleBar
          source={source}
          onOpenThread={(thread) => { void api?.openResourceCheckoutThread?.(thread); }}
        />
      ) : <p role="status">Resources are unavailable.</p>}
    </main>
  );
}
