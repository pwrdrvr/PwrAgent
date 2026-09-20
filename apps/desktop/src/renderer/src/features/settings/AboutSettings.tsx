import { useEffect, useState } from "react";
import { releaseNotesUrl } from "@pwragent/shared";
import type {
  AppLicenseDocument,
  AppLicenseDocumentKind,
  AppMetadata,
} from "../../../../shared/app-metadata";
import type { DesktopApi } from "../../lib/desktop-api";
import { ReleaseNotesLink } from "../update/ReleaseNotesLink";
import { SettingsCopyValue } from "./SettingsCopyValue";
import { formatProcessIds } from "./settings-fields";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";

export function AboutSettings(props: { desktopApi?: DesktopApi }) {
  const [metadata, setMetadata] = useState<AppMetadata | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [licenseDocument, setLicenseDocument] = useState<
    AppLicenseDocument | undefined
  >(undefined);
  const [licenseLoading, setLicenseLoading] = useState<
    AppLicenseDocumentKind | undefined
  >(undefined);
  const [licenseError, setLicenseError] = useState<string | undefined>(
    undefined,
  );

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

  const readLicenseDocument = props.desktopApi?.readLicenseDocument;
  const openChangelogWindow = props.desktopApi?.openChangelogWindow;
  const openThirdPartyNoticesWindow =
    props.desktopApi?.openThirdPartyNoticesWindow;
  const handleReadLicenseDocument = async (kind: AppLicenseDocumentKind) => {
    if (!readLicenseDocument) {
      return;
    }
    setLicenseLoading(kind);
    setLicenseError(undefined);
    try {
      setLicenseDocument(await readLicenseDocument(kind));
    } catch (err) {
      setLicenseError(err instanceof Error ? err.message : String(err));
    } finally {
      setLicenseLoading(undefined);
    }
  };

  if (error) {
    return (
      <SettingsSectionStack paneId="about" aria-label="About PwrAgent">
        <SettingsPanelHead
          eyebrow="About"
          title="PwrAgent"
          help="Thread-centric coding agent. Built by PwrDrvr LLC."
        />
        <div className="settings-panel" role="alert">
          <p className="settings-row__error">Could not load app info: {error}</p>
        </div>
      </SettingsSectionStack>
    );
  }

  if (!metadata) {
    return (
      <SettingsSectionStack paneId="about" aria-label="About PwrAgent">
        <SettingsPanelHead
          eyebrow="About"
          title="PwrAgent"
          help="Thread-centric coding agent. Built by PwrDrvr LLC."
        />
        <div className="settings-panel">
          <p className="settings-empty">Loading…</p>
        </div>
      </SettingsSectionStack>
    );
  }

  return (
    <SettingsSectionStack paneId="about" aria-label="About PwrAgent">
      <SettingsPanelHead
        eyebrow="About"
        title={metadata.applicationName}
        help="Thread-centric coding agent. Built by PwrDrvr LLC."
      />

      <SettingsSection eyebrow="About" title="Build">
        <dl className="settings-aboutkv">
          <div>
            <dt>Version</dt>
            <dd>
              {metadata.applicationVersion}
              {/* "this build", because a check result further down the page
                  can name the same version and the two must not share one
                  accessible name. */}
              <ReleaseNotesLink
                ariaLabel={`Release notes for this build, v${metadata.applicationVersion}`}
                className="settings-aboutkv__notes"
                url={releaseNotesUrl(metadata.applicationVersion)}
              />
            </dd>
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
            <dt>Documentation</dt>
            <dd>
              <a
                href={metadata.documentationUrl}
                target="_blank"
                rel="noreferrer"
              >
                {metadata.documentationUrl}
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
          <div>
            <dt>Process IDs</dt>
            <dd>
              <SettingsCopyValue
                desktopApi={props.desktopApi}
                label="process IDs"
                value={formatProcessIds(metadata)}
              />
            </dd>
          </div>
        </dl>
      </SettingsSection>

      <SettingsSection eyebrow="Release Notes" title="Changelog">
        <div className="settings-license-actions">
          <p className="settings-panel__hint">
            The changelog ships inside this build, so it stops at v
            {metadata.applicationVersion}. The published release page carries
            the same notes and is the only one that can describe a newer
            build.
          </p>
          <div className="settings-button-row">
            <button
              className="button button--secondary"
              type="button"
              disabled={!openChangelogWindow}
              onClick={() => {
                void openChangelogWindow?.();
              }}
            >
              Open changelog
            </button>
            {/* The one place this control wears a button skin: it stands
                beside a real button doing the neighboring job, and the
                quiet register the other surfaces use would read as a
                caption on it. */}
            <ReleaseNotesLink
              className="button button--secondary settings-about__notes-button"
              label="Open release notes"
              url={releaseNotesUrl(metadata.applicationVersion)}
            />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection eyebrow="License" title="Attribution">
        <div className="settings-license-actions">
          <p className="settings-panel__hint">
            PwrAgent is licensed under MIT.
          </p>
          <div className="settings-button-row">
            <button
              className="button button--secondary"
              type="button"
              disabled={!readLicenseDocument || licenseLoading === "license"}
              onClick={() => {
                void handleReadLicenseDocument("license");
              }}
            >
              {licenseLoading === "license" ? "Loading…" : "View MIT license"}
            </button>
            <button
              className="button button--secondary"
              type="button"
              disabled={!openThirdPartyNoticesWindow}
              onClick={() => {
                void openThirdPartyNoticesWindow?.();
              }}
            >
              Third-party notices
            </button>
          </div>
          {licenseError ? (
            <p className="settings-row__error">
              Could not load license document: {licenseError}
            </p>
          ) : null}
          {licenseDocument ? (
            <article
              className="settings-license-viewer"
              aria-label={licenseDocument.title}
            >
              <header className="settings-license-viewer__header">
                <h3>{licenseDocument.title}</h3>
              </header>
              <pre>{licenseDocument.content}</pre>
            </article>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsSectionStack>
  );
}

