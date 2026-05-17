import { useEffect, useState } from "react";
import type { AppLicenseDocument } from "../../../../shared/app-metadata";
import { useDesktopApi } from "../../lib/desktop-api";

export function LicenseDocumentWindow() {
  const desktopApi = useDesktopApi();
  const [licenseDocument, setLicenseDocument] = useState<
    AppLicenseDocument | undefined
  >();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    document.title = "Third-Party Notices";
  }, []);

  useEffect(() => {
    let cancelled = false;
    const reader = desktopApi?.readLicenseDocument;
    if (!reader) {
      return;
    }

    reader("third-party-licenses")
      .then((value) => {
        if (!cancelled) {
          setLicenseDocument(value);
          setError(undefined);
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
  }, [desktopApi]);

  return (
    <div className="document-window">
      <section aria-label="PwrAgent third-party notices" className="activity-screen">
        <header className="activity-titlebar">
          <p className="activity-titlebar__brand">
            Pwr<span className="activity-titlebar__brand-accent">Agent</span>
          </p>
          <div className="activity-titlebar__breadcrumb">
            <span className="activity-titlebar__eyebrow">Help</span>
            <span aria-hidden="true" className="activity-titlebar__separator">
              ›
            </span>
            <span className="activity-titlebar__current">Third-Party Notices</span>
          </div>
          <div className="activity-titlebar__spacer" />
        </header>
        <main className="document-window__content">
          <article className="document-window__body">
            {error ? (
              <p className="document-window__error" role="alert">
                Could not load third-party notices: {error}
              </p>
            ) : licenseDocument ? (
              <pre className="document-window__pre">{licenseDocument.content}</pre>
            ) : (
              <p className="document-window__empty">Loading…</p>
            )}
          </article>
        </main>
      </section>
    </div>
  );
}
