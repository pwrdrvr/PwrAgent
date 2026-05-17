import { useEffect, useState } from "react";
import type {
  AppLicenseDocument,
  AppLicenseDocumentKind,
} from "../../../../shared/app-metadata";
import { useDesktopApi } from "../../lib/desktop-api";

function currentDocumentKind(): AppLicenseDocumentKind {
  return window.location.hash.replace(/^#/, "") === "license"
    ? "license"
    : "third-party-licenses";
}

export function LicenseDocumentWindow() {
  const desktopApi = useDesktopApi();
  const documentKind = currentDocumentKind();
  const fallbackTitle =
    documentKind === "license" ? "MIT License" : "Third-Party Notices";
  const [licenseDocument, setLicenseDocument] = useState<
    AppLicenseDocument | undefined
  >();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    document.title = fallbackTitle;
  }, [fallbackTitle]);

  useEffect(() => {
    let cancelled = false;
    const reader = desktopApi?.readLicenseDocument;
    if (!reader) {
      return;
    }

    reader(documentKind)
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
  }, [desktopApi, documentKind]);

  const title = licenseDocument?.title ?? fallbackTitle;

  return (
    <div className="document-window">
      <section aria-label={`PwrAgent ${title}`} className="activity-screen">
        <header className="activity-titlebar">
          <p className="activity-titlebar__brand">
            Pwr<span className="activity-titlebar__brand-accent">Agent</span>
          </p>
          <div className="activity-titlebar__breadcrumb">
            <span className="activity-titlebar__eyebrow">Help</span>
            <span aria-hidden="true" className="activity-titlebar__separator">
              ›
            </span>
            <span className="activity-titlebar__current">{title}</span>
          </div>
          <div className="activity-titlebar__spacer" />
        </header>
        <main className="document-window__content">
          <article className="document-window__body">
            {error ? (
              <p className="document-window__error" role="alert">
                Could not load {title.toLowerCase()}: {error}
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
