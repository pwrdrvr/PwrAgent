import { useEffect } from "react";
import { useDesktopApi } from "../../lib/desktop-api";
import { UsageActivity } from "./UsageActivity";

export function UsageActivityWindow() {
  const desktopApi = useDesktopApi();
  useEffect(() => { document.title = "Usage Activity"; }, []);
  return <div className="messaging-activity-window"><section aria-label="Usage activity" className="activity-screen">
    <header className="activity-titlebar">
      <p className="activity-titlebar__brand">Pwr<span className="activity-titlebar__brand-accent">Agent</span></p>
      <div className="activity-titlebar__breadcrumb"><span className="activity-titlebar__eyebrow">Usage</span>
        <span aria-hidden="true" className="activity-titlebar__separator">›</span>
        <span className="activity-titlebar__current">Limits and spend</span></div>
      <div className="activity-titlebar__spacer" />
    </header>
    <div className="activity-content usage-activity-content"><UsageActivity desktopApi={desktopApi} /></div>
  </section></div>;
}
