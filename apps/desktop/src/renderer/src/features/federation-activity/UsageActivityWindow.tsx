import { useEffect } from "react";
import { parseUsageLimitProvider } from "@pwragent/shared";
import { useDesktopApi } from "../../lib/desktop-api";
import { BrandLockup } from "../chrome/BrandLockup";
import { UsageActivity } from "./UsageActivity";

/** The provider a surface opened the window on: `#usage-activity?provider=anthropic`. */
function hashProvider(): string | undefined {
  const query = window.location.hash.split("?")[1];
  return query ? parseUsageLimitProvider(new URLSearchParams(query).get("provider")) : undefined;
}

export function UsageActivityWindow() {
  const desktopApi = useDesktopApi();
  useEffect(() => { document.title = "Usage Activity"; }, []);
  return <div className="messaging-activity-window"><section aria-label="Usage activity" className="activity-screen">
    <header className="activity-titlebar">
      <BrandLockup variant="activity-titlebar" />
      <div className="activity-titlebar__breadcrumb"><span className="activity-titlebar__eyebrow">Usage</span>
        <span aria-hidden="true" className="activity-titlebar__separator">›</span>
        <span className="activity-titlebar__current">Limits and spend</span></div>
      <div className="activity-titlebar__spacer" />
    </header>
    <div className="activity-content usage-activity-content"><UsageActivity desktopApi={desktopApi} initialProvider={hashProvider()} /></div>
  </section></div>;
}
