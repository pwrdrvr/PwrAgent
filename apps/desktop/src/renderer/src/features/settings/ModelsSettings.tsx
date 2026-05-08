import { useEffect, useState } from "react";
import type {
  DesktopCodexDiscoveryCandidate,
  DesktopSettingsSecretName,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  SettingsField,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
} from "./SettingsLayout";
import {
  SettingsPathRow,
  type SettingsPathRowChip,
} from "./SettingsPathRow";
import { SettingsTestBlock } from "./SettingsTestBlock";
import { formatSourceLabel, sourceBadge } from "./settings-fields";

type CodexPathMode = "auto" | "specified";

export function ModelsSettings(props: {
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onClearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
  onReplaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
  onSaveCodexPath: (path: string) => Promise<void>;
}) {
  const [codexPath, setCodexPath] = useState(props.snapshot.models.codex.path.value);
  const [codexMode, setCodexMode] = useState<CodexPathMode>(
    props.snapshot.models.codex.path.value.trim() ? "specified" : "auto",
  );
  const [grokKey, setGrokKey] = useState("");
  const codex = props.snapshot.models.codex;
  const grok = props.snapshot.models.grok.apiKey;
  const envForced = codex.path.source === "env";
  const autoCandidates = codex.discovery.candidates.filter(
    (candidate) => candidate.source === "path" || candidate.source === "application",
  );
  // Per-field source pill text — shows where the effective value
  // comes from (config / env override / default). Used on both the
  // "Codex selection" and "Available paths" rows so the metadata is
  // visible exactly where it applies. The card header used to carry
  // a duplicate of this same chip; that's gone now.
  const codexSource =
    codex.path.source === "default" ? "auto" : sourceBadge(codex.path);
  const grokConfigured = grok.configured;
  const grokSource = formatSourceLabel(grok.source, grok.overriddenByEnv);

  useEffect(() => {
    setCodexPath(codex.path.value);
    setCodexMode(codex.path.value.trim() || envForced ? "specified" : "auto");
  }, [codex.path.value, envForced]);

  const saveCodexPath = (path: string): void => {
    void props.onSaveCodexPath(path.trim());
  };

  return (
    <SettingsSectionStack paneId="models" aria-label="Model settings">
      <SettingsPanelHead
        eyebrow="Models"
        title="Backends & credentials"
        help="PwrAgent drives Codex and Grok. Use Auto Discovery to track the newest binary on disk, or pin a specific path."
      />

      <SettingsSection eyebrow="Models" title="Codex">
        <div className="settings-fields">
          <SettingsField
            label="Codex selection"
            sub="Pick the Codex binary to invoke for new threads."
            source={codexSource}
            control={
              <div
                className="settings-segmented"
                role="radiogroup"
                aria-label="Codex selection mode"
              >
                <button
                  aria-checked={codexMode === "auto" && !envForced}
                  className={`settings-segmented__button${
                    codexMode === "auto" && !envForced ? " is-active" : ""
                  }`}
                  disabled={props.saving || envForced}
                  role="radio"
                  type="button"
                  onClick={() => {
                    setCodexMode("auto");
                    setCodexPath("");
                    saveCodexPath("");
                  }}
                >
                  Auto Discovery - Use Newest
                </button>
                <button
                  aria-checked={codexMode === "specified" || envForced}
                  className={`settings-segmented__button${
                    codexMode === "specified" || envForced ? " is-active" : ""
                  }`}
                  disabled={props.saving || envForced}
                  role="radio"
                  type="button"
                  onClick={() => setCodexMode("specified")}
                >
                  Specified Path
                </button>
              </div>
            }
          />

          {codexMode === "specified" || envForced ? (
            <SettingsField
              label="Codex path"
              sub="Absolute path to the Codex binary to invoke."
              control={
                <input
                  aria-label="Codex path"
                  className="settings-input"
                  disabled={props.saving || envForced}
                  placeholder="Path to codex"
                  value={codexPath}
                  onBlur={() => saveCodexPath(codexPath)}
                  onChange={(event) => setCodexPath(event.currentTarget.value)}
                />
              }
            />
          ) : null}

          <SettingsField
            label="Available paths"
            sub="Detected on this machine. The first listed will be used."
            source={codexSource}
            control={
              <div
                className="settings-paths"
                aria-label="Codex discovery"
              >
                {autoCandidates.length === 0 ? (
                  <p className="settings-empty">No Codex candidates found.</p>
                ) : (
                  autoCandidates.map((candidate) => (
                    <CodexCandidateRow
                      key={`${candidate.source}:${candidate.command}`}
                      candidate={candidate}
                      disabled={props.saving || envForced}
                      onUse={(command) => {
                        setCodexMode("specified");
                        setCodexPath(command);
                        saveCodexPath(command);
                      }}
                    />
                  ))
                )}
              </div>
            }
          />
          <SettingsField
            label="Connection test"
            sub="Spawns the selected Codex binary with --version and validates the version banner."
            control={
              <SettingsTestBlock
                kind="codex"
                desktopApi={props.desktopApi}
                icon={<span aria-hidden="true">C</span>}
                defaultName={
                  codex.discovery.selectedCommand ?? "codex --version"
                }
                defaultSub={
                  codex.discovery.selectedCommand
                    ? "spawn --version"
                    : "no executable Codex selected"
                }
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection eyebrow="Models" title="Grok">
        <div className="settings-fields">
          <SettingsField
            label="API Key"
            sub="x.ai API key. Stored in the system keychain."
            source={grokConfigured ? `Set · ${grokSource}` : `Not set · ${grokSource}`}
            error={grok.unavailableReason}
            control={
              <div className="settings-secret">
                <input
                  aria-label="Grok API Key"
                  className="settings-input"
                  disabled={props.saving || !grok.writable}
                  placeholder="••••••••"
                  type="password"
                  value={grokKey}
                  onChange={(event) => setGrokKey(event.currentTarget.value)}
                />
                <button
                  className="button button--secondary"
                  disabled={props.saving || !grok.writable || !grokKey.trim()}
                  type="button"
                  onClick={() => {
                    const nextValue = grokKey.trim();
                    void props.onReplaceSecret("grokApiKey", nextValue).then(
                      (saved) => {
                        if (saved) {
                          setGrokKey("");
                        }
                      },
                    );
                  }}
                >
                  Replace
                </button>
                <button
                  className="button button--ghost"
                  disabled={props.saving || !grok.writable || grok.source === "env"}
                  type="button"
                  onClick={() => {
                    void props.onClearSecret("grokApiKey");
                  }}
                >
                  Clear
                </button>
              </div>
            }
          />
          <SettingsField
            label="Connection test"
            sub="Calls GET /v1/models on the xAI API and reports the available models."
            control={
              <SettingsTestBlock
                kind="grok"
                desktopApi={props.desktopApi}
                icon={<span aria-hidden="true">x</span>}
                defaultName="api.x.ai/v1/models"
                defaultSub="GET /v1/models"
              />
            }
          />
        </div>
      </SettingsSection>
    </SettingsSectionStack>
  );
}

function CodexCandidateRow(props: {
  candidate: DesktopCodexDiscoveryCandidate;
  disabled?: boolean;
  onUse: (command: string) => void;
}) {
  const candidate = props.candidate;
  const unavailableLabel = describeCommandDiscoveryFailure(candidate.failureReason);
  const status = !candidate.executable
    ? (unavailableLabel ?? "Not executable")
    : candidate.selected
      ? "Using"
      : "Available";
  const version =
    candidate.version
    ?? describeCommandDiscoveryFailure(candidate.versionFailureReason)
    ?? unavailableLabel
    ?? "version unknown";

  const chips: SettingsPathRowChip[] = [
    { label: candidate.source, tone: "muted" },
    { label: version, tone: "muted" },
  ];
  if (!candidate.selected) {
    chips.push({
      label: status,
      tone: candidate.executable ? "muted" : "err",
    });
  }

  return (
    <SettingsPathRow
      title={candidate.command}
      chips={chips}
      selected={candidate.selected}
      selectedLabel="Using"
      disabled={props.disabled || !candidate.executable}
      onUse={() => props.onUse(candidate.command)}
    />
  );
}

function describeCommandDiscoveryFailure(reason?: string): string | undefined {
  if (!reason) return undefined;
  if (reason === "not_found") return "Missing";
  if (reason === "not_executable") return "Not executable";
  if (reason === "version_not_reported") return "Version unknown";
  return reason;
}
