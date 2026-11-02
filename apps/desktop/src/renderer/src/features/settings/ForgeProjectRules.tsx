import {
  FORGE_AGENT_RULE_ALL_AGENTS,
  FORGE_AGENT_TOOL_RULE_GROUPS,
  forgeAgentRuleAgentKey,
  forgeAgentRuleAgentLabel,
  forgeAgentToolAccessLevels,
  forgeRuleRepositoryLabel,
  forgeRuleRepositoryMatchKey,
  normalizeForgeRuleRepository,
  parseCodexProviderModelId,
  removeForgeAgentToolRule,
  resolveForgeAgentToolInheritedAccess,
  sameForgeAgentRuleAgent,
  sameForgeRuleRepository,
  upsertForgeAgentToolRule,
  validateForgeAgentRuleAgent,
  type BackendSummary,
  type DesktopCodexModelProvider,
  type ForgeAgentRuleAgent,
  type ForgeAgentRuleNames,
  type ForgeAgentToolAccess,
  type ForgeAgentToolAccessResolution,
  type ForgeAgentToolGroup,
  type ForgeAgentToolPolicy,
  type ForgeAgentToolRule,
  type ForgeAgentToolRuleGroup,
  type NavigationDirectoryRow,
} from "@pwragent/shared";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Select, type SelectOption } from "../../components/Select";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  isNavigationPreviewCancelled,
  useNavigationSettingsPreview,
} from "../../lib/navigation-settings-preview";
import "./forge-project-rules.css";

export const FORGE_TOOL_ACCESS_LABELS: Record<ForgeAgentToolAccess, string> = {
  allow: "Allow",
  auto: "Auto",
  ask: "Ask",
  off: "Off",
};

const FORGE_TOOL_ACCESS_DESCRIPTIONS: Record<ForgeAgentToolAccess, string> = {
  allow: "Runs without asking.",
  auto: "Runs in Codex Auto and Full Access threads. Asks otherwise.",
  ask: "Always asks.",
  off: "Removes these tools from threads.",
};

// Approving and merging cannot be taken back, so Auto waits for Full Access.
const FORGE_TOOL_APPROVE_MERGE_AUTO_DESCRIPTION = "Asks unless the thread has Full Access.";

export function forgeToolAccessDescription(group: ForgeAgentToolGroup, level: ForgeAgentToolAccess): string {
  return group === "approve_merge" && level === "auto"
    ? FORGE_TOOL_APPROVE_MERGE_AUTO_DESCRIPTION
    : FORGE_TOOL_ACCESS_DESCRIPTIONS[level];
}

/** Column headings: the global rows' labels, shortened to fit a table. */
const RULE_GROUP_COLUMN_LABELS: Record<ForgeAgentToolRuleGroup, string> = {
  pull_requests: "Pull requests",
  comments: "Comments",
  issues: "Issues",
  ci: "CI reruns",
  approve_merge: "Approve and merge",
};

const INHERIT_VALUE = "inherit";
// Model ids are trimmed, so none can collide with a value that starts with a space.
const OTHER_MODEL_VALUE = " other";
const ALL_AGENTS: ForgeAgentRuleAgent = { backend: FORGE_AGENT_RULE_ALL_AGENTS };

type CellValue = ForgeAgentToolAccess | typeof INHERIT_VALUE;

/** An installed ACP agent the operator can write a rule for. */
export type ForgeRuleAcpAgent = { registryId: string; name: string };

/** One entry in the Add agent picker. */
type AgentChoice = {
  key: string;
  label: string;
  description: string;
  agent: ForgeAgentRuleAgent;
  /** Model ids the renderer already knows for this agent. */
  models: string[];
};

const sameRepository = sameForgeRuleRepository;

type FocusTarget = () => HTMLElement | null | undefined;

/**
 * Move focus to a control once it can take it. A control swapped for
 * another, or disabled while a write saves, drops focus to the page, so a
 * request waits until its target is mounted and enabled. It is dropped if
 * the operator has moved focus somewhere else meanwhile.
 */
function usePendingFocus(): (target: FocusTarget) => void {
  const pending = useRef<{ target: FocusTarget; origin: Element | null } | undefined>(undefined);
  const [, setRequest] = useState(0);
  useEffect(() => {
    const current = pending.current;
    if (!current) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== current.origin && active.isConnected) {
      pending.current = undefined;
      return;
    }
    const element = current.target();
    if (!element || element.matches(":disabled")) return;
    pending.current = undefined;
    element.focus();
  });
  return useCallback((target: FocusTarget) => {
    pending.current = { target, origin: document.activeElement };
    setRequest((count) => count + 1);
  }, []);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function backendModelIds(
  backends: readonly BackendSummary[] | undefined,
  kind: string,
  keep: (option: { id: string; providerId?: string }) => boolean = () => true,
): string[] {
  const backend = backends?.find((entry) => entry.kind === kind);
  return (backend?.launchpadOptions?.models ?? [])
    .filter(keep)
    .map((option) => option.id);
}

function buildAgentChoices(input: {
  acpAgents: readonly ForgeRuleAcpAgent[];
  backends?: readonly BackendSummary[];
  codexProviders: readonly DesktopCodexModelProvider[];
}): AgentChoice[] {
  const choices: AgentChoice[] = [
    {
      key: "claude",
      label: "Claude",
      description: "Claude threads on any model.",
      agent: { backend: "claude" },
      models: uniqueSorted(backendModelIds(input.backends, "claude")),
    },
    {
      key: "codex",
      label: "Codex",
      description: "Codex threads on OpenAI models.",
      agent: { backend: "codex" },
      models: uniqueSorted(backendModelIds(
        input.backends,
        "codex",
        (option) => !option.providerId && !parseCodexProviderModelId(option.id).providerId,
      )),
    },
  ];
  for (const provider of input.codexProviders) {
    const served = backendModelIds(
      input.backends,
      "codex",
      (option) => (option.providerId ?? parseCodexProviderModelId(option.id).providerId) === provider.id,
    ).map((id) => parseCodexProviderModelId(id).model);
    choices.push({
      key: `codex:${provider.id}`,
      label: `Codex · ${provider.name || provider.id}`,
      description: `Codex threads on models ${provider.name || provider.id} serves.`,
      agent: { backend: "codex", codexModelProvider: provider.id },
      models: uniqueSorted([...(provider.models ?? []), ...served]),
    });
  }
  for (const agent of input.acpAgents) {
    choices.push({
      key: `acp:${agent.registryId}`,
      label: agent.name,
      description: `${agent.name} threads on any model.`,
      agent: { backend: `acp:${agent.registryId}` },
      models: uniqueSorted(backendModelIds(input.backends, `acp:${agent.registryId}`)),
    });
  }
  return choices;
}

/** Projects from the Directories lens, keyed by repository match key. */
function projectLabelsFromDirectories(
  rows: readonly NavigationDirectoryRow[],
): Map<string, { repository: string; label: string }> {
  const labels = new Map<string, { repository: string; label: string }>();
  // Registered projects first; a worktree or workspace row only fills a gap.
  const ordered = [
    ...rows.filter((row) => row.kind === "directory"),
    ...rows.filter((row) => row.kind !== "directory"),
  ];
  for (const row of ordered) {
    const repository = row.repositoryKey
      ? normalizeForgeRuleRepository(row.repositoryKey)
      : undefined;
    const key = repository?.toLowerCase();
    if (repository && key && !labels.has(key)) labels.set(key, { repository, label: row.label });
  }
  return labels;
}

function inheritDescription(
  resolution: ForgeAgentToolAccessResolution,
  names: ForgeAgentRuleNames,
): string {
  if (resolution.source === "project_rule") {
    return `From the ${forgeAgentRuleAgentLabel(resolution.rule.agent, names)} row.`;
  }
  return resolution.source === "disabled"
    ? "Forge tools are off for every thread."
    : "From the defaults above.";
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * Settings → Git → Agent forge tools → Project rules: per-repository,
 * per-agent overrides of the write groups. Every change writes the whole
 * rules list through `onRulesChange`; the global rows above stay the
 * defaults a cell inherits.
 */
export function ForgeProjectRules(props: {
  policy: ForgeAgentToolPolicy;
  saving: boolean;
  acpAgents: readonly ForgeRuleAcpAgent[];
  backends?: readonly BackendSummary[];
  codexProviders: readonly DesktopCodexModelProvider[];
  desktopApi?: DesktopApi;
  /** A repository to show open on arrival, from the sidebar's project menu. */
  focusRepository?: string;
  onRulesChange: (rules: ForgeAgentToolRule[]) => Promise<boolean | void>;
}) {
  const rules = useMemo(() => props.policy.rules ?? [], [props.policy.rules]);
  const disabled = props.saving || !props.policy.enabled;
  const focusKey = props.focusRepository
    ? normalizeForgeRuleRepository(props.focusRepository)
    : undefined;
  // Repositories opened this visit that may hold no rule yet. A project is
  // only written once one of its cells is set.
  const [added, setAdded] = useState<string[]>(() => (focusKey ? [focusKey] : []));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(focusKey ? [focusKey] : []),
  );
  const [seenFocusKey, setSeenFocusKey] = useState(focusKey);
  if (focusKey !== seenFocusKey) {
    setSeenFocusKey(focusKey);
    if (focusKey) {
      setAdded((current) => (current.includes(focusKey) ? current : [...current, focusKey]));
      setExpanded((current) => new Set([...current, focusKey]));
    }
  }
  const [addingProject, setAddingProject] = useState(false);
  const [status, setStatus] = useState<string | undefined>();
  const addProjectRef = useRef<HTMLButtonElement>(null);
  const focusWhenReady = usePendingFocus();
  const unreadable = useMemo(
    () => props.policy.unreadableRuleRepositories ?? [],
    [props.policy.unreadableRuleRepositories],
  );

  const repositories = useMemo(() => {
    const list: string[] = [];
    for (const repository of [...rules.map((rule) => rule.repository), ...unreadable, ...added]) {
      if (!list.some((entry) => sameRepository(entry, repository))) list.push(repository);
    }
    return list;
  }, [added, rules, unreadable]);

  const previews = useNavigationSettingsPreview(props.desktopApi);
  const canReadDirectories = Boolean(
    props.desktopApi?.getNavigationQueryPage && props.desktopApi?.releaseNavigationQuery,
  );
  const [directoryRows, setDirectoryRows] = useState<NavigationDirectoryRow[]>();
  const [directoryRead, setDirectoryRead] = useState<"idle" | "loading" | "done">("idle");
  const readDirectories = previews.readDirectories;
  const loadDirectories = useCallback(async () => {
    setDirectoryRead("loading");
    try {
      setDirectoryRows(await readDirectories());
    } catch (error) {
      // Names are a nicety: without them a project shows as owner/repo and
      // the Add project form takes a typed repository.
      if (isNavigationPreviewCancelled(error)) return;
    } finally {
      setDirectoryRead("done");
    }
  }, [readDirectories]);
  const wantsDirectories = repositories.length > 0 || addingProject;
  useEffect(() => {
    if (!wantsDirectories || !canReadDirectories || directoryRead !== "idle") return;
    void loadDirectories();
  }, [canReadDirectories, directoryRead, loadDirectories, wantsDirectories]);
  const projectLabels = useMemo(
    () => projectLabelsFromDirectories(directoryRows ?? []),
    [directoryRows],
  );
  const projectLabel = useCallback(
    (repository: string) =>
      projectLabels.get(forgeRuleRepositoryMatchKey(repository) ?? "")?.label
      ?? forgeRuleRepositoryLabel(repository),
    [projectLabels],
  );

  const names = useMemo<ForgeAgentRuleNames>(() => ({
    acpAgent: (registryId) =>
      props.acpAgents.find((agent) => agent.registryId === registryId)?.name
      ?? props.backends?.find((backend) => backend.kind === `acp:${registryId}`)?.label,
    codexModelProvider: (providerId) =>
      props.codexProviders.find((provider) => provider.id === providerId)?.name,
  }), [props.acpAgents, props.backends, props.codexProviders]);

  const agentChoices = useMemo(
    () => buildAgentChoices({
      acpAgents: props.acpAgents,
      backends: props.backends,
      codexProviders: props.codexProviders,
    }),
    [props.acpAgents, props.backends, props.codexProviders],
  );

  const write = async (next: ForgeAgentToolRule[]): Promise<boolean> => {
    setStatus(undefined);
    try {
      const result = await props.onRulesChange(next);
      return result !== false;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const setCell = (
    repository: string,
    agent: ForgeAgentRuleAgent,
    group: ForgeAgentToolRuleGroup,
    value: CellValue,
  ): void => {
    const level = value === INHERIT_VALUE ? undefined : value;
    let next = upsertForgeAgentToolRule(rules, { repository, agent, group, level });
    if (agent.backend === FORGE_AGENT_RULE_ALL_AGENTS && level === undefined) {
      // The All agents row is always drawn, so an empty one is not kept.
      next = next.filter((rule) =>
        rule.agent.backend !== FORGE_AGENT_RULE_ALL_AGENTS
        || !sameRepository(rule.repository, repository)
        || Object.keys(rule.access).length > 0);
    }
    setAdded((current) => (current.some((entry) => sameRepository(entry, repository)) ? current : [...current, repository]));
    void write(next);
  };

  const removeAgent = (repository: string, agent: ForgeAgentRuleAgent): void => {
    void write(removeForgeAgentToolRule(rules, repository, agent));
  };

  const removeProject = async (repository: string): Promise<boolean> => {
    const next = rules.filter((rule) => !sameRepository(rule.repository, repository));
    if (!(await write(next))) return false;
    setAdded((current) => current.filter((entry) => !sameRepository(entry, repository)));
    // The project's controls are gone; its opener is the next stop.
    focusWhenReady(() => addProjectRef.current);
    return true;
  };

  const addAgent = async (repository: string, agent: ForgeAgentRuleAgent): Promise<boolean> => {
    return write(upsertForgeAgentToolRule(rules, {
      repository,
      agent,
      group: FORGE_AGENT_TOOL_RULE_GROUPS[0],
      level: undefined,
    }));
  };

  const isExpanded = (repository: string): boolean =>
    [...expanded].some((entry) => sameRepository(entry, repository));

  const toggleProject = (repository: string): void => {
    setExpanded((current) => {
      const open = [...current].filter((entry) => !sameRepository(entry, repository));
      return new Set(open.length === current.size ? [...open, repository] : open);
    });
  };

  const closeAddProject = (): void => {
    setAddingProject(false);
    focusWhenReady(() => addProjectRef.current);
  };

  const openProject = (repository: string): void => {
    const existing = repositories.find((entry) => sameRepository(entry, repository)) ?? repository;
    setAdded((current) => (current.some((entry) => sameRepository(entry, repository)) ? current : [...current, repository]));
    setExpanded((current) => new Set([...current, existing]));
    closeAddProject();
  };

  const knownProjects = [...projectLabels.values()]
    .filter(({ repository }) => !repositories.some((entry) => sameRepository(entry, repository)))
    .sort((left, right) => left.label.localeCompare(right.label));

  return (
    <div className="forge-rules">
      <div className="forge-rules__head">
        <div className="forge-rules__head-copy">
          <h3 className="forge-rules__title">Project rules</h3>
          <p className="forge-rules__sub">
            Change the defaults above for one repository and agent. Every checkout and worktree of the repository uses its rules.
          </p>
        </div>
        <button
          ref={addProjectRef}
          aria-expanded={addingProject}
          className="button button--secondary forge-rules__add"
          disabled={disabled}
          type="button"
          onClick={() => setAddingProject((current) => !current)}
        >
          + Add project
        </button>
      </div>
      {!props.policy.enabled ? (
        <p className="forge-rules__note">
          Forge tools are off for every thread. Project rules apply when Offer forge tools to threads is on.
        </p>
      ) : null}
      {addingProject ? (
        <AddProjectForm
          knownProjects={knownProjects}
          loading={directoryRead === "loading"}
          onAdd={openProject}
          onCancel={closeAddProject}
        />
      ) : null}
      {repositories.length === 0 && !addingProject ? (
        <p className="forge-rules__empty">No project rules. Every project uses the defaults above.</p>
      ) : null}
      {repositories.map((repository) => (
        <ProjectRules
          key={repository}
          agentChoices={agentChoices}
          disabled={disabled}
          expanded={isExpanded(repository)}
          label={projectLabel(repository)}
          names={names}
          policy={props.policy}
          repository={repository}
          rules={rules.filter((rule) => sameRepository(rule.repository, repository))}
          unreadable={unreadable.some((entry) => sameRepository(entry, repository))}
          onAddAgent={(agent) => addAgent(repository, agent)}
          onRemoveAgent={(agent) => removeAgent(repository, agent)}
          onRemoveProject={() => removeProject(repository)}
          onSetCell={(agent, group, value) => setCell(repository, agent, group, value)}
          onToggle={() => toggleProject(repository)}
        />
      ))}
      {status ? (
        <p className="settings-error forge-rules__status" role="alert">{status}</p>
      ) : null}
    </div>
  );
}

function AddProjectForm(props: {
  knownProjects: Array<{ repository: string; label: string }>;
  loading: boolean;
  onAdd: (repository: string) => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | undefined>();
  const errorId = useId();
  const projectSelectRef = useRef<HTMLButtonElement>(null);
  const repositoryInputRef = useRef<HTMLInputElement>(null);
  // The form replaces nothing, so focus moves into it as it opens.
  useEffect(() => {
    (projectSelectRef.current ?? repositoryInputRef.current)?.focus();
  }, []);
  const submit = (): void => {
    if (typed.trim()) {
      const repository = normalizeForgeRuleRepository(typed);
      if (!repository) {
        setError("Enter the repository as host/owner/repo, such as github.com/pwrdrvr/PwrAgent.");
        return;
      }
      props.onAdd(repository);
      return;
    }
    if (choice) props.onAdd(choice);
  };
  return (
    <div aria-label="Add a project" className="forge-rules__picker" role="group">
      {props.knownProjects.length > 0 ? (
        <div className="forge-rules__picker-field">
          <span aria-hidden="true" className="forge-rules__picker-label">Project</span>
          <Select
            ref={projectSelectRef}
            aria-label="Project"
            className="settings-select settings-select--chip"
            placeholder="Choose a project"
            value={choice}
            options={props.knownProjects.map((project) => ({
              value: project.repository,
              label: project.label,
              description: project.repository,
            }))}
            onChange={(value) => {
              setChoice(value);
              setTyped("");
              setError(undefined);
            }}
          />
        </div>
      ) : props.loading ? (
        <p className="forge-rules__sub">Reading your projects…</p>
      ) : null}
      <label className="forge-rules__picker-field">
        <span className="forge-rules__picker-label">
          {props.knownProjects.length > 0 ? "Or enter a repository" : "Repository"}
        </span>
        <input
          ref={repositoryInputRef}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          className="settings-input settings-input--inline"
          placeholder="github.com/owner/repo"
          spellCheck={false}
          type="text"
          value={typed}
          onChange={(event) => {
            setTyped(event.currentTarget.value);
            setError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
      </label>
      {error ? <p className="settings-error forge-rules__status" id={errorId}>{error}</p> : null}
      <div className="settings-inline-actions">
        <button
          className="button button--primary"
          disabled={!choice && !typed.trim()}
          type="button"
          onClick={submit}
        >
          Add project
        </button>
        <button className="button button--ghost" type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ProjectRules(props: {
  agentChoices: readonly AgentChoice[];
  disabled: boolean;
  expanded: boolean;
  label: string;
  names: ForgeAgentRuleNames;
  policy: ForgeAgentToolPolicy;
  repository: string;
  /** This repository's rules, in config order. */
  rules: readonly ForgeAgentToolRule[];
  /** config.toml holds an entry for this repository that cannot be read. */
  unreadable: boolean;
  onAddAgent: (agent: ForgeAgentRuleAgent) => Promise<boolean>;
  onRemoveAgent: (agent: ForgeAgentRuleAgent) => void;
  onRemoveProject: () => Promise<boolean>;
  onSetCell: (agent: ForgeAgentRuleAgent, group: ForgeAgentToolRuleGroup, value: CellValue) => void;
  onToggle: () => void;
}) {
  const bodyId = useId();
  const offNoteId = useId();
  const [addingAgent, setAddingAgent] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const addAgentRef = useRef<HTMLButtonElement>(null);
  const removeProjectRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const focusWhenReady = usePendingFocus();
  // Without the button (the form is open), the project's header is next.
  const focusAddAgent = (): void => focusWhenReady(() => addAgentRef.current ?? toggleRef.current);
  const closeAddAgent = (): void => {
    setAddingAgent(false);
    focusAddAgent();
  };
  const confirmRemove = (confirming: boolean): void => {
    setConfirmingRemove(confirming);
    focusWhenReady(() => (confirming ? keepRef.current : removeProjectRef.current));
  };
  const allAgentsRule = props.rules.find((rule) => rule.agent.backend === FORGE_AGENT_RULE_ALL_AGENTS);
  const agentRules = props.rules.filter((rule) => rule.agent.backend !== FORGE_AGENT_RULE_ALL_AGENTS);
  const rows: Array<{ agent: ForgeAgentRuleAgent; rule?: ForgeAgentToolRule }> = [
    { agent: allAgentsRule?.agent ?? ALL_AGENTS, rule: allAgentsRule },
    ...agentRules.map((rule) => ({ agent: rule.agent, rule })),
  ];
  const offGroups = FORGE_AGENT_TOOL_RULE_GROUPS.filter((group) => props.policy.access[group] === "off");
  const riskyAgents = rows
    .filter((row) => row.rule?.access.approve_merge === "allow")
    .map((row) => forgeAgentRuleAgentLabel(row.agent, props.names));
  const count = agentRules.length;
  const repositoryLabel = forgeRuleRepositoryLabel(props.repository);

  return (
    <div className="forge-rules__project" data-repository={props.repository}>
      <button
        ref={toggleRef}
        aria-controls={bodyId}
        aria-expanded={props.expanded}
        className="forge-rules__project-toggle"
        type="button"
        onClick={props.onToggle}
      >
        <span aria-hidden="true" className={`forge-rules__caret${props.expanded ? " is-open" : ""}`} />
        <span className="forge-rules__project-name">{props.label}</span>
        <span className="forge-rules__project-path">{props.repository}</span>
        <span className="forge-rules__project-count">
          {count === 0 ? "All agents" : `${count} agent${count === 1 ? "" : "s"}`}
        </span>
      </button>
      {props.expanded ? (
        <div className="forge-rules__project-body" id={bodyId}>
          <div className="forge-rules__table-wrap">
            <table aria-label={`Rules for ${props.label}`} className="forge-rules__table">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  {FORGE_AGENT_TOOL_RULE_GROUPS.map((group) => (
                    <th
                      key={group}
                      className={offGroups.includes(group) ? "is-locked" : undefined}
                      scope="col"
                    >
                      {RULE_GROUP_COLUMN_LABELS[group]}
                    </th>
                  ))}
                  <th scope="col">
                    <span className="forge-rules__sr">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <AgentRow
                    key={forgeAgentRuleAgentKey(row.agent)}
                    agent={row.agent}
                    disabled={props.disabled}
                    names={props.names}
                    offNoteId={offNoteId}
                    policy={props.policy}
                    repository={props.repository}
                    rule={row.rule}
                    onRemove={() => {
                      props.onRemoveAgent(row.agent);
                      focusAddAgent();
                    }}
                    onSetCell={(group, value) => props.onSetCell(row.agent, group, value)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {props.unreadable ? (
            <p className="settings-warning forge-rules__warning" role="note">
              config.toml has a rule for {repositoryLabel} that PwrAgent cannot read, so every agent asks before
              writing here, whatever these rows say. Fix or remove that rule in config.toml.
            </p>
          ) : null}
          {offGroups.length > 0 ? (
            <p className="forge-rules__note" id={offNoteId}>
              {joinLabels(offGroups.map((group) => RULE_GROUP_COLUMN_LABELS[group]))}
              {offGroups.length === 1 ? " is" : " are"} Off in the defaults above, so no project rule can turn{" "}
              {offGroups.length === 1 ? "it" : "them"} on. Change the default first.
            </p>
          ) : null}
          {riskyAgents.length > 0 ? (
            <p className="settings-warning forge-rules__warning" role="note">
              Approve and merge is set to Allow for {joinLabels(riskyAgents)}.{" "}
              {riskyAgents.length === 1 ? "That agent" : "Those agents"} can approve and merge pull requests in{" "}
              {repositoryLabel} without asking, and a merge cannot be undone.
            </p>
          ) : null}
          {addingAgent ? (
            <AddAgentForm
              choices={props.agentChoices}
              existing={rows.map((row) => row.agent)}
              names={props.names}
              onAdd={async (agent) => {
                if (await props.onAddAgent(agent)) closeAddAgent();
              }}
              onCancel={closeAddAgent}
            />
          ) : null}
          <div className="forge-rules__foot">
            {addingAgent ? null : (
              <button
                ref={addAgentRef}
                className="button button--secondary forge-rules__add"
                disabled={props.disabled}
                type="button"
                onClick={() => setAddingAgent(true)}
              >
                + Add agent
              </button>
            )}
            <span className="forge-rules__hint">
              The most specific row that sets a cell wins: a model, then its agent, then All agents, then the defaults above.
            </span>
            {props.rules.length > 0 ? (
              confirmingRemove ? (
                <span className="settings-inline-actions forge-rules__remove-project">
                  <span>Remove every rule for {repositoryLabel}?</span>
                  <button
                    className="button button--primary"
                    disabled={props.disabled}
                    type="button"
                    onClick={() => {
                      setConfirmingRemove(false);
                      void props.onRemoveProject().then((removed) => {
                        // Still here: the write failed, so offer it again.
                        if (!removed) focusWhenReady(() => removeProjectRef.current);
                      });
                    }}
                  >
                    Remove
                  </button>
                  <button
                    ref={keepRef}
                    className="button button--ghost"
                    type="button"
                    onClick={() => confirmRemove(false)}
                  >
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  ref={removeProjectRef}
                  className="button button--ghost forge-rules__remove-project"
                  disabled={props.disabled}
                  type="button"
                  onClick={() => confirmRemove(true)}
                >
                  Remove project
                </button>
              )
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AgentRow(props: {
  agent: ForgeAgentRuleAgent;
  disabled: boolean;
  names: ForgeAgentRuleNames;
  offNoteId: string;
  policy: ForgeAgentToolPolicy;
  repository: string;
  rule?: ForgeAgentToolRule;
  onRemove: () => void;
  onSetCell: (group: ForgeAgentToolRuleGroup, value: CellValue) => void;
}) {
  const allAgents = props.agent.backend === FORGE_AGENT_RULE_ALL_AGENTS;
  const name = forgeAgentRuleAgentLabel({ ...props.agent, model: undefined }, props.names);
  const fullLabel = forgeAgentRuleAgentLabel(props.agent, props.names);
  return (
    <tr className={allAgents ? "is-base" : undefined}>
      <th className="forge-rules__agent" scope="row">
        <span className="forge-rules__agent-name">{name}</span>
        {allAgents ? null : (
          <span className="forge-rules__agent-model">{props.agent.model ?? "any model"}</span>
        )}
      </th>
      {FORGE_AGENT_TOOL_RULE_GROUPS.map((group) => (
        <td key={group}>
          <RuleCell
            agentLabel={fullLabel}
            disabled={props.disabled}
            group={group}
            inherited={resolveForgeAgentToolInheritedAccess(
              props.policy,
              group,
              props.repository,
              props.agent,
            )}
            locked={props.policy.access[group] === "off"}
            names={props.names}
            offNoteId={props.offNoteId}
            value={props.rule?.access[group]}
            onChange={(value) => props.onSetCell(group, value)}
          />
        </td>
      ))}
      <td className="forge-rules__remove-cell">
        {allAgents ? null : (
          <button
            aria-label={`Remove the ${fullLabel} row`}
            className="forge-rules__remove"
            disabled={props.disabled}
            type="button"
            onClick={props.onRemove}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </td>
    </tr>
  );
}

function RuleCell(props: {
  agentLabel: string;
  disabled: boolean;
  group: ForgeAgentToolRuleGroup;
  inherited: ForgeAgentToolAccessResolution;
  /** The group is Off in the defaults, which no rule can override. */
  locked: boolean;
  names: ForgeAgentRuleNames;
  offNoteId: string;
  value: ForgeAgentToolAccess | undefined;
  onChange: (value: CellValue) => void;
}) {
  const label = `${RULE_GROUP_COLUMN_LABELS[props.group]} for ${props.agentLabel}`;
  if (props.locked) {
    // Not a disabled control: a disabled button takes no focus, so its reason
    // would be out of reach from the keyboard.
    return (
      <button
        aria-describedby={props.offNoteId}
        aria-disabled="true"
        aria-label={`${label}: Off in the defaults`}
        className="forge-rules__cell is-locked tooltip-target"
        data-tooltip="Off in the defaults above. A project rule cannot turn it on."
        type="button"
      >
        Off
      </button>
    );
  }
  const options: SelectOption<CellValue>[] = [
    {
      value: INHERIT_VALUE,
      label: `Inherit (${FORGE_TOOL_ACCESS_LABELS[props.inherited.level]})`,
      description: inheritDescription(props.inherited, props.names),
    },
    ...forgeAgentToolAccessLevels(props.group).map((level) => ({
      value: level,
      label: FORGE_TOOL_ACCESS_LABELS[level],
      description: forgeToolAccessDescription(props.group, level),
    })),
  ];
  const risky = props.group === "approve_merge" && props.value === "allow";
  const className = [
    "forge-rules__cell",
    props.value === undefined ? "is-inherited" : `is-set is-${props.value}`,
    risky ? "is-risk" : undefined,
  ].filter(Boolean).join(" ");
  return (
    <Select
      aria-label={label}
      className={className}
      disabled={props.disabled}
      options={options}
      value={props.value ?? INHERIT_VALUE}
      onChange={props.onChange}
    />
  );
}

function AddAgentForm(props: {
  choices: readonly AgentChoice[];
  existing: readonly ForgeAgentRuleAgent[];
  names: ForgeAgentRuleNames;
  onAdd: (agent: ForgeAgentRuleAgent) => Promise<void>;
  onCancel: () => void;
}) {
  const [choiceKey, setChoiceKey] = useState("");
  const [modelChoice, setModelChoice] = useState("");
  const [typedModel, setTypedModel] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);
  const agentSelectRef = useRef<HTMLButtonElement>(null);
  // The form replaces "+ Add agent", so focus moves into it as it opens.
  useEffect(() => {
    agentSelectRef.current?.focus();
  }, []);
  const choice = props.choices.find((entry) => entry.key === choiceKey);
  const knownModels = choice?.models ?? [];
  const typing = knownModels.length === 0 || modelChoice === OTHER_MODEL_VALUE;
  const model = typing ? typedModel.trim() : modelChoice;

  const submit = async (): Promise<void> => {
    if (!choice) return;
    const result = validateForgeAgentRuleAgent({
      ...choice.agent,
      model: model || undefined,
    });
    if (!result.ok) {
      setError(`That agent cannot be added: ${result.reason}.`);
      return;
    }
    if (props.existing.some((agent) => sameForgeAgentRuleAgent(agent, result.agent))) {
      setError(`${forgeAgentRuleAgentLabel(result.agent, props.names)} already has a row in this project.`);
      return;
    }
    setAdding(true);
    try {
      await props.onAdd(result.agent);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div aria-label="Add an agent" className="forge-rules__picker" role="group">
      <div className="forge-rules__picker-field">
        <span aria-hidden="true" className="forge-rules__picker-label">Agent</span>
        <Select
          ref={agentSelectRef}
          aria-label="Agent"
          className="settings-select settings-select--chip"
          placeholder="Choose an agent"
          value={choiceKey}
          options={props.choices.map((entry) => ({
            value: entry.key,
            label: entry.label,
            description: entry.description,
          }))}
          onChange={(value) => {
            setChoiceKey(value);
            setModelChoice("");
            setTypedModel("");
            setError(undefined);
          }}
        />
      </div>
      {choice ? (
        <>
          {knownModels.length > 0 ? (
            <div className="forge-rules__picker-field">
              <span aria-hidden="true" className="forge-rules__picker-label">Model</span>
              <Select
                aria-label="Model"
                className="settings-select settings-select--chip"
                listboxClassName="forge-rules__model-list"
                value={modelChoice}
                options={[
                  { value: "", label: "Any model", description: `Every ${choice.label} thread.` },
                  ...knownModels.map((id) => ({ value: id, label: id })),
                  { value: OTHER_MODEL_VALUE, label: "Another model…" },
                ]}
                onChange={(value) => {
                  setModelChoice(value);
                  setError(undefined);
                }}
              />
            </div>
          ) : null}
          {typing ? (
            <label className="forge-rules__picker-field">
              <span className="forge-rules__picker-label">
                {knownModels.length > 0 ? "Model id" : "Model (optional)"}
              </span>
              <input
                className="settings-input settings-input--inline"
                placeholder={knownModels.length > 0 ? undefined : "Any model"}
                spellCheck={false}
                type="text"
                value={typedModel}
                onChange={(event) => {
                  setTypedModel(event.currentTarget.value);
                  setError(undefined);
                }}
              />
            </label>
          ) : null}
          <p className="forge-rules__sub">
            {model
              ? `Applies only while a ${choice.label} thread runs ${model}.`
              : choice.description}
          </p>
        </>
      ) : null}
      {error ? <p className="settings-error forge-rules__status" role="alert">{error}</p> : null}
      <div className="settings-inline-actions">
        <button
          className="button button--primary"
          disabled={!choice || adding || (modelChoice === OTHER_MODEL_VALUE && !typedModel.trim())}
          type="button"
          onClick={() => void submit()}
        >
          Add agent
        </button>
        <button className="button button--ghost" type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
