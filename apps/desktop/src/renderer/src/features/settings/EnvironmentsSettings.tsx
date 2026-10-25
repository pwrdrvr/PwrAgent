import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  CODEX_ENVIRONMENT_ACTION_ICONS,
  CODEX_ENVIRONMENT_DEFAULT_ACTION_ICON,
  CODEX_ENVIRONMENT_PLATFORM_LABELS,
  CODEX_ENVIRONMENT_PLATFORMS,
  isBlankCodexEnvironmentAction,
  isValidCodexEnvironmentFileName,
  suggestCodexEnvironmentFileName,
  validateCodexEnvironmentDocument,
  type CodexEnvironmentActionDocument,
  type CodexEnvironmentDocument,
  type CodexEnvironmentFileSummary,
  type CodexEnvironmentPlatform,
  type CodexEnvironmentProblem,
  type CodexEnvironmentProject,
  type CodexEnvironmentScriptDocument,
  type DesktopSettingsValue,
} from "@pwragent/shared";
import {
  CheckIcon,
  MoreVerticalIcon,
  PencilIcon,
  PlayIcon,
  SettingsIcon,
  TerminalIcon,
  type IconProps,
} from "../../icons";
import { Select } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import { useMenuNavigation } from "../../lib/useMenuNavigation";
import {
  SegmentedControl,
  SettingsField,
  SettingsIndexRow,
  SettingsPanelHead,
  SettingsSection,
  SettingsSectionStack,
  ToggleField,
} from "./SettingsLayout";
import { sourceBadge } from "./settings-fields";
import { useUnsavedSettingsChanges } from "./UnsavedSettingsChanges";
import {
  decodeEnvironmentsRoute,
  encodeEnvironmentsRoute,
  environmentsPageKey,
} from "./environments-route";

export {
  decodeEnvironmentsRoute,
  encodeEnvironmentsRoute,
  environmentsPageKey,
  environmentsRouteLabel,
  type EnvironmentsRoute,
} from "./environments-route";

/**
 * Settings → Environments: the `.codex/environments/*.toml` files of a
 * project on this machine, and the profile switch that decides whether
 * agents get the shell variables an environment's setup captures.
 *
 * Main owns every file read and write (`codex-environment-editor.ts`); this
 * pane only holds an editing draft. A peer's projects are not listed: an
 * environment runs on the machine that owns the project, so it is edited
 * there.
 */

export const CODEX_ENVIRONMENT_DOCS_URL =
  "https://developers.openai.com/codex/app/local-environments";

function pathLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function platformLabels(platforms: readonly CodexEnvironmentPlatform[]): string[] {
  return platforms.map((platform) => CODEX_ENVIRONMENT_PLATFORM_LABELS[platform]);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function EnvironmentsSettings(props: {
  desktopApi?: DesktopApi;
  passSetupVariablesToAgents: DesktopSettingsValue<boolean>;
  saving: boolean;
  sub?: string;
  onOpenRoute: (sub: string | undefined) => void;
  onPassSetupVariablesToAgentsChange: (value: boolean) => Promise<void>;
}) {
  const route = decodeEnvironmentsRoute(props.sub);
  if (route.project && (route.file || route.create)) {
    return (
      <EnvironmentEditor
        key={environmentsPageKey(props.sub)}
        create={route.create === true}
        desktopApi={props.desktopApi}
        file={route.file}
        project={route.project}
        onOpenRoute={props.onOpenRoute}
      />
    );
  }
  return (
    <EnvironmentList
      desktopApi={props.desktopApi}
      passSetupVariablesToAgents={props.passSetupVariablesToAgents}
      project={route.project}
      saving={props.saving}
      onOpenRoute={props.onOpenRoute}
      onPassSetupVariablesToAgentsChange={props.onPassSetupVariablesToAgentsChange}
    />
  );
}

type Loadable<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function EnvironmentList(props: {
  desktopApi?: DesktopApi;
  passSetupVariablesToAgents: DesktopSettingsValue<boolean>;
  project?: string;
  saving: boolean;
  onOpenRoute: (sub: string | undefined) => void;
  onPassSetupVariablesToAgentsChange: (value: boolean) => Promise<void>;
}) {
  const api = props.desktopApi;
  const [projects, setProjects] = useState<Loadable<CodexEnvironmentProject[]>>({
    status: "loading",
  });
  const [files, setFiles] = useState<Loadable<CodexEnvironmentFileSummary[]>>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    const list = api?.listCodexEnvironmentProjects;
    if (!list) {
      setProjects({ status: "error", message: "Environments are unavailable in this window." });
      return;
    }
    list()
      .then((response) => {
        if (!cancelled) setProjects({ status: "ready", value: response.projects });
      })
      .catch((error: unknown) => {
        if (!cancelled) setProjects({ status: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const knownProjects = useMemo(
    () => (projects.status === "ready" ? projects.value : []),
    [projects],
  );
  const selected = props.project ?? knownProjects[0]?.path;
  // A thread's workspace (a worktree) is opened by path from the composer
  // and need not be one of the listed projects.
  const projectOptions = useMemo(() => {
    const options = knownProjects.map((project) => ({
      value: project.path,
      label: project.label,
      description: project.path,
    }));
    if (selected && !options.some((option) => option.value === selected)) {
      options.unshift({ value: selected, label: pathLabel(selected), description: selected });
    }
    return options;
  }, [knownProjects, selected]);
  const selectedLabel = projectOptions.find((option) => option.value === selected)?.label;

  useEffect(() => {
    let cancelled = false;
    const list = api?.listCodexEnvironmentFiles;
    if (!selected || !list) return;
    setFiles({ status: "loading" });
    list({ directoryPath: selected })
      .then((response) => {
        if (!cancelled) setFiles({ status: "ready", value: response.files });
      })
      .catch((error: unknown) => {
        if (!cancelled) setFiles({ status: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [api, selected]);

  const passOverridden = props.passSetupVariablesToAgents.source === "env";

  return (
    <SettingsSectionStack paneId="environments" aria-label="Environment settings">
      <SettingsPanelHead
        eyebrow="Environments"
        title="Project environments"
        help={
          <>
            Setup scripts and Run actions, saved in the project's{" "}
            <code>.codex/environments</code> folder. Codex reads the same files.{" "}
            <a className="env-link" href={CODEX_ENVIRONMENT_DOCS_URL} rel="noreferrer" target="_blank">
              About environments ↗
            </a>
          </>
        }
      />

      <SettingsSection
        eyebrow="Profile"
        title="Agent variables"
        chip={sourceBadge(props.passSetupVariablesToAgents)}
        chipKind={passOverridden ? "warn" : "default"}
      >
        <div className="settings-fields">
          <ToggleField
            checked={props.passSetupVariablesToAgents.value}
            disabled={props.saving || passOverridden}
            label="Pass setup variables to agents"
            sub="Every project in this profile."
            help={
              props.passSetupVariablesToAgents.value
                ? (
                    <>
                      When a thread selects an environment, PwrAgent runs its setup script in
                      the thread's workspace and keeps the shell variables it sets, such as{" "}
                      <code>PATH</code> and <code>NVM_DIR</code>. Secrets are left out. When
                      this is on, Codex, Claude and ACP agents get those variables when a
                      thread or turn starts. Setup and Run actions use them either way.
                    </>
                  )
                : "Setup still runs, and Run actions still get the variables. Agents start with PwrAgent's own environment. Threads already running keep theirs until they restart."
            }
            onChange={props.onPassSetupVariablesToAgentsChange}
          />
        </div>
      </SettingsSection>

      {/* A project named by the route (the composer's workspace) still
          opens when the project list can't load. */}
      {projects.status === "error" ? (
        <p className="settings-row__error" role="alert">{projects.message}</p>
      ) : null}
      {projects.status === "loading" && !props.project ? (
        <p className="settings-empty">Loading projects…</p>
      ) : !selected ? (
        projects.status === "error" ? null : (
          <p className="settings-empty">
            No projects on this machine yet. Add a folder to PwrAgent to give it environments.
          </p>
        )
      ) : (
        <SettingsSection
          eyebrow="Project"
          title={selectedLabel ?? pathLabel(selected)}
          description={selected}
          chip={files.status === "ready" ? plural(files.value.length, "file") : undefined}
        >
          <div className="settings-fields">
            <SettingsField
              label="Project"
              sub="Projects on this machine."
              help="Environments run on the machine that owns the project, so a peer's projects are edited in PwrAgent there."
              control={
                <Select
                  aria-label="Project"
                  className="settings-input select-trigger env-project-select"
                  options={projectOptions}
                  value={selected}
                  onChange={(project) => props.onOpenRoute(encodeEnvironmentsRoute({ project }))}
                />
              }
            />
            <SettingsField
              label="Environments"
              sub="Open one to edit its setup and actions."
              control={
                <div className="env-file-list">
                  {files.status === "loading" ? (
                    <p className="settings-field__help">Loading environments…</p>
                  ) : files.status === "error" ? (
                    <p className="settings-row__error" role="alert">{files.message}</p>
                  ) : files.value.length === 0 ? (
                    <p className="env-empty">This project has no environments yet.</p>
                  ) : (
                    <div className="settings-index">
                      {files.value.map((file) => (
                        <EnvironmentFileRow
                          key={file.fileName}
                          file={file}
                          onOpen={() => props.onOpenRoute(encodeEnvironmentsRoute({
                            project: selected,
                            file: file.fileName,
                            name: file.name ?? file.fileName,
                          }))}
                        />
                      ))}
                    </div>
                  )}
                  <div>
                    <button
                      className="button button--secondary"
                      type="button"
                      onClick={() => props.onOpenRoute(encodeEnvironmentsRoute({
                        project: selected,
                        create: true,
                      }))}
                    >
                      New environment
                    </button>
                  </div>
                </div>
              }
            />
          </div>
        </SettingsSection>
      )}
    </SettingsSectionStack>
  );
}

function EnvironmentFileRow(props: {
  file: CodexEnvironmentFileSummary;
  onOpen: () => void;
}) {
  const { file } = props;
  if (file.error) {
    return (
      <SettingsIndexRow
        chip="Can't read"
        chipKind="err"
        meta={file.error.message}
        name={file.fileName}
        off
        onOpen={props.onOpen}
      />
    );
  }
  const setup = file.setupPlatforms.length === 0
    ? "one setup script"
    : `${platformLabels(file.setupPlatforms).join(", ")} setup`;
  return (
    <SettingsIndexRow
      meta={`${file.fileName} · ${setup} · ${plural(file.actionCount, "action")}`}
      name={file.name ?? file.fileName}
      onOpen={props.onOpen}
    />
  );
}

function blankScript(): CodexEnvironmentScriptDocument {
  return { mode: "shared", script: "", platformScripts: {} };
}

function blankDocument(): CodexEnvironmentDocument {
  return { name: "", setup: blankScript(), cleanup: blankScript(), actions: [] };
}

type EditorBanner =
  | { kind: "conflict" }
  | { kind: "error"; message: string };

type EditorLoad =
  | { status: "loading" }
  | { status: "ok" }
  | {
      status: "unreadable";
      message: string;
      excerpt?: Array<{ line: number; text: string }>;
      sourcePath: string;
    }
  | { status: "missing" }
  | { status: "error"; message: string };

function EnvironmentEditor(props: {
  create: boolean;
  desktopApi?: DesktopApi;
  file?: string;
  project: string;
  onOpenRoute: (sub: string | undefined) => void;
}) {
  const api = props.desktopApi;
  const [load, setLoad] = useState<EditorLoad>(
    props.create ? { status: "ok" } : { status: "loading" },
  );
  const [baseline, setBaseline] = useState<CodexEnvironmentDocument>(blankDocument);
  const [draft, setDraft] = useState<CodexEnvironmentDocument>(blankDocument);
  const [revision, setRevision] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);
  const [newFileName, setNewFileName] = useState("");
  const [fileNameEdited, setFileNameEdited] = useState(false);
  const [fileError, setFileError] = useState<string>();
  const [banner, setBanner] = useState<EditorBanner>();
  const [saving, setSaving] = useState(false);
  const [editingKey, setEditingKey] = useState<string>();
  const [navigateTo, setNavigateTo] = useState<string>();
  const nextActionKeyRef = useRef(0);
  const addActionRef = useRef<HTMLButtonElement>(null);
  // A deleted row takes its ⋯ button, and the focus in it, along.
  const refocusAfterDeleteRef = useRef(false);
  useEffect(() => {
    if (!refocusAfterDeleteRef.current) return;
    refocusAfterDeleteRef.current = false;
    if (document.activeElement === null || document.activeElement === document.body) {
      addActionRef.current?.focus();
    }
  });

  useEffect(() => {
    if (props.create) return;
    let cancelled = false;
    const read = api?.readCodexEnvironmentDocument;
    if (!read || !props.file) {
      setLoad({ status: "error", message: "Environments are unavailable in this window." });
      return;
    }
    setLoad({ status: "loading" });
    read({ directoryPath: props.project, fileName: props.file })
      .then((response) => {
        if (cancelled) return;
        if (response.status === "ok") {
          setBaseline(response.document);
          setDraft(response.document);
          setRevision(response.revision);
          setEditingKey(undefined);
          setBanner(undefined);
          setLoad({ status: "ok" });
        } else if (response.status === "unreadable") {
          setLoad({
            status: "unreadable",
            message: response.message,
            excerpt: response.excerpt,
            sourcePath: response.sourcePath,
          });
        } else {
          setLoad({ status: "missing" });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ status: "error", message: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [api, props.create, props.file, props.project, reloadToken]);

  const fileName = props.create ? newFileName : props.file ?? "";
  const problems = useMemo(() => {
    const found = validateCodexEnvironmentDocument(draft);
    if (props.create && !isValidCodexEnvironmentFileName(newFileName)) {
      found.push({
        field: "fileName",
        message: "Use letters, numbers, dots, dashes or underscores, ending in .toml.",
      });
    }
    return found;
  }, [draft, newFileName, props.create]);
  const problemFor = (field: string): string | undefined =>
    problems.find((problem) => problem.field === field)?.message;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  const discard = useCallback(() => {
    setDraft(baseline);
    setEditingKey(undefined);
    setFileError(undefined);
    setBanner(undefined);
  }, [baseline]);

  const save = async (): Promise<boolean> => {
    const write = api?.saveCodexEnvironmentDocument;
    if (!write || problems.length > 0) return false;
    setSaving(true);
    setBanner(undefined);
    setFileError(undefined);
    try {
      const response = await write({
        directoryPath: props.project,
        fileName,
        document: draft,
        ...(props.create ? {} : { expectedRevision: revision }),
      });
      switch (response.status) {
        case "saved":
          setBaseline(response.document);
          setDraft(response.document);
          setRevision(response.revision);
          setEditingKey(undefined);
          // A new file opens its own page. An edited one stays, and the
          // route takes the saved name so the breadcrumb follows a rename.
          setNavigateTo(encodeEnvironmentsRoute({
            project: props.project,
            file: fileName,
            name: response.document.name.trim(),
          }));
          return true;
        case "conflict":
          setBanner({ kind: "conflict" });
          return false;
        case "exists":
          setFileError(`${fileName} already exists in this project.`);
          return false;
        case "invalid":
          setBanner({
            kind: "error",
            message: response.problems.map((problem) => problem.message).join(" "),
          });
          return false;
        case "unreadable":
          setBanner({ kind: "error", message: response.message });
          return false;
      }
    } catch (error) {
      setBanner({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      setSaving(false);
    }
  };

  useUnsavedSettingsChanges(
    dirty ? { label: "Environment", save, discard } : undefined,
  );

  // Leave a saved new file for its own page only once the draft reads as
  // saved, so the leave check does not ask about edits that are on disk.
  const onOpenRoute = props.onOpenRoute;
  useEffect(() => {
    if (navigateTo && !dirty) {
      setNavigateTo(undefined);
      onOpenRoute(navigateTo);
    }
  }, [dirty, navigateTo, onOpenRoute]);

  const setName = (name: string) => {
    setDraft((current) => ({ ...current, name }));
    if (props.create && !fileNameEdited) {
      setNewFileName(name.trim() ? suggestCodexEnvironmentFileName(name) : "");
      setFileError(undefined);
    }
  };
  const setActions = (
    update: (actions: CodexEnvironmentActionDocument[]) => CodexEnvironmentActionDocument[],
  ) => {
    setDraft((current) => ({ ...current, actions: update(current.actions) }));
  };
  const addAction = () => {
    nextActionKeyRef.current += 1;
    const key = `new-${nextActionKeyRef.current}`;
    setActions((actions) => [
      ...actions,
      {
        key,
        name: "",
        icon: CODEX_ENVIRONMENT_DEFAULT_ACTION_ICON,
        mode: "shared",
        command: "",
        platformCommands: {},
      },
    ]);
    setEditingKey(key);
  };
  const finishEditing = () => {
    // A row left blank is dropped, the way Codex drops one.
    setActions((actions) => actions.filter((action) =>
      action.key !== editingKey || !isBlankCodexEnvironmentAction(action)));
    setEditingKey(undefined);
  };

  const backToList = () => props.onOpenRoute(encodeEnvironmentsRoute({ project: props.project }));
  const projectLabel = pathLabel(props.project);
  const title = draft.name.trim()
    || (props.create ? "New environment" : props.file ?? "Environment");
  const head = (
    <SettingsPanelHead
      eyebrow={`Environment · ${projectLabel}`}
      title={load.status === "ok" ? title : props.file ?? "Environment"}
      help={
        <>
          {fileName ? <code>.codex/environments/{fileName}</code> : null}
          {fileName ? " · " : null}
          <a className="env-link" href={CODEX_ENVIRONMENT_DOCS_URL} rel="noreferrer" target="_blank">
            Codex environment docs ↗
          </a>
        </>
      }
    />
  );

  if (load.status !== "ok") {
    return (
      <SettingsSectionStack paneId="environment-editor" aria-label="Environment">
        {head}
        {load.status === "loading" ? (
          <p className="settings-empty">Loading environment…</p>
        ) : load.status === "unreadable" ? (
          <div className="env-unreadable">
            <div className="env-banner" role="alert">
              <div className="env-banner__body">
                <b>PwrAgent can't edit {props.file}.</b> {load.message} Saving could lose
                part of the file, so fix the line in an editor, then reopen it here.
                <div className="env-banner__acts">
                  {api?.openPath ? (
                    <button
                      className="button button--secondary"
                      type="button"
                      onClick={() => {
                        void api.openPath?.({ path: load.sourcePath });
                      }}
                    >
                      Open in editor
                    </button>
                  ) : null}
                  <button className="button button--ghost" type="button" onClick={backToList}>
                    Back to environments
                  </button>
                </div>
              </div>
            </div>
            {load.excerpt?.length ? (
              <pre className="env-excerpt" aria-label="File excerpt">
                {load.excerpt.map((line) => `${String(line.line).padStart(3, " ")}  ${line.text}`).join("\n")}
              </pre>
            ) : null}
          </div>
        ) : load.status === "missing" ? (
          <div className="env-banner" role="alert">
            <div className="env-banner__body">
              <b>{props.file} is gone.</b> It was moved or deleted after the list loaded.
              <div className="env-banner__acts">
                <button className="button button--secondary" type="button" onClick={backToList}>
                  Back to environments
                </button>
              </div>
            </div>
          </div>
        ) : (
          <p className="settings-row__error" role="alert">{load.message}</p>
        )}
      </SettingsSectionStack>
    );
  }

  const nameProblem = problemFor("name");
  const actionProblems = new Map(
    problems
      .filter((problem) => problem.field.startsWith("action:"))
      .map((problem) => [problem.field.slice("action:".length), problem.message]),
  );
  const visibleActions = draft.actions;

  return (
    <SettingsSectionStack paneId="environment-editor" aria-label="Environment">
      {head}

      {banner?.kind === "conflict" ? (
        <div className="env-banner" role="alert">
          <div className="env-banner__body">
            <b>{fileName} changed on disk</b> after you opened it, so PwrAgent did not save.
            Reload to see the new version; your edits here will be lost.
            <div className="env-banner__acts">
              <button
                className="button button--secondary"
                type="button"
                onClick={() => setReloadToken((token) => token + 1)}
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      ) : banner?.kind === "error" ? (
        <div className="env-banner" role="alert">
          <div className="env-banner__body">
            <b>PwrAgent did not save.</b> {banner.message}
          </div>
        </div>
      ) : null}

      <p className="env-explainer">
        <b>When a thread selects this environment,</b> PwrAgent runs the setup script in the
        thread's workspace. The actions appear in the composer's Run chip.
      </p>

      <SettingsSection
        eyebrow={props.create ? "New environment" : undefined}
        title={props.create ? "Name and file" : "Name"}
      >
        <div className="settings-fields">
          <SettingsField
            label="Name"
            sub="Shown in the Environment chip."
            error={nameProblem}
            control={
              <input
                aria-invalid={nameProblem ? true : undefined}
                aria-label="Name"
                className="settings-input settings-input--inline"
                spellCheck={false}
                type="text"
                value={draft.name}
                onChange={(event) => setName(event.target.value)}
              />
            }
          />
          {props.create ? (
            <SettingsField
              label="File"
              sub="In .codex/environments. Can't be changed later."
              error={fileError ?? (newFileName ? problemFor("fileName") : undefined)}
              control={
                <input
                  aria-invalid={fileError ? true : undefined}
                  aria-label="File"
                  className="settings-input settings-input--inline"
                  placeholder="environment.toml"
                  spellCheck={false}
                  type="text"
                  value={newFileName}
                  onChange={(event) => {
                    setNewFileName(event.target.value);
                    setFileNameEdited(true);
                    setFileError(undefined);
                  }}
                />
              }
            />
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Setup script"
        description="Runs in the thread's workspace when a thread selects this environment."
      >
        <div className="settings-fields">
          <ScriptFields
            kind="setup"
            value={draft.setup}
            onChange={(setup) => setDraft((current) => ({ ...current, setup }))}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Actions"
        description="Commands for the Run chip. They run in the thread's workspace with the setup variables."
        chip={plural(visibleActions.length, "action")}
      >
        <div className="env-actions">
          {visibleActions.length ? (
            <ol className="env-action-list">
              {visibleActions.map((action, index) => (
                <ActionRow
                  key={action.key}
                  action={action}
                  count={visibleActions.length}
                  editing={editingKey === action.key}
                  index={index}
                  problem={actionProblems.get(action.key)}
                  onChange={(next) => setActions((actions) =>
                    actions.map((entry) => (entry.key === action.key ? next : entry)))}
                  onDelete={() => {
                    refocusAfterDeleteRef.current = true;
                    setActions((actions) => actions.filter((entry) => entry.key !== action.key));
                    if (editingKey === action.key) setEditingKey(undefined);
                  }}
                  onDone={finishEditing}
                  onEdit={() => setEditingKey(action.key)}
                  onMove={(delta) => setActions((actions) => {
                    const from = actions.findIndex((entry) => entry.key === action.key);
                    const to = from + delta;
                    if (from < 0 || to < 0 || to >= actions.length) return actions;
                    const next = [...actions];
                    const [moved] = next.splice(from, 1);
                    next.splice(to, 0, moved!);
                    return next;
                  })}
                />
              ))}
            </ol>
          ) : (
            <p className="env-empty">No actions yet.</p>
          )}
          <div>
            <button
              ref={addActionRef}
              className="button button--secondary"
              type="button"
              onClick={addAction}
            >
              Add action
            </button>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Cleanup script"
        description="Codex runs this before it removes a worktree. PwrAgent keeps it but does not run it."
        chip={hasScript(draft.cleanup) ? undefined : "empty"}
      >
        <div className="settings-fields">
          <ScriptFields
            kind="cleanup"
            value={draft.cleanup}
            onChange={(cleanup) => setDraft((current) => ({ ...current, cleanup }))}
          />
        </div>
      </SettingsSection>

      {dirty ? (
        <SaveBar
          problems={problems}
          saving={saving}
          summary={props.create ? `New file ${fileName || "…"}` : undefined}
          onDiscard={props.create ? backToList : discard}
          onSave={() => {
            void save();
          }}
        />
      ) : null}
    </SettingsSectionStack>
  );
}

function hasScript(value: CodexEnvironmentScriptDocument): boolean {
  return Boolean(value.script.trim())
    || Object.values(value.platformScripts).some((script) => script?.trim());
}

function SaveBar(props: {
  problems: CodexEnvironmentProblem[];
  saving: boolean;
  summary?: string;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const blocked = props.problems.length > 0;
  return (
    <div className="env-savebar" role="region" aria-label="Unsaved environment changes">
      <p className={`env-savebar__text${blocked ? " is-err" : ""}`}>
        {blocked
          ? `Fix ${plural(props.problems.length, "problem")} to save.`
          : (
              <>
                <b>Unsaved changes</b>
                {props.summary ? ` · ${props.summary}` : null}
              </>
            )}
      </p>
      <button
        className="button button--secondary"
        disabled={props.saving}
        type="button"
        onClick={props.onDiscard}
      >
        Discard
      </button>
      <button
        className="button button--primary"
        disabled={blocked || props.saving}
        type="button"
        onClick={props.onSave}
      >
        {props.saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

/** Platforms grouped by the script they would run, in platform order. */
function groupPlatformsByText(
  textFor: (platform: CodexEnvironmentPlatform) => string | undefined,
): Array<{ text: string; platforms: CodexEnvironmentPlatform[] }> {
  const groups: Array<{ text: string; platforms: CodexEnvironmentPlatform[] }> = [];
  for (const platform of CODEX_ENVIRONMENT_PLATFORMS) {
    const text = textFor(platform);
    if (text === undefined) continue;
    const group = groups.find((entry) => entry.text === text);
    if (group) group.platforms.push(platform);
    else groups.push({ text, platforms: [platform] });
  }
  return groups;
}

/**
 * Asks which script survives when separate platform scripts become one.
 * Nothing is removed until the operator picks.
 */
function KeepOneChoice(props: {
  groups: Array<{ text: string; platforms: CodexEnvironmentPlatform[] }>;
  noun: string;
  question: string;
  onCancel: () => void;
  onKeep: (text: string) => void;
}) {
  const differs = props.groups.length === 2
    ? `The ${joinWords(platformLabels(props.groups[1]!.platforms))} ${props.noun} differs from the ${joinWords(platformLabels(props.groups[0]!.platforms))} one.`
    : `Each platform has its own ${props.noun}.`;
  return (
    <div className="env-banner env-banner--warn" role="group" aria-label={props.question}>
      <div className="env-banner__body">
        <b>{props.question}</b> {differs} Pick the {props.noun} to keep; the other is removed
        when you save.
        <div className="env-banner__acts">
          {props.groups.map((group) => (
            <button
              key={group.platforms.join(",")}
              className="button button--secondary"
              type="button"
              onClick={() => props.onKeep(group.text)}
            >
              Keep {joinWords(platformLabels(group.platforms))}
            </button>
          ))}
          <button className="button button--ghost" type="button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const SCRIPT_MODE_OPTIONS = [
  { value: "shared" as const, label: "One script for all platforms" },
  { value: "perPlatform" as const, label: "Separate macOS, Linux and Windows scripts" },
];

function ScriptFields(props: {
  kind: "setup" | "cleanup";
  value: CodexEnvironmentScriptDocument;
  onChange: (value: CodexEnvironmentScriptDocument) => void;
}) {
  const { value } = props;
  const noun = `${props.kind} script`;
  const [tab, setTab] = useState<CodexEnvironmentPlatform>("darwin");
  const [joining, setJoining] = useState(false);
  const tabsId = useId();
  // An empty platform script falls back to the default, as in Codex.
  const effective = (platform: CodexEnvironmentPlatform): string =>
    value.platformScripts[platform]?.trim() ? value.platformScripts[platform]! : value.script;
  const groups = groupPlatformsByText(effective);

  const chooseMode = (mode: CodexEnvironmentScriptDocument["mode"]) => {
    if (mode === "perPlatform") {
      setJoining(false);
      props.onChange({ ...value, mode });
      return;
    }
    if (groups.length > 1) {
      setJoining(true);
      return;
    }
    props.onChange({ mode: "shared", script: groups[0]?.text ?? value.script, platformScripts: {} });
  };

  const sharedPlatforms = CODEX_ENVIRONMENT_PLATFORMS.filter(
    (platform) => value.platformScripts[platform] === undefined,
  );
  const ownScript = value.platformScripts[tab] !== undefined;
  const shellHelp = "Your login shell on macOS and Linux. PowerShell on Windows.";

  return (
    <>
      <SettingsField
        label="Platforms"
        control={
          <SegmentedControl
            label={`${props.kind === "setup" ? "Setup" : "Cleanup"} script platforms`}
            options={SCRIPT_MODE_OPTIONS}
            value={value.mode}
            onChange={chooseMode}
          />
        }
      />
      {joining ? (
        <KeepOneChoice
          groups={groups}
          noun="script"
          question="Use one script for every platform?"
          onCancel={() => setJoining(false)}
          onKeep={(text) => {
            setJoining(false);
            props.onChange({ mode: "shared", script: text, platformScripts: {} });
          }}
        />
      ) : null}
      {value.mode === "shared" ? (
        <SettingsField
          label="Script"
          sub={shellHelp}
          control={
            <textarea
              aria-label={props.kind === "setup" ? "Setup script" : "Cleanup script"}
              className="settings-input settings-input--multiline env-code"
              rows={5}
              spellCheck={false}
              value={value.script}
              onChange={(event) => props.onChange({ ...value, script: event.target.value })}
            />
          }
        />
      ) : (
        <SettingsField
          label="Script"
          sub={tab === "win32" ? "PowerShell on Windows." : "Your login shell."}
          help={
            sharedPlatforms.length
              ? `${joinWords(platformLabels(sharedPlatforms))} ${sharedPlatforms.length === 1 ? "runs" : "run"} the shared script. Typing in a Shared tab gives that platform its own.`
              : undefined
          }
          control={
            <div className="env-script">
              <div className="env-scripthead">
                <div className="settings-segmented" role="tablist" aria-label={`${noun} platform`}>
                  {CODEX_ENVIRONMENT_PLATFORMS.map((platform) => (
                    <button
                      key={platform}
                      aria-controls={`${tabsId}-panel`}
                      aria-selected={tab === platform}
                      className={`settings-segmented__button${tab === platform ? " is-active" : ""}`}
                      id={`${tabsId}-${platform}`}
                      role="tab"
                      type="button"
                      onClick={() => setTab(platform)}
                    >
                      {CODEX_ENVIRONMENT_PLATFORM_LABELS[platform]}
                      {value.platformScripts[platform] === undefined ? (
                        <span className="env-tab-badge">Shared</span>
                      ) : null}
                    </button>
                  ))}
                </div>
                {ownScript ? (
                  <button
                    className="button button--ghost env-button--small"
                    type="button"
                    onClick={() => {
                      const platformScripts = { ...value.platformScripts };
                      delete platformScripts[tab];
                      props.onChange({ ...value, platformScripts });
                    }}
                  >
                    Use the shared script
                  </button>
                ) : null}
              </div>
              <div
                aria-labelledby={`${tabsId}-${tab}`}
                id={`${tabsId}-panel`}
                role="tabpanel"
              >
                <textarea
                  aria-label={`${CODEX_ENVIRONMENT_PLATFORM_LABELS[tab]} ${noun}`}
                  className="settings-input settings-input--multiline env-code"
                  rows={5}
                  spellCheck={false}
                  value={value.platformScripts[tab] ?? value.script}
                  onChange={(event) => props.onChange({
                    ...value,
                    platformScripts: { ...value.platformScripts, [tab]: event.target.value },
                  })}
                />
              </div>
            </div>
          }
        />
      )}
    </>
  );
}

const ACTION_ICON_LABELS: Record<string, string> = {
  tool: "Tool",
  run: "Run",
  debug: "Debug",
  test: "Test",
};

const ACTION_ICON_GLYPHS: Record<string, ComponentType<IconProps>> = {
  tool: SettingsIcon,
  run: PlayIcon,
  debug: TerminalIcon,
  test: CheckIcon,
};

const ACTION_MODE_OPTIONS = [
  { value: "shared" as const, label: "All platforms" },
  { value: "perPlatform" as const, label: "Separate macOS, Linux and Windows" },
];

function actionPlatforms(action: CodexEnvironmentActionDocument): CodexEnvironmentPlatform[] {
  return CODEX_ENVIRONMENT_PLATFORMS.filter(
    (platform) => action.platformCommands[platform] !== undefined,
  );
}

function ActionRow(props: {
  action: CodexEnvironmentActionDocument;
  count: number;
  editing: boolean;
  index: number;
  problem?: string;
  onChange: (action: CodexEnvironmentActionDocument) => void;
  onDelete: () => void;
  onDone: () => void;
  onEdit: () => void;
  onMove: (delta: number) => void;
}) {
  const { action } = props;
  const [joining, setJoining] = useState(false);
  const fieldId = useId();
  const label = action.name.trim() || "untitled action";
  const Glyph = ACTION_ICON_GLYPHS[action.icon] ?? SettingsIcon;
  const platforms = action.mode === "shared" ? [] : actionPlatforms(action);
  const preview = action.mode === "shared"
    ? action.command
    : `${plural(platforms.length, "script")} · ${action.platformCommands[platforms[0] ?? "darwin"] ?? ""}`;
  const iconOptions = [
    ...CODEX_ENVIRONMENT_ACTION_ICONS.map((icon) => ({ value: icon as string, label: ACTION_ICON_LABELS[icon]! })),
    ...(ACTION_ICON_LABELS[action.icon] ? [] : [{ value: action.icon, label: action.icon }]),
  ];
  const commandGroups = groupPlatformsByText((platform) => {
    const command = action.platformCommands[platform];
    return command?.trim() ? command : undefined;
  });
  const problemChip = props.problem?.startsWith("Add a command")
    ? "No command"
    : props.problem
      ? "No name"
      : undefined;

  const chooseMode = (mode: CodexEnvironmentActionDocument["mode"]) => {
    if (mode === "perPlatform") {
      setJoining(false);
      const command = action.command;
      props.onChange({
        ...action,
        mode,
        platformCommands: Object.fromEntries(
          CODEX_ENVIRONMENT_PLATFORMS.map((platform) => [platform, command]),
        ),
      });
      return;
    }
    if (commandGroups.length > 1) {
      setJoining(true);
      return;
    }
    props.onChange({
      ...action,
      mode: "shared",
      command: commandGroups[0]?.text ?? "",
      platformCommands: {},
    });
  };

  return (
    <li
      className={`env-action${props.editing ? " is-editing" : ""}${props.problem ? " is-invalid" : ""}`}
    >
      <span aria-hidden="true" className="env-glyph">
        <Glyph size={13} />
      </span>
      <div className="env-action__main">
        <div className="env-action__titleline">
          <span className="env-action__name">{action.name.trim() || "Untitled action"}</span>
          {action.mode === "shared" ? (
            <span className="env-chip">All platforms</span>
          ) : (
            platformLabels(platforms).map((platformLabel) => (
              <span key={platformLabel} className="env-chip">{platformLabel}</span>
            ))
          )}
          {problemChip ? <span className="env-chip env-chip--err">{problemChip}</span> : null}
        </div>
        {props.editing ? null : <span className="env-action__cmd">{preview}</span>}
      </div>
      <div className="env-action__tools">
        {props.editing ? null : (
          <button
            aria-label={`Edit ${label}`}
            className="env-iconbtn"
            type="button"
            onClick={props.onEdit}
          >
            <PencilIcon size={13} />
          </button>
        )}
        <ActionMenu
          canMoveDown={props.index < props.count - 1}
          canMoveUp={props.index > 0}
          label={label}
          onDelete={props.onDelete}
          onMove={props.onMove}
        />
      </div>
      {props.editing ? (
        <div className="env-action__edit">
          <label htmlFor={`${fieldId}-name`}>Name</label>
          <input
            aria-label="Action name"
            autoFocus
            className="settings-input settings-input--inline"
            id={`${fieldId}-name`}
            spellCheck={false}
            type="text"
            value={action.name}
            onChange={(event) => props.onChange({ ...action, name: event.target.value })}
          />
          <span className="env-action__label">Icon</span>
          <Select
            aria-label="Action icon"
            className="settings-input select-trigger env-icon-select"
            options={iconOptions}
            value={action.icon}
            onChange={(icon) => props.onChange({ ...action, icon })}
          />
          <span className="env-action__label">Platforms</span>
          <SegmentedControl
            label="Action platforms"
            options={ACTION_MODE_OPTIONS}
            value={action.mode}
            onChange={chooseMode}
          />
          {joining ? (
            <div className="env-action__wide">
              <KeepOneChoice
                groups={commandGroups}
                noun="command"
                question="Use one command for every platform?"
                onCancel={() => setJoining(false)}
                onKeep={(command) => {
                  setJoining(false);
                  props.onChange({ ...action, mode: "shared", command, platformCommands: {} });
                }}
              />
            </div>
          ) : null}
          {action.mode === "shared" ? (
            <>
              <label htmlFor={`${fieldId}-command`}>Command</label>
              <textarea
                aria-label="Action command"
                className="settings-input settings-input--multiline env-code env-code--short"
                id={`${fieldId}-command`}
                rows={2}
                spellCheck={false}
                value={action.command}
                onChange={(event) => props.onChange({ ...action, command: event.target.value })}
              />
            </>
          ) : (
            CODEX_ENVIRONMENT_PLATFORMS.map((platform) => (
              <PlatformCommandField
                key={platform}
                action={action}
                fieldId={`${fieldId}-${platform}`}
                platform={platform}
                onChange={props.onChange}
              />
            ))
          )}
          {props.problem ? (
            <p className="env-error env-action__wide" role="alert">{props.problem}</p>
          ) : null}
          <div className="env-action__foot">
            <span className="spacer" />
            <button
              className="button button--secondary env-button--danger env-button--small"
              type="button"
              onClick={props.onDelete}
            >
              Delete action
            </button>
            <button className="button button--secondary env-button--small" type="button" onClick={props.onDone}>
              Done
            </button>
          </div>
        </div>
      ) : props.problem ? (
        <p className="env-error env-action__wide" role="alert">{props.problem}</p>
      ) : null}
    </li>
  );
}

function PlatformCommandField(props: {
  action: CodexEnvironmentActionDocument;
  fieldId: string;
  platform: CodexEnvironmentPlatform;
  onChange: (action: CodexEnvironmentActionDocument) => void;
}) {
  const platformLabel = CODEX_ENVIRONMENT_PLATFORM_LABELS[props.platform];
  return (
    <>
      <label htmlFor={props.fieldId}>{platformLabel}</label>
      <textarea
        aria-label={`${platformLabel} command`}
        className="settings-input settings-input--multiline env-code env-code--short"
        id={props.fieldId}
        placeholder={`No action on ${platformLabel}`}
        rows={2}
        spellCheck={false}
        value={props.action.platformCommands[props.platform] ?? ""}
        onChange={(event) => {
          const platformCommands = { ...props.action.platformCommands };
          // An empty command means the action is not offered on that platform.
          if (event.target.value) platformCommands[props.platform] = event.target.value;
          else delete platformCommands[props.platform];
          props.onChange({ ...props.action, platformCommands });
        }}
      />
    </>
  );
}

function ActionMenu(props: {
  canMoveDown: boolean;
  canMoveUp: boolean;
  label: string;
  onDelete: () => void;
  onMove: (delta: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);

  useMenuNavigation({ open, menuRef, triggerRef, onClose: close });

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      if (!wrapperRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [close, open]);

  const item = (text: string, enabled: boolean, run: () => void, danger = false) => (
    <button
      aria-disabled={enabled ? undefined : true}
      className={`todo-split__item${danger ? " env-menu__danger" : ""}`}
      role="menuitem"
      type="button"
      onClick={() => {
        if (!enabled) return;
        close();
        run();
      }}
    >
      <span className="todo-split__item-label">{text}</span>
    </button>
  );

  return (
    <div ref={wrapperRef} className="env-menu">
      <button
        ref={triggerRef}
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`More for ${props.label}`}
        className="env-iconbtn"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <MoreVerticalIcon size={13} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          aria-label={`Actions for ${props.label}`}
          className="todo-split__menu env-menu__list"
          id={menuId}
          role="menu"
          tabIndex={-1}
        >
          {item("Move up", props.canMoveUp, () => props.onMove(-1))}
          {item("Move down", props.canMoveDown, () => props.onMove(1))}
          <div className="todo-split__separator" role="separator" />
          {item("Delete", true, props.onDelete, true)}
        </div>
      ) : null}
    </div>
  );
}
