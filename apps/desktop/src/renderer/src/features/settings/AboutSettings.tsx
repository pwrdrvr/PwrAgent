import { useEffect, useState } from "react";
import type { AppMetadata } from "../../../../shared/app-metadata";
import type { DesktopApi } from "../../lib/desktop-api";

export function AboutSettings(props: { desktopApi?: DesktopApi }) {
  const [metadata, setMetadata] = useState<AppMetadata | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const reader = props.desktopApi?.readAppMetadata;
    if (!reader) {
      return;
    }
    reader()
      .then((value) => {
        if (!cancelled) {
          setMetadata(value);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.desktopApi]);

  if (error) {
    return (
      <div className="settings-panel" role="alert">
        <p className="settings-row__error">Could not load app info: {error}</p>
      </div>
    );
  }

  if (!metadata) {
    return (
      <div className="settings-panel">
        <p className="settings-empty">Loading…</p>
      </div>
    );
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel__header">
        <div>
          <p className="eyebrow">About</p>
          <h2>{metadata.applicationName}</h2>
        </div>
      </div>
      <dl className="settings-row">
        <div>
          <dt>Version</dt>
          <dd>{metadata.applicationVersion}</dd>
        </div>
        <div>
          <dt>Copyright</dt>
          <dd>{metadata.copyright}</dd>
        </div>
        <div>
          <dt>Website</dt>
          <dd>
            <a href={metadata.homepage} target="_blank" rel="noreferrer">
              {metadata.homepage}
            </a>
          </dd>
        </div>
        <div>
          <dt>Electron</dt>
          <dd>{metadata.electronVersion}</dd>
        </div>
        <div>
          <dt>Chromium</dt>
          <dd>{metadata.chromeVersion}</dd>
        </div>
        <div>
          <dt>Node</dt>
          <dd>{metadata.nodeVersion}</dd>
        </div>
      </dl>
    </div>
  );
}
