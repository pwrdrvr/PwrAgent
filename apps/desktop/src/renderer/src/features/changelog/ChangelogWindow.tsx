import { useEffect, useState } from "react";
import type { AppChangelogDocument } from "../../../../shared/app-metadata";
import { useDesktopApi } from "../../lib/desktop-api";
import { ThreadMarkdown } from "../thread-detail/ThreadMarkdown";

export function ChangelogWindow() {
  const desktopApi = useDesktopApi();
  const [changelog, setChangelog] = useState<AppChangelogDocument | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    document.title = "Changelog";
  }, []);

  useEffect(() => {
    let cancelled = false;
    const reader = desktopApi?.readChangelogDocument;
    if (!reader) {
      return;
    }

    reader()
      .then((value) => {
        if (!cancelled) {
          setChangelog(value);
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
      <section aria-label="PwrAgent changelog" className="activity-screen">
        <header className="activity-titlebar">
          <p className="activity-titlebar__brand">
            Pwr<span className="activity-titlebar__brand-accent">Agent</span>
          </p>
          <div className="activity-titlebar__breadcrumb">
            <span className="activity-titlebar__eyebrow">Help</span>
            <span aria-hidden="true" className="activity-titlebar__separator">
              ›
            </span>
            <span className="activity-titlebar__current">Changelog</span>
          </div>
          <div className="activity-titlebar__spacer" />
        </header>
        <main className="document-window__content">
          <article className="document-window__body">
            {error ? (
              <p className="document-window__error" role="alert">
                Could not load changelog: {error}
              </p>
            ) : changelog ? (
              <ThreadMarkdown
                className="document-window__markdown"
                text={changelog.content}
              />
            ) : (
              <p className="document-window__empty">Loading…</p>
            )}
          </article>
        </main>
      </section>
    </div>
  );
}
