import { useEffect, useRef, useState } from "react";
import type {
  BackendModelOption,
  BackendSummary,
  DesktopCodexAuthProfileCandidate,
  DesktopCodexDiscoveryCandidate,
  DesktopProviderModelDefaults,
  DesktopProviderThreadModelMigration,
  DesktopSettingsSecretName,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../lib/useBackendSummaries";
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
import { sourceBadge } from "./settings-fields";
import {
  CodexAuthProfileCreateButton,
  CodexAuthProfileLoginButton,
} from "./CodexAuthProfileSelect";
import { AcpAgentsSettings } from "./AcpAgentsSettings";
import { SettingsSwitch } from "./SettingsSwitch";

const UNSPECIFIED_SOURCE_MODEL_KEY = "\0unspecified";

type ThreadMigrationSourceGroup = {
  acknowledgedCurrentRevisionCount: number;
  count: number;
  key: string;
  label: string;
  model?: string;
};

type PendingThreadMigration = {
  backend: BackendSummary;
  justScheduled?: boolean;
  model: string;
  reasoningEffort?: string;
  selectedSourceKeys: string[];
  sourceGroups: ThreadMigrationSourceGroup[];
};

function migrationMatchesSelection(
  migration: DesktopProviderThreadModelMigration | undefined,
  pending: PendingThreadMigration,
): boolean {
  if (
    !migration
    || migration.model !== pending.model
    || migration.reasoningEffort !== pending.reasoningEffort
    || migration.sourceModels === undefined
  ) {
    return false;
  }
  const selectedKeys = new Set(pending.selectedSourceKeys);
  const selectedModels = pending.sourceGroups
    .filter((group) => group.model && selectedKeys.has(group.key))
    .map((group) => group.model as string)
    .sort();
  const migrationModels = [...migration.sourceModels].sort();
  return (
    selectedModels.length === migrationModels.length
    && selectedModels.every((model, index) => model === migrationModels[index])
    && selectedKeys.has(UNSPECIFIED_SOURCE_MODEL_KEY)
      === (migration.includeThreadsWithoutModel === true)
  );
}

export function ModelsSettings(props: {
  cachedBackends?: BackendSummary[];
  desktopApi?: DesktopApi;
  saving: boolean;
  snapshot: DesktopSettingsSnapshot;
  onClearSecret: (secret: DesktopSettingsSecretName) => Promise<boolean>;
  onReplaceSecret: (
    secret: DesktopSettingsSecretName,
    value: string,
  ) => Promise<boolean>;
  onRefresh: () => Promise<void>;
  onSaveCodexPath: (path: string) => Promise<void>;
  onSaveCodexProfile: (profile: string) => Promise<void>;
  onSaveProviderDefaults: (
    defaults: Record<string, DesktopProviderModelDefaults>,
  ) => Promise<void>;
  onSaveProviderThreadMigrations: (
    migrations: Record<string, DesktopProviderThreadModelMigration>,
  ) => Promise<boolean>;
  onSaveCodexFastAllowed: (allowed: boolean) => Promise<boolean>;
  /** Persist a per-ACP-agent CLI-path override (also pins a discovered install). */
  onAcpCliPathChange: (registryId: string, cliPath: string) => Promise<boolean>;
  /** Persist a per-ACP-agent enabled flag (off = hidden from the model picker). */
  onAcpEnabledChange: (registryId: string, enabled: boolean) => Promise<void>;
  /** Persist the Grok managed-build preference. */
  onManagedGrokBuildsChange?: (enabled: boolean) => Promise<boolean>;
}) {
  const [codexPath, setCodexPath] = useState(props.snapshot.models.codex.path.value);
  const [backends, setBackends] = useState<BackendSummary[]>(
    props.cachedBackends ?? [],
  );
  const [catalogError, setCatalogError] = useState<string | undefined>();
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const codex = props.snapshot.models.codex;
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
  const codexProfileSource =
    codex.profile.source === "default" ? "default" : sourceBadge(codex.profile);

  useEffect(() => {
    setCodexPath(codex.path.value);
  }, [codex.path.value, envForced]);

  useEffect(() => {
    if (props.cachedBackends) {
      setBackends(props.cachedBackends);
    }
  }, [props.cachedBackends]);

  const refreshCatalog = async (
    force = false,
    refreshModels = false,
  ): Promise<void> => {
    if (!props.desktopApi?.listBackends) {
      setCatalogError("Provider model discovery is unavailable in this build.");
      return;
    }
    setRefreshingCatalog(true);
    try {
      if (force && props.desktopApi.listAcpAgents) {
        await props.desktopApi.listAcpAgents({
          refresh: true,
          force: true,
        });
      }
      const response = await props.desktopApi.listBackends({
        includeUnavailable: true,
        ...(force || refreshModels ? { refreshModels: true } : {}),
      });
      setBackends(response.backends);
      setCatalogError(undefined);
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshingCatalog(false);
    }
  };

  useEffect(() => {
    void refreshCatalog(false, true);
    // The settings surface is itself a catalog refresh boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.desktopApi]);

  useEffect(() => {
    const refresh = (): void => {
      void refreshCatalog(false);
    };
    window.addEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, refresh);
    return () => {
      window.removeEventListener(BACKEND_SUMMARIES_REFRESH_EVENT, refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.desktopApi]);

  const saveCodexPath = (path: string): void => {
    void props.onSaveCodexPath(path.trim());
  };

  return (
    <SettingsSectionStack paneId="models" aria-label="Model settings">
      <SettingsPanelHead
        eyebrow="Models"
        title="AI providers"
        help="Choose profile-wide model baselines, inspect discovered models, and configure provider credentials."
      />

      <ProviderModelDefaultsSettings
        backends={backends}
        desktopApi={props.desktopApi}
        defaults={props.snapshot.models.providerDefaults ?? {}}
        migrations={props.snapshot.models.providerThreadMigrations ?? {}}
        codexFastAllowed={props.snapshot.models.codex.allowFast?.value ?? true}
        error={catalogError}
        refreshing={refreshingCatalog}
        saving={props.saving}
        onRefresh={() => refreshCatalog(true, true)}
        onSave={props.onSaveProviderDefaults}
        onSaveMigrations={props.onSaveProviderThreadMigrations}
        onSaveCodexFastAllowed={props.onSaveCodexFastAllowed}
      />

      <SettingsSection eyebrow="Models" title="Codex">
        <div className="settings-fields">
          <SettingsField
            label="Codex path"
            sub="Enter an absolute path, including .ps1 on Windows. Leave blank to use auto discovery."
            source={codexSource}
            control={
              <>
                <input
                  aria-label="Codex path"
                  className="settings-input"
                  disabled={props.saving || envForced}
                  placeholder="Auto discovery"
                  value={codexPath}
                  onChange={(event) => setCodexPath(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      saveCodexPath(codexPath);
                    }
                  }}
                />
                <div className="settings-inline-actions">
                  <button
                    className="button button--primary"
                    disabled={
                      props.saving
                      || envForced
                      || codexPath.trim() === codex.path.value.trim()
                    }
                    type="button"
                    onClick={() => saveCodexPath(codexPath)}
                  >
                    Save path
                  </button>
                  <button
                    className="button button--secondary"
                    disabled={
                      props.saving || envForced || !codex.path.value.trim()
                    }
                    type="button"
                    onClick={() => {
                      setCodexPath("");
                      saveCodexPath("");
                    }}
                  >
                    Use auto discovery
                  </button>
                </div>
              </>
            }
            help={
              envForced
                ? "PWRAGENT_CODEX_COMMAND controls this path for the current process."
                : undefined
            }
          />

          <SettingsField
            label="Available paths"
            sub="Detected on this machine. The newest supported version is used automatically."
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
            label="Auth profile"
            sub="Select the Codex home used for auth, config, sessions, skills, and state on the next app launch."
            source={codexProfileSource}
            error={codex.profiles.error}
            control={
              <div
                className="settings-paths"
                aria-label="Codex auth profiles"
              >
                <div className="settings-inline-actions">
                  <CodexAuthProfileCreateButton
                    desktopApi={props.desktopApi}
                    disabled={props.saving}
                    existingProfiles={codex.profiles.profiles}
                    onCreated={props.onSaveCodexProfile}
                  />
                </div>
                {codex.profiles.profiles.map((profile) => (
                  <CodexProfileRow
                    key={profile.name || "default"}
                    profile={profile}
                    desktopApi={props.desktopApi}
                    disabled={props.saving}
                    onAuthenticated={props.onRefresh}
                    onUse={(profileName) => {
                      void props.onSaveCodexProfile(profileName);
                    }}
                  />
                ))}
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

      <AcpAgentsSettings
        catalogRefreshing={refreshingCatalog}
        desktopApi={props.desktopApi}
        saving={props.saving}
        snapshot={props.snapshot}
        onCliPathChange={props.onAcpCliPathChange}
        onEnabledChange={props.onAcpEnabledChange}
        onManagedGrokBuildsChange={props.onManagedGrokBuildsChange}
      />
    </SettingsSectionStack>
  );
}

function ProviderModelDefaultsSettings(props: {
  backends: BackendSummary[];
  desktopApi?: DesktopApi;
  defaults: Record<string, DesktopProviderModelDefaults>;
  migrations: Record<string, DesktopProviderThreadModelMigration>;
  codexFastAllowed: boolean;
  error?: string;
  refreshing: boolean;
  saving: boolean;
  onRefresh: () => Promise<void>;
  onSave: (
    defaults: Record<string, DesktopProviderModelDefaults>,
  ) => Promise<void>;
  onSaveMigrations: (
    migrations: Record<string, DesktopProviderThreadModelMigration>,
  ) => Promise<boolean>;
  onSaveCodexFastAllowed: (allowed: boolean) => Promise<boolean>;
}) {
  const [pendingApply, setPendingApply] = useState<{
    backend: BackendSummary;
    count: number;
    directoryKeys: string[];
    model: string;
    reasoningEffort?: string;
  }>();
  const [pendingMigration, setPendingMigration] =
    useState<PendingThreadMigration>();
  const [pendingFastAction, setPendingFastAction] = useState<{
    kind: "disable" | "turn-off";
    threadCount: number;
  }>();
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState<string | undefined>();
  const providers = props.backends.filter(
    (backend) => (backend.launchpadOptions?.models?.length ?? 0) > 0,
  );

  const saveProvider = (
    backend: BackendSummary,
    next: DesktopProviderModelDefaults | undefined,
  ): void => {
    const updated = { ...props.defaults };
    if (next) {
      updated[backend.kind] = next;
    } else {
      delete updated[backend.kind];
    }
    void props.onSave(updated);
  };

  const previewApply = async (
    backend: BackendSummary,
    model: string,
    reasoningEffort?: string,
  ): Promise<void> => {
    if (!props.desktopApi?.getNavigationSnapshot) {
      setStatus("Launchpad updates are unavailable in this build.");
      return;
    }
    const navigation = await props.desktopApi.getNavigationSnapshot();
    const directoryKeys = navigation.directories
      .filter((directory) => directory.launchpad?.backend === backend.kind)
      .map((directory) => directory.key);
    if (directoryKeys.length === 0) {
      setStatus(`No ${backend.label} launchpads need updating.`);
      return;
    }
    setStatus(undefined);
    setPendingMigration(undefined);
    setPendingFastAction(undefined);
    setPendingApply({
      backend,
      count: directoryKeys.length,
      directoryKeys,
      model,
      reasoningEffort,
    });
  };

  const applyToLaunchpads = async (): Promise<void> => {
    if (!pendingApply || !props.desktopApi?.updateDirectoryLaunchpad) return;
    setApplying(true);
    try {
      for (const directoryKey of pendingApply.directoryKeys) {
        await props.desktopApi.updateDirectoryLaunchpad({
          directoryKey,
          patch: {
            model: pendingApply.model,
            reasoningEffort: pendingApply.reasoningEffort,
          },
          stickySettingsChanged: true,
        });
      }
      setStatus(
        `Updated ${pendingApply.count} ${pendingApply.backend.label} launchpad${
          pendingApply.count === 1 ? "" : "s"
        }. Existing threads were not changed.`,
      );
      setPendingApply(undefined);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  };

  const previewThreadMigration = async (
    backend: BackendSummary,
    model: string,
    reasoningEffort?: string,
  ): Promise<void> => {
    if (!props.desktopApi?.getNavigationSnapshot) {
      setStatus("Thread migration is unavailable in this build.");
      return;
    }
    const navigation = await props.desktopApi.getNavigationSnapshot();
    const threads = navigation.threads.filter(
      (thread) => thread.source === backend.kind,
    );
    if (threads.length === 0) {
      setStatus(`No existing ${backend.label} threads need a migration.`);
      return;
    }
    const modelLabels = new Map(
      (backend.launchpadOptions?.models ?? []).map((option) => [
        option.id,
        option.label ?? option.id,
      ]),
    );
    const currentMigration = props.migrations[backend.kind];
    const sourceCounts = new Map<string, {
      acknowledgedCurrentRevisionCount: number;
      count: number;
    }>();
    for (const thread of threads) {
      const key = thread.model?.trim() || UNSPECIFIED_SOURCE_MODEL_KEY;
      const current = sourceCounts.get(key) ?? {
        acknowledgedCurrentRevisionCount: 0,
        count: 0,
      };
      sourceCounts.set(key, {
        acknowledgedCurrentRevisionCount:
          current.acknowledgedCurrentRevisionCount
          + (
            thread.modelMigrationRevision === currentMigration?.revision
              ? 1
              : 0
          ),
        count: current.count + 1,
      });
    }
    const sourceGroups = [...sourceCounts.entries()]
      .map(([key, counts]): ThreadMigrationSourceGroup => {
        if (key === UNSPECIFIED_SOURCE_MODEL_KEY) {
          return {
            ...counts,
            key,
            label: "Provider default / unknown",
          };
        }
        return {
          ...counts,
          key,
          label: modelLabels.get(key) ?? key,
          model: key,
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label));
    const currentMigrationTargetsSelection =
      currentMigration?.model === model
      && currentMigration.reasoningEffort === reasoningEffort
      && currentMigration.sourceModels !== undefined;
    const currentSourceModels = new Set(currentMigration?.sourceModels ?? []);
    setStatus(undefined);
    setPendingApply(undefined);
    setPendingFastAction(undefined);
    setPendingMigration({
      backend,
      model,
      reasoningEffort,
      selectedSourceKeys: currentMigrationTargetsSelection
        ? sourceGroups
            .filter((group) =>
              group.model
                ? currentSourceModels.has(group.model)
                : currentMigration?.includeThreadsWithoutModel === true
            )
            .map((group) => group.key)
        : sourceGroups
            .filter((group) => group.model !== model)
            .map((group) => group.key),
      sourceGroups,
    });
  };

  const createThreadMigration = async (): Promise<void> => {
    if (!pendingMigration) return;
    const selectedSourceKeys = new Set(pendingMigration.selectedSourceKeys);
    const selectedGroups = pendingMigration.sourceGroups.filter(
      (group) => selectedSourceKeys.has(group.key),
    );
    const threadCount = selectedGroups.reduce(
      (count, group) => count + group.count,
      0,
    );
    if (threadCount === 0) return;
    if (
      migrationMatchesSelection(
        props.migrations[pendingMigration.backend.kind],
        pendingMigration,
      )
    ) {
      setStatus(
        `This ${pendingMigration.backend.label} migration is already scheduled. `
        + "Pending threads will adopt it when next opened.",
      );
      setPendingMigration(undefined);
      return;
    }
    setApplying(true);
    try {
      const createdAt = Date.now();
      const saved = await props.onSaveMigrations({
        ...props.migrations,
        [pendingMigration.backend.kind]: {
          revision: `${createdAt}-${crypto.randomUUID()}`,
          model: pendingMigration.model,
          ...(pendingMigration.reasoningEffort
            ? { reasoningEffort: pendingMigration.reasoningEffort }
            : {}),
          sourceModels: selectedGroups.flatMap((group) =>
            group.model ? [group.model] : [],
          ),
          ...(selectedSourceKeys.has(UNSPECIFIED_SOURCE_MODEL_KEY)
            ? { includeThreadsWithoutModel: true }
            : {}),
          createdAt,
        },
      });
      if (!saved) {
        setStatus("Could not save the thread migration.");
        return;
      }
      setStatus(
        `Scheduled ${threadCount} ${pendingMigration.backend.label} thread${
          threadCount === 1 ? "" : "s"
        } to adopt ${pendingMigration.model} when next opened.`,
      );
      setPendingMigration((current) =>
        current
          ? {
              ...current,
              justScheduled: true,
              sourceGroups: current.sourceGroups.map((group) => ({
                ...group,
                acknowledgedCurrentRevisionCount: 0,
              })),
            }
          : current,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  };

  const previewFastAction = async (
    kind: "disable" | "turn-off",
  ): Promise<void> => {
    if (!props.desktopApi?.getNavigationSnapshot) {
      setStatus("Codex Fast cleanup is unavailable in this build.");
      return;
    }
    const navigation = await props.desktopApi.getNavigationSnapshot();
    setStatus(undefined);
    setPendingApply(undefined);
    setPendingMigration(undefined);
    setPendingFastAction({
      kind,
      threadCount: navigation.threads.filter(
        (thread) => thread.source === "codex" && thread.fastMode === true,
      ).length,
    });
  };

  const applyFastAction = async (): Promise<void> => {
    if (!pendingFastAction || !props.desktopApi?.turnOffCodexFastEverywhere) {
      return;
    }
    setApplying(true);
    try {
      if (pendingFastAction.kind === "disable") {
        const saved = await props.onSaveCodexFastAllowed(false);
        if (!saved) {
          setStatus("Could not save the Codex Fast policy.");
          return;
        }
      }
      const result = await props.desktopApi.turnOffCodexFastEverywhere();
      setStatus(
        `Fast is off for ${result.threadCount} Codex thread${
          result.threadCount === 1 ? "" : "s"
        } and ${result.launchpadCount} saved launchpad${
          result.launchpadCount === 1 ? "" : "s"
        }. Future Codex launchpads will also start non-Fast.`,
      );
      setPendingFastAction(undefined);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  };

  return (
    <SettingsSection
      eyebrow="Defaults"
      title="New thread defaults"
      description="These profile-wide baselines fill new launchpads that do not already have a directory or learned provider choice."
    >
      <div className="settings-fields">
        {providers.map((backend) => {
          const providerPendingApply =
            pendingApply?.backend.kind === backend.kind
              ? pendingApply
              : undefined;
          const providerPendingMigration =
            pendingMigration?.backend.kind === backend.kind
              ? pendingMigration
              : undefined;
          const fastMode =
            backend.kind === "codex"
              ? {
                  allowed: props.codexFastAllowed,
                  pending: pendingFastAction,
                  onAllowChange: (allowed: boolean) => {
                    if (allowed) {
                      void props.onSaveCodexFastAllowed(true).then((saved) => {
                        if (!saved) {
                          setStatus("Could not save the Codex Fast policy.");
                        }
                      });
                    } else {
                      void previewFastAction("disable");
                    }
                  },
                  onCancel: () => setPendingFastAction(undefined),
                  onConfirm: () => void applyFastAction(),
                  onTurnOffEverywhere: () => void previewFastAction("turn-off"),
                }
              : undefined;
          return (
            <ProviderModelDefaultField
              key={backend.kind}
              backend={backend}
              defaults={props.defaults[backend.kind]}
              disabled={
                props.saving
                || applying
                || Boolean(providerPendingApply)
                || Boolean(providerPendingMigration)
              }
              applying={applying}
              fastMode={fastMode}
              pendingApply={providerPendingApply}
              onApply={(model, reasoningEffort) => {
                void previewApply(backend, model, reasoningEffort);
              }}
              onCancelApply={() => setPendingApply(undefined)}
              onConfirmApply={() => void applyToLaunchpads()}
              onMigrate={(model, reasoningEffort) => {
                void previewThreadMigration(backend, model, reasoningEffort);
              }}
              onChange={(next) => saveProvider(backend, next)}
            />
          );
        })}
        {providers.length === 0 ? (
          <SettingsField
            label="Discovered models"
            sub={props.error ?? "No provider has reported a model catalog yet."}
            control={
              <button
                className="button button--secondary"
                disabled={props.refreshing || props.saving}
                type="button"
                onClick={() => void props.onRefresh()}
              >
                {props.refreshing ? "Refreshing…" : "Refresh models"}
              </button>
            }
          />
        ) : (
          <SettingsField
            label="Model catalog"
            sub={
              props.error
                ? `Last refresh failed: ${props.error}`
                : "Refresh after installing or upgrading a provider CLI."
            }
            control={
              <button
                className="button button--secondary"
                disabled={props.refreshing || props.saving}
                type="button"
                onClick={() => void props.onRefresh()}
              >
                {props.refreshing ? "Refreshing…" : "Refresh models"}
              </button>
            }
          />
        )}
        {status ? <p className="settings-empty">{status}</p> : null}
      </div>
      {pendingMigration ? (
        <ThreadMigrationDialog
          applying={applying}
          currentMigration={props.migrations[pendingMigration.backend.kind]}
          migration={pendingMigration}
          onCancel={() => setPendingMigration(undefined)}
          onConfirm={() => void createThreadMigration()}
          onSelectionChange={(selectedSourceKeys) => {
            setPendingMigration((current) =>
              current
                ? { ...current, justScheduled: false, selectedSourceKeys }
                : current,
            );
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

function ThreadMigrationDialog(props: {
  applying: boolean;
  currentMigration?: DesktopProviderThreadModelMigration;
  migration: PendingThreadMigration;
  onCancel: () => void;
  onConfirm: () => void;
  onSelectionChange: (selectedSourceKeys: string[]) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const selectionAnchorRef = useRef<number | undefined>(undefined);
  const applying = props.applying;
  const onCancel = props.onCancel;
  const selectedSourceKeys = new Set(props.migration.selectedSourceKeys);
  const selectedThreadCount = props.migration.sourceGroups.reduce(
    (count, group) =>
      count + (selectedSourceKeys.has(group.key) ? group.count : 0),
    0,
  );
  const alreadyScheduled =
    props.migration.justScheduled === true
    || migrationMatchesSelection(props.currentMigration, props.migration);
  const selectedAcknowledgedThreadCount =
    props.migration.sourceGroups.reduce(
      (count, group) =>
        count
        + (
          selectedSourceKeys.has(group.key)
            ? group.acknowledgedCurrentRevisionCount
            : 0
        ),
      0,
    );
  const acknowledgedThreadCount = props.migration.sourceGroups.reduce(
    (count, group) =>
      count + group.acknowledgedCurrentRevisionCount,
    0,
  );
  const pendingThreadCount =
    Math.max(0, selectedThreadCount - selectedAcknowledgedThreadCount);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !applying) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applying, onCancel]);

  const toggleSourceGroup = (index: number, shiftKey: boolean): void => {
    const group = props.migration.sourceGroups[index];
    if (!group) return;
    const next = new Set(selectedSourceKeys);
    const shouldSelect = !next.has(group.key);
    if (shiftKey && selectionAnchorRef.current !== undefined) {
      const start = Math.min(selectionAnchorRef.current, index);
      const end = Math.max(selectionAnchorRef.current, index);
      for (
        const rangeGroup of
        props.migration.sourceGroups.slice(start, end + 1)
      ) {
        if (shouldSelect) {
          next.add(rangeGroup.key);
        } else {
          next.delete(rangeGroup.key);
        }
      }
    } else if (shouldSelect) {
      next.add(group.key);
    } else {
      next.delete(group.key);
    }
    selectionAnchorRef.current = index;
    props.onSelectionChange([...next]);
  };

  return (
    <div className="settings-confirm-modal" role="presentation">
      <div
        ref={dialogRef}
        aria-describedby="thread-migration-description"
        aria-labelledby="thread-migration-heading"
        aria-modal="true"
        className="settings-confirm-dialog settings-thread-migration-dialog"
        role="dialog"
        tabIndex={-1}
      >
        <h2 id="thread-migration-heading">
          Choose {props.migration.backend.label} threads to update
        </h2>
        <p id="thread-migration-description">
          Select the models currently used by threads that should adopt{" "}
          <strong>{props.migration.model}</strong>
          {props.migration.reasoningEffort
            ? ` with ${props.migration.reasoningEffort} reasoning`
            : ""}
          . This schedules a one-time change when each selected thread is next
          opened. Newer threads and unselected models stay unchanged.
        </p>
        {alreadyScheduled ? (
          <p className="settings-thread-migration-dialog__scheduled">
            This exact migration is already scheduled. {pendingThreadCount} thread
            {pendingThreadCount === 1 ? " is" : "s are"} still pending;{" "}
            {acknowledgedThreadCount} already acknowledged this revision.
          </p>
        ) : null}
        <div className="settings-thread-migration-dialog__toolbar">
          <span>
            {alreadyScheduled
              ? `${pendingThreadCount} pending`
              : `${selectedThreadCount} selected`}{" "}
            of{" "}
            {props.migration.sourceGroups.reduce(
              (count, group) => count + group.count,
              0,
            )}{" "}
            threads
          </span>
          <div className="settings-inline-actions">
            <button
              className="button button--ghost"
              disabled={props.applying}
              type="button"
              onClick={() => props.onSelectionChange(
                props.migration.sourceGroups.map((group) => group.key),
              )}
            >
              Select all
            </button>
            <button
              className="button button--ghost"
              disabled={props.applying}
              type="button"
              onClick={() => props.onSelectionChange([])}
            >
              Clear
            </button>
          </div>
        </div>
        <div
          aria-label="Current thread models"
          aria-multiselectable="true"
          className="settings-thread-migration-dialog__list"
          role="listbox"
        >
          {props.migration.sourceGroups.map((group, index) => {
            const selected = selectedSourceKeys.has(group.key);
            return (
              <button
                key={group.key}
                aria-selected={selected}
                className="settings-thread-migration-dialog__option"
                disabled={props.applying}
                role="option"
                type="button"
                onClick={(event) => toggleSourceGroup(index, event.shiftKey)}
              >
                <span
                  aria-hidden="true"
                  className="settings-thread-migration-dialog__check"
                >
                  {selected ? "✓" : ""}
                </span>
                <span className="settings-thread-migration-dialog__model">
                  {group.label}
                  {group.model === props.migration.model ? (
                    <small>destination model</small>
                  ) : null}
                </span>
                <span className="settings-thread-migration-dialog__count">
                  {group.count} thread{group.count === 1 ? "" : "s"}
                </span>
              </button>
            );
          })}
        </div>
        <p className="settings-thread-migration-dialog__hint">
          Click or ⌘-click to toggle a model. Shift-click selects a range.
        </p>
        <div className="settings-confirm-dialog__actions">
          {alreadyScheduled ? (
            <button
              className="button button--primary"
              type="button"
              onClick={props.onCancel}
            >
              Done
            </button>
          ) : (
            <>
              <button
                className="button button--secondary"
                disabled={props.applying}
                type="button"
                onClick={props.onCancel}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                disabled={props.applying || selectedThreadCount === 0}
                type="button"
                onClick={props.onConfirm}
              >
                {props.applying
                  ? "Creating migration…"
                  : `Schedule ${selectedThreadCount} thread${
                      selectedThreadCount === 1 ? "" : "s"
                    }`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderModelDefaultField(props: {
  backend: BackendSummary;
  defaults?: DesktopProviderModelDefaults;
  disabled: boolean;
  applying: boolean;
  fastMode?: {
    allowed: boolean;
    pending?: {
      kind: "disable" | "turn-off";
      threadCount: number;
    };
    onAllowChange: (allowed: boolean) => void;
    onCancel: () => void;
    onConfirm: () => void;
    onTurnOffEverywhere: () => void;
  };
  pendingApply?: {
    count: number;
  };
  onApply: (model: string, reasoningEffort?: string) => void;
  onCancelApply: () => void;
  onConfirmApply: () => void;
  onMigrate: (model: string, reasoningEffort?: string) => void;
  onChange: (defaults: DesktopProviderModelDefaults | undefined) => void;
}) {
  const models = props.backend.launchpadOptions?.models ?? [];
  const selectedModel = props.defaults?.model ?? "";
  const modelOption = models.find((model) => model.id === selectedModel);
  const reasoningOptions = reasoningOptionsFor(
    modelOption,
    props.backend.launchpadOptions?.reasoningEfforts,
  );
  const selectedReasoning = selectedModel
    ? props.defaults?.reasoningEffortsByModel[selectedModel] ?? ""
    : "";
  const selectionAvailable =
    Boolean(modelOption)
    && (
      !selectedReasoning
      || reasoningOptions.includes(selectedReasoning)
    );

  return (
    <SettingsField
      label={props.backend.label}
      sub={
        props.backend.available
          ? `${models.length} discovered model${models.length === 1 ? "" : "s"}`
          : props.backend.unavailableReason ?? "Provider unavailable"
      }
      control={
        <div className="settings-paths">
          <div className="settings-provider-defaults__selectors">
            <select
              aria-label={`${props.backend.label} default model`}
              className="settings-select settings-select--chip"
              disabled={props.disabled}
              value={selectedModel}
              onChange={(event) => {
                const model = event.currentTarget.value;
                if (!model) {
                  props.onChange(undefined);
                  return;
                }
                const option = models.find((candidate) => candidate.id === model);
                const reasoningEffortsByModel = {
                  ...(props.defaults?.reasoningEffortsByModel ?? {}),
                };
                if (
                  option?.defaultReasoningEffort
                  && !reasoningEffortsByModel[model]
                ) {
                  reasoningEffortsByModel[model] = option.defaultReasoningEffort;
                }
                props.onChange({ model, reasoningEffortsByModel });
              }}
            >
              <option value="">Provider advertised default</option>
              {selectedModel && !modelOption ? (
                <option value={selectedModel}>{selectedModel} (unavailable)</option>
              ) : null}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label ?? model.id}
                </option>
              ))}
            </select>
            {selectedModel && reasoningOptions.length > 0 ? (
              <select
                aria-label={`${props.backend.label} default reasoning`}
                className="settings-select settings-select--chip"
                disabled={props.disabled}
                value={selectedReasoning}
                onChange={(event) => {
                  const reasoningEffortsByModel = {
                    ...(props.defaults?.reasoningEffortsByModel ?? {}),
                  };
                  const effort = event.currentTarget.value;
                  if (effort) {
                    reasoningEffortsByModel[selectedModel] = effort;
                  } else {
                    delete reasoningEffortsByModel[selectedModel];
                  }
                  props.onChange({
                    model: selectedModel,
                    reasoningEffortsByModel,
                  });
                }}
              >
                <option value="">Provider advertised reasoning</option>
                {selectedReasoning
                && !reasoningOptions.includes(selectedReasoning) ? (
                  <option value={selectedReasoning}>
                    {selectedReasoning} (unavailable)
                  </option>
                ) : null}
                {reasoningOptions.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          {props.pendingApply ? (
            <InlineActionConfirmation
              applying={props.applying}
              confirmLabel="Apply"
              label={`Apply to ${props.pendingApply.count} launchpad${
                props.pendingApply.count === 1 ? "" : "s"
              }?`}
              sub="Prompts, attachments, work mode, access, Fast/service tier, and Codex Environment will stay unchanged."
              onCancel={props.onCancelApply}
              onConfirm={props.onConfirmApply}
            />
          ) : selectedModel ? (
            <div className="settings-inline-actions">
              <button
                className="button button--secondary"
                disabled={props.disabled || !selectionAvailable}
                type="button"
                onClick={() => props.onApply(
                  selectedModel,
                  selectedReasoning || undefined,
                )}
              >
                Apply to launchpads
              </button>
              <button
                className="button button--secondary"
                disabled={props.disabled || !selectionAvailable}
                type="button"
                onClick={() => props.onMigrate(
                  selectedModel,
                  selectedReasoning || undefined,
                )}
              >
                Schedule existing threads…
              </button>
              <button
                className="button button--ghost"
                disabled={props.disabled}
                type="button"
                onClick={() => props.onChange(undefined)}
              >
                Reset
              </button>
            </div>
          ) : null}
          {props.fastMode ? (
            <div className="settings-provider-defaults__fast">
              <div className="settings-provider-defaults__fast-copy">
                <strong>Fast mode</strong>
                <span>
                  {props.fastMode.allowed
                    ? "Allowed for this profile. Existing threads keep their own choice."
                    : "Prohibited for this profile. Codex is forced to non-Fast."}
                </span>
              </div>
              {props.fastMode.pending ? (
                <InlineActionConfirmation
                  applying={props.applying}
                  confirmLabel="Turn Fast off"
                  label={
                    props.fastMode.pending.kind === "disable"
                      ? "Prohibit Fast for this profile?"
                      : "Turn Fast off everywhere?"
                  }
                  sub={`This will set ${props.fastMode.pending.threadCount} existing Codex thread${
                    props.fastMode.pending.threadCount === 1 ? "" : "s"
                  } and future launchpads to non-Fast. Models, reasoning, prompts, and access settings stay unchanged.`}
                  onCancel={props.fastMode.onCancel}
                  onConfirm={props.fastMode.onConfirm}
                />
              ) : (
                <div className="settings-inline-actions">
                  <SettingsSwitch
                    checked={props.fastMode.allowed}
                    disabled={props.disabled}
                    label="Allow Codex Fast mode"
                    onChange={props.fastMode.onAllowChange}
                  />
                  <button
                    aria-label="Turn Fast off everywhere"
                    className="button button--secondary"
                    disabled={props.disabled || !props.fastMode.allowed}
                    type="button"
                    onClick={props.fastMode.onTurnOffEverywhere}
                  >
                    Turn off everywhere
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      }
    />
  );
}

function InlineActionConfirmation(props: {
  applying: boolean;
  confirmLabel: string;
  label: string;
  sub: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      aria-live="polite"
      className="settings-action-confirmation"
    >
      <div className="settings-action-confirmation__copy">
        <strong>{props.label}</strong>
        <span>{props.sub}</span>
      </div>
      <div className="settings-inline-actions">
        <button
          className="button button--primary"
          disabled={props.applying}
          type="button"
          onClick={props.onConfirm}
        >
          {props.applying ? "Updating…" : props.confirmLabel}
        </button>
        <button
          className="button button--ghost"
          disabled={props.applying}
          type="button"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function reasoningOptionsFor(
  model: BackendModelOption | undefined,
  fallback: string[] | undefined,
): string[] {
  if (model?.supportsReasoning === false) return [];
  return model?.reasoningEfforts ?? fallback ?? [];
}

function CodexProfileRow(props: {
  desktopApi?: DesktopApi;
  profile: DesktopCodexAuthProfileCandidate;
  disabled?: boolean;
  onAuthenticated: () => Promise<void>;
  onUse: (profile: string) => void;
}) {
  const profile = props.profile;
  const chips: SettingsPathRowChip[] = [
    { label: profile.source === "default" ? "default" : "profile", tone: "muted" },
    {
      label: profile.hasAuthFile ? "auth" : "no auth",
      tone: profile.hasAuthFile || !profile.name ? "muted" : "err",
    },
  ];

  if (profile.hasConfigFile) {
    chips.push({ label: "config", tone: "muted" });
  }
  if (!profile.exists) {
    chips.push({ label: "missing", tone: "err" });
  }

  return (
    <SettingsPathRow
      title={
        <span className="settings-pathrow__title-line">
          <span>{profile.displayName}</span>
          {profile.accountEmail ? (
            <span className="settings-pathrow__meta">{profile.accountEmail}</span>
          ) : null}
        </span>
      }
      path={profile.codexHome}
      chips={chips}
      selected={profile.selected}
      selectedLabel="Next launch"
      disabled={props.disabled || !profile.exists}
      extraAction={
        profile.name && profile.exists && !profile.hasAuthFile ? (
          <CodexAuthProfileLoginButton
            desktopApi={props.desktopApi}
            disabled={props.disabled}
            displayName={profile.displayName}
            profile={profile.name}
            onAuthenticated={props.onAuthenticated}
          />
        ) : undefined
      }
      onUse={() => props.onUse(profile.name)}
    />
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
  if (reason === "codex_too_old") return "Codex too old";
  return reason;
}
