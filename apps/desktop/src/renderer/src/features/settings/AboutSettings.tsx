import { useEffect, useState } from "react";
import type {
  AppLicenseDocument,
  AppLicenseDocumentKind,
  AppMetadata,
  AppUpdateCheckResult,
} from "../../../../shared/app-metadata";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";

export function AboutSettings(props: { desktopApi?: DesktopApi }) {
  const [metadata, setMetadata] = useState<AppMetadata | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<
    AppUpdateCheckResult | undefined
  >(undefined);
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

  const checkForUpdates = props.desktopApi?.checkForAppUpdates;
  const handleCheckForUpdates = async () => {
    if (!checkForUpdates) {
      return;
    }
    setUpdateChecking(true);
    setUpdateResult(undefined);
    try {
      const result = await checkForUpdates();
      setUpdateResult(result);
    } catch (err) {
      setUpdateResult({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUpdateChecking(false);
    }
  };

  const readLicenseDocument = props.desktopApi?.readLicenseDocument;
  const openChangelogWindow = props.desktopApi?.openChangelogWindow;
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
        action={
          checkForUpdates ? (
            <button
              className="button button--secondary"
              type="button"
              disabled={updateChecking}
              onClick={() => {
                void handleCheckForUpdates();
              }}
            >
              {updateChecking ? "Checking…" : "Check for updates"}
            </button>
          ) : null
        }
      />

      <SettingsSection eyebrow="About" title="Build">
        <dl className="settings-aboutkv">
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
      </SettingsSection>

      <SettingsSection eyebrow="Release Notes" title="Changelog">
        <div className="settings-license-actions">
          <p className="settings-panel__hint">
            Review bundled release notes for this build.
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
              {licenseLoading === "license" ? "Loading…" : "View license"}
            </button>
            <button
              className="button button--secondary"
              type="button"
              disabled={
                !readLicenseDocument ||
                licenseLoading === "third-party-licenses"
              }
              onClick={() => {
                void handleReadLicenseDocument("third-party-licenses");
              }}
            >
              {licenseLoading === "third-party-licenses"
                ? "Loading…"
                : "Third-party licenses"}
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

      {updateResult ? <UpdateResultStatus result={updateResult} /> : null}
    </SettingsSectionStack>
  );
}

function UpdateResultStatus({ result }: { result: AppUpdateCheckResult }) {
  if (result.status === "skipped") {
    return <p className="settings-empty">{result.reason}</p>;
  }
  if (result.status === "error") {
    return <p className="settings-row__error">Update check failed: {result.message}</p>;
  }
  if (result.status === "checking") {
    return <p className="settings-empty">Checking for updates…</p>;
  }
  if (result.status === "no-update") {
    return <p className="settings-empty">You're up to date (v{result.version}).</p>;
  }
  return (
    <p className="settings-empty">
      Update available: v{result.version}. Restart to install.
    </p>
  );
}
